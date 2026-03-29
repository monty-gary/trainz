import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';

const DEFAULT_PASSWORD = 'allaboard';
const DEFAULT_GRID_SIZE = 9;
const DEFAULT_SEGMENT_DURATION_MS = 2200;
const DEFAULT_SCHEDULE_LEAD_MS = 1200;
const TRAIN_TICK_INTERVAL_MS = 100;
const SIGNAL_STOP = 'red';
const SIGNAL_GO = 'green';
const OPEN_STATE = 1;
const FRUIT_SLOT_COUNT = 5;
const FRUIT_STARTING_COUNT = 3;
const FRUIT_TYPES = ['apple', 'banana', 'pear', 'grapes', 'peach'];
const CARGO_RULE = 'Cargo transfers are only allowed while the train is stopped at your claimed tile.';

const port = Number(process.env.PORT || 3000);
const gridSize = normalizeGridSize(Number(process.env.GRID_SIZE || DEFAULT_GRID_SIZE));
const trainSegmentDurationMs = Number(process.env.TRAIN_SEGMENT_MS || DEFAULT_SEGMENT_DURATION_MS);
const scheduleLeadMs = Number(process.env.TRAIN_SCHEDULE_LEAD_MS || DEFAULT_SCHEDULE_LEAD_MS);
const universalPassword = process.env.TRAINZ_PASSWORD || DEFAULT_PASSWORD;
const corsOrigin = process.env.CORS_ORIGIN || '*';

const station = {
  x: Math.floor(gridSize / 2),
  y: Math.floor(gridSize / 2)
};

const clients = new Map();
const authTokens = new Map();
const socketByClientId = new Map();

let topologyRevision = 0;
let scheduleRevision = 0;
let railTiles = new Map();
let routeNodes = [station, station];
let claimSeedCounter = 0;
let wagonSlots = createEmptySlots();
let trainMotion = {
  segmentIndex: 0,
  segmentStartTimeMs: Date.now() + scheduleLeadMs,
  pausedAtPoint: null
};

const server = http.createServer(async (req, res) => {
  if (applyCors(req, res)) {
    return;
  }

  const method = req.method || 'GET';
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (method === 'GET' && url.pathname === '/') {
    writeJson(res, 200, {
      service: 'trainz-backend',
      status: 'running',
      realtime: true
    });
    return;
  }

  if (method === 'GET' && url.pathname === '/health') {
    writeJson(res, 200, {
      ok: true,
      gridSize,
      topologyRevision
    });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/auth') {
    const body = await parseJsonBody(req);
    if (!body || typeof body.password !== 'string' || typeof body.clientId !== 'string') {
      writeJson(res, 400, { ok: false, error: 'password and clientId are required' });
      return;
    }

    if (body.password !== universalPassword) {
      writeJson(res, 401, { ok: false, error: 'invalid password' });
      return;
    }

    const clientId = sanitizeClientId(body.clientId);
    if (!clientId) {
      writeJson(res, 400, { ok: false, error: 'clientId is required' });
      return;
    }

    const session = getOrCreateClient(clientId);
    const token = randomUUID();

    authTokens.set(token, {
      token,
      clientId,
      createdAtMs: Date.now()
    });

    writeJson(res, 200, {
      ok: true,
      token,
      session: serializeClient(session),
      config: getPublicConfig()
    });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/session') {
    const token = url.searchParams.get('token') || '';
    const clientId = sanitizeClientId(url.searchParams.get('clientId') || '');
    if (!clientId) {
      writeJson(res, 400, { ok: false, error: 'clientId is required' });
      return;
    }

    if (!isTokenValidForClient(token, clientId)) {
      writeJson(res, 401, { ok: false, error: 'invalid session' });
      return;
    }

    const session = getOrCreateClient(clientId);
    writeJson(res, 200, {
      ok: true,
      session: serializeClient(session),
      config: getPublicConfig()
    });
    return;
  }

  writeJson(res, 404, { error: 'Not Found' });
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }

  const token = url.searchParams.get('token') || '';
  const requestedClientId = sanitizeClientId(url.searchParams.get('clientId') || '');

  if (!isTokenValidForClient(token, requestedClientId)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, requestedClientId);
  });
});

wss.on('connection', (ws, clientId) => {
  const session = getOrCreateClient(clientId);

  session.connected = true;
  session.lastSeenAtMs = Date.now();

  const existingSocket = socketByClientId.get(clientId);
  if (existingSocket && existingSocket !== ws && existingSocket.readyState === OPEN_STATE) {
    existingSocket.close(4009, 'superseded by newer connection');
  }

  socketByClientId.set(clientId, ws);

  sendState(ws, clientId);
  broadcastState();

  ws.on('message', (raw) => {
    const message = parseWsMessage(raw);
    if (!message || typeof message.type !== 'string') {
      sendError(ws, 'invalid message format');
      return;
    }

    if (message.type === 'set_username') {
      if (typeof message.username !== 'string') {
        sendError(ws, 'username must be a string');
        return;
      }

      const normalized = normalizeUsername(message.username);
      if (!normalized) {
        sendError(ws, 'username must be 2-24 characters');
        return;
      }

      session.username = normalized;
      session.lastSeenAtMs = Date.now();
      broadcastState();
      return;
    }

    if (message.type === 'claim_cell') {
      const x = Number(message.x);
      const y = Number(message.y);

      if (!Number.isInteger(x) || !Number.isInteger(y)) {
        sendError(ws, 'x and y must be integers');
        return;
      }

      if (!session.username) {
        sendError(ws, 'set username before claiming a cell');
        return;
      }

      if (session.claimedCell) {
        sendError(ws, 'you already claimed a cell');
        return;
      }

      const validation = canClaimCell({ x, y });
      if (!validation.ok) {
        sendError(ws, validation.error);
        return;
      }

      session.claimedCell = { x, y };
      session.signalState = SIGNAL_GO;
      session.tileSlots = createRandomizedTileSlots(session.clientId, { x, y });
      session.lastSeenAtMs = Date.now();
      recomputeTopologyAndSchedule();
      broadcastState();
      return;
    }

    if (message.type === 'release_cell') {
      if (!session.claimedCell) {
        return;
      }

      session.claimedCell = null;
      session.signalState = null;
      session.tileSlots = createEmptySlots();
      session.lastSeenAtMs = Date.now();
      recomputeTopologyAndSchedule();
      broadcastState();
      return;
    }

    if (message.type === 'toggle_signal') {
      if (!session.claimedCell) {
        sendError(ws, 'claim a tile before toggling signal');
        return;
      }

      session.signalState = session.signalState === SIGNAL_STOP ? SIGNAL_GO : SIGNAL_STOP;
      session.lastSeenAtMs = Date.now();
      advanceTrain(Date.now());

      broadcastState();
      return;
    }

    if (message.type === 'move_fruit') {
      const moveValidation = validateFruitMoveRequest(session, message);
      if (!moveValidation.ok) {
        sendError(ws, moveValidation.error);
        return;
      }

      const result = applyFruitMove(session, moveValidation.request);
      if (!result.ok) {
        sendError(ws, result.error);
        return;
      }

      session.lastSeenAtMs = Date.now();
      broadcastState();
      return;
    }

    if (message.type === 'ping') {
      sendJson(ws, { type: 'pong', serverNowMs: Date.now() });
      return;
    }

    sendError(ws, `unsupported message type: ${message.type}`);
  });

  ws.on('close', () => {
    session.connected = false;
    session.lastSeenAtMs = Date.now();

    if (socketByClientId.get(clientId) === ws) {
      socketByClientId.delete(clientId);
    }

    broadcastState();
  });
});

setInterval(() => {
  broadcastState();
}, 5000);

setInterval(() => {
  if (advanceTrain(Date.now())) {
    broadcastState();
  }
}, TRAIN_TICK_INTERVAL_MS);

recomputeTopologyAndSchedule();

server.listen(port, '0.0.0.0', () => {
  console.log(`trainz-backend listening on port ${port}`);
});

function normalizeGridSize(value) {
  if (!Number.isInteger(value) || value < 5) {
    return DEFAULT_GRID_SIZE;
  }

  if (value % 2 === 0) {
    return value + 1;
  }

  return value;
}

function sanitizeClientId(value) {
  return String(value || '').trim().slice(0, 100);
}

function normalizeUsername(value) {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length < 2 || collapsed.length > 24) {
    return '';
  }

  return collapsed;
}

function getOrCreateClient(clientId) {
  let existing = clients.get(clientId);
  if (existing) {
    return existing;
  }

  existing = {
    clientId,
    username: null,
    claimedCell: null,
    signalState: null,
    tileSlots: createEmptySlots(),
    connected: false,
    createdAtMs: Date.now(),
    lastSeenAtMs: Date.now()
  };

  clients.set(clientId, existing);
  return existing;
}

function serializeClient(client) {
  return {
    clientId: client.clientId,
    username: client.username,
    claimedCell: client.claimedCell,
    signalState: client.signalState,
    tileSlots: cloneSlots(client.tileSlots),
    connected: client.connected,
    lastSeenAtMs: client.lastSeenAtMs
  };
}

function getPublicConfig() {
  return {
    gridSize,
    station,
    trainSegmentDurationMs
  };
}

function isTokenValidForClient(token, clientId) {
  if (!token || !clientId) {
    return false;
  }

  const record = authTokens.get(token);
  return Boolean(record && record.clientId === clientId);
}

function applyCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }

  return false;
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function parseJsonBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return null;
  }

  const raw = Buffer.concat(chunks).toString('utf8');

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseWsMessage(raw) {
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

function createEmptySlots() {
  return Array(FRUIT_SLOT_COUNT).fill(null);
}

function cloneSlots(slots) {
  const cloned = createEmptySlots();

  if (!Array.isArray(slots)) {
    return cloned;
  }

  for (let index = 0; index < FRUIT_SLOT_COUNT; index += 1) {
    const candidate = slots[index];
    cloned[index] = FRUIT_TYPES.includes(candidate) ? candidate : null;
  }

  return cloned;
}

function createRandomizedTileSlots(clientId, cell) {
  claimSeedCounter += 1;
  const seed = hashString(`${clientId}:${cell.x},${cell.y}:${claimSeedCounter}`);
  const random = createDeterministicRandom(seed);
  const slots = createEmptySlots();
  const slotIndexes = [...slots.keys()];

  for (let count = 0; count < FRUIT_STARTING_COUNT && slotIndexes.length > 0; count += 1) {
    const randomSlotListIndex = randomIndex(slotIndexes.length, random);
    const slot = slotIndexes.splice(randomSlotListIndex, 1)[0];
    slots[slot] = FRUIT_TYPES[randomIndex(FRUIT_TYPES.length, random)];
  }

  return slots;
}

function randomIndex(length, random = Math.random) {
  if (length <= 1) {
    return 0;
  }

  return Math.floor(random() * length);
}

function createDeterministicRandom(seed) {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(value) {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function validateFruitMoveRequest(session, message) {
  if (!session.claimedCell) {
    return { ok: false, error: 'claim a tile before moving fruit' };
  }

  const cargoAccess = getCargoAccess(session);
  if (!cargoAccess.allowed) {
    return { ok: false, error: `${cargoAccess.reason} ${CARGO_RULE}` };
  }

  if (!message || typeof message !== 'object') {
    return { ok: false, error: 'invalid move request' };
  }

  const from = parseFruitMoveEndpoint(message.from ?? message.source, false);
  const to = parseFruitMoveEndpoint(message.to ?? message.target, true);

  if (!from) {
    return { ok: false, error: 'invalid source slot' };
  }

  if (!to) {
    return { ok: false, error: 'invalid destination slot' };
  }

  if (to.zone !== 'discard' && from.zone === to.zone && from.slot === to.slot) {
    return { ok: false, error: 'source and destination are the same slot' };
  }

  return {
    ok: true,
    request: {
      from,
      to
    }
  };
}

function parseFruitMoveEndpoint(value, allowDiscard) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const zone = value.zone ?? value.kind;
  if (allowDiscard && (zone === 'discard' || zone === 'void')) {
    return {
      zone: 'discard'
    };
  }

  if (zone !== 'tile' && zone !== 'wagon') {
    return null;
  }

  if (!Number.isInteger(value.slot) || value.slot < 0 || value.slot >= FRUIT_SLOT_COUNT) {
    return null;
  }

  return {
    zone,
    slot: value.slot
  };
}

function applyFruitMove(session, request) {
  const sourceSlots = getSlotsByZone(session, request.from.zone);
  if (!sourceSlots) {
    return { ok: false, error: 'invalid source zone' };
  }

  const fruit = sourceSlots[request.from.slot];
  if (!fruit) {
    return { ok: false, error: 'source slot is empty' };
  }

  if (request.to.zone === 'discard') {
    sourceSlots[request.from.slot] = null;
    return { ok: true };
  }

  const targetSlots = getSlotsByZone(session, request.to.zone);
  if (!targetSlots) {
    return { ok: false, error: 'invalid destination zone' };
  }

  const targetFruit = targetSlots[request.to.slot];
  sourceSlots[request.from.slot] = targetFruit;
  targetSlots[request.to.slot] = fruit;
  return { ok: true };
}

function getSlotsByZone(session, zone) {
  if (zone === 'tile') {
    return session.tileSlots;
  }

  if (zone === 'wagon') {
    return wagonSlots;
  }

  return null;
}

function getCargoAccess(session) {
  if (!session.claimedCell) {
    return {
      allowed: false,
      reason: 'Claim a tile to move cargo.'
    };
  }

  if (!trainMotion.pausedAtPoint) {
    return {
      allowed: false,
      reason: 'Train is moving. Stop it at your tile first.'
    };
  }

  if (!pointsEqual(trainMotion.pausedAtPoint, session.claimedCell)) {
    return {
      allowed: false,
      reason: 'Train is stopped at a different tile.'
    };
  }

  if (!Array.isArray(session.tileSlots)) {
    return {
      allowed: false,
      reason: 'Your tile has no fruit slots available.'
    };
  }

  return {
    allowed: true,
    reason: 'Cargo transfer available.'
  };
}

function pointsEqual(a, b) {
  return Boolean(a && b && a.x === b.x && a.y === b.y);
}

function sendJson(ws, payload) {
  if (ws.readyState !== OPEN_STATE) {
    return;
  }

  ws.send(JSON.stringify(payload));
}

function sendError(ws, message) {
  sendJson(ws, { type: 'error', message });
}

function sendState(ws, clientId) {
  sendJson(ws, {
    type: 'state',
    snapshot: buildSnapshot(clientId)
  });
}

function broadcastState() {
  for (const [clientId, ws] of socketByClientId.entries()) {
    if (ws.readyState !== OPEN_STATE) {
      continue;
    }

    sendState(ws, clientId);
  }
}

function canClaimCell(point) {
  if (!isWithinGrid(point)) {
    return { ok: false, error: 'cell is out of bounds' };
  }

  if (point.x === station.x && point.y === station.y) {
    return { ok: false, error: 'station cell cannot be claimed' };
  }

  const occupied = getOccupiedUserCells();
  for (const cell of occupied) {
    if (cell.x === point.x && cell.y === point.y) {
      return { ok: false, error: 'cell is already occupied' };
    }
  }

  const claimable = computeClaimableCells();
  const key = pointKey(point);

  if (!claimable.has(key)) {
    return { ok: false, error: 'cell is not currently claimable' };
  }

  return { ok: true };
}

function computeClaimableCells() {
  const occupiedSet = new Set();
  occupiedSet.add(pointKey(station));

  for (const cell of getOccupiedUserCells()) {
    occupiedSet.add(pointKey(cell));
  }

  const claimable = new Set();

  for (const key of occupiedSet) {
    const point = keyToPoint(key);

    for (const neighbor of neighbors4(point)) {
      const neighborKey = pointKey(neighbor);
      if (!isWithinGrid(neighbor)) {
        continue;
      }

      if (occupiedSet.has(neighborKey)) {
        continue;
      }

      claimable.add(neighborKey);
    }
  }

  return claimable;
}

function getOccupiedUserCells() {
  const occupied = [];
  for (const client of clients.values()) {
    if (client.claimedCell) {
      occupied.push(client.claimedCell);
    }
  }

  return occupied;
}

function buildSnapshot(clientId) {
  const now = Date.now();
  const cycleStartTimeMs = trainMotion.segmentStartTimeMs - trainMotion.segmentIndex * trainSegmentDurationMs;
  const claimedCells = [];
  const selfClient = getOrCreateClient(clientId);
  const cargoAccess = getCargoAccess(selfClient);

  for (const client of clients.values()) {
    if (client.claimedCell && client.username) {
      claimedCells.push({
        ...client.claimedCell,
        clientId: client.clientId,
        username: client.username,
        connected: client.connected,
        signalState: client.signalState === SIGNAL_STOP ? SIGNAL_STOP : SIGNAL_GO,
        tileSlots: cloneSlots(client.tileSlots)
      });
    }
  }

  claimedCells.sort((a, b) => {
    if (a.y !== b.y) {
      return a.y - b.y;
    }

    if (a.x !== b.x) {
      return a.x - b.x;
    }

    return a.clientId.localeCompare(b.clientId);
  });

  const claimableCells = Array.from(computeClaimableCells()).map(keyToPoint).sort(sortPoints);
  const serializedRails = Array.from(railTiles.entries())
    .map(([key, edgeSet]) => ({
      ...keyToPoint(key),
      edges: Array.from(edgeSet).sort()
    }))
    .sort(sortPoints);

  const clientsList = Array.from(clients.values())
    .map(serializeClient)
    .sort((a, b) => a.clientId.localeCompare(b.clientId));

  return {
    serverNowMs: now,
    gridSize,
    station,
    claimedCells,
    claimableCells,
    railTiles: serializedRails,
    routeNodes,
    topologyRevision,
    schedule: {
      revision: scheduleRevision,
      cycleStartTimeMs,
      segmentDurationMs: trainSegmentDurationMs,
      segmentCount: Math.max(0, routeNodes.length - 1),
      cycleDurationMs: Math.max(trainSegmentDurationMs, (routeNodes.length - 1) * trainSegmentDurationMs)
    },
    train: {
      segmentIndex: trainMotion.segmentIndex,
      segmentStartTimeMs: trainMotion.segmentStartTimeMs,
      segmentDurationMs: trainSegmentDurationMs,
      paused: Boolean(trainMotion.pausedAtPoint),
      pausedAt: trainMotion.pausedAtPoint
    },
    wagonSlots: cloneSlots(wagonSlots),
    cargoRule: CARGO_RULE,
    cargoAccess,
    clients: clientsList,
    self: serializeClient(selfClient)
  };
}

function recomputeTopologyAndSchedule() {
  const occupiedMap = new Map();
  occupiedMap.set(pointKey(station), station);

  for (const cell of getOccupiedUserCells()) {
    occupiedMap.set(pointKey(cell), cell);
  }

  const treeEdges = buildTreeEdges(occupiedMap);
  railTiles = buildRailTiles(treeEdges, occupiedMap);
  routeNodes = buildRouteNodes(treeEdges);

  topologyRevision += 1;
  scheduleRevision += 1;
  resetTrainMotion(Date.now());
}

function resetTrainMotion(nowMs) {
  trainMotion = {
    segmentIndex: 0,
    segmentStartTimeMs: nowMs + scheduleLeadMs,
    pausedAtPoint: null
  };
}

function advanceTrain(nowMs) {
  const segmentCount = getSegmentCount();

  if (segmentCount < 1) {
    if (trainMotion.segmentIndex !== 0 || trainMotion.pausedAtPoint) {
      trainMotion.segmentIndex = 0;
      trainMotion.pausedAtPoint = null;
      return true;
    }

    return false;
  }

  let changed = false;

  if (trainMotion.pausedAtPoint) {
    if (shouldTrainStopAtPoint(trainMotion.pausedAtPoint)) {
      return false;
    }

    trainMotion.pausedAtPoint = null;
    trainMotion.segmentStartTimeMs = nowMs;
    return true;
  }

  if (nowMs < trainMotion.segmentStartTimeMs) {
    return false;
  }

  const maxTransitions = Math.max(8, segmentCount * 4);
  let transitions = 0;

  while (transitions < maxTransitions) {
    const elapsedMs = nowMs - trainMotion.segmentStartTimeMs;
    if (elapsedMs < trainSegmentDurationMs) {
      break;
    }

    const arrivalNodeIndex = trainMotion.segmentIndex + 1;
    const arrivalPoint = routeNodes[arrivalNodeIndex] || routeNodes[0];
    const completedAtMs = trainMotion.segmentStartTimeMs + trainSegmentDurationMs;
    const nextSegmentIndex = (trainMotion.segmentIndex + 1) % segmentCount;

    trainMotion.segmentIndex = nextSegmentIndex;
    trainMotion.segmentStartTimeMs = completedAtMs;
    changed = true;

    if (shouldTrainStopAtPoint(arrivalPoint)) {
      trainMotion.pausedAtPoint = { x: arrivalPoint.x, y: arrivalPoint.y };
      break;
    }

    transitions += 1;
  }

  return changed;
}

function shouldTrainStopAtPoint(point) {
  if (!point || (point.x === station.x && point.y === station.y)) {
    return false;
  }

  const owner = findClaimOwnerByPoint(point);
  if (!owner) {
    return false;
  }

  return owner.signalState === SIGNAL_STOP;
}

function findClaimOwnerByPoint(point) {
  for (const client of clients.values()) {
    if (!client.claimedCell) {
      continue;
    }

    if (client.claimedCell.x === point.x && client.claimedCell.y === point.y) {
      return client;
    }
  }

  return null;
}

function getSegmentCount() {
  return Math.max(0, routeNodes.length - 1);
}

function buildTreeEdges(occupiedMap) {
  const visited = new Set();
  const queue = [station];
  const edges = [];

  visited.add(pointKey(station));

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    const neighbors = neighbors4(current)
      .filter((point) => occupiedMap.has(pointKey(point)))
      .sort(sortPoints);

    for (const neighbor of neighbors) {
      const key = pointKey(neighbor);
      if (visited.has(key)) {
        continue;
      }

      visited.add(key);
      edges.push([current, neighbor]);
      queue.push(neighbor);
    }
  }

  return edges;
}

function buildRailTiles(edges, occupiedMap) {
  const rails = new Map();

  for (const key of occupiedMap.keys()) {
    rails.set(key, new Set());
  }

  for (const [a, b] of edges) {
    const fromKey = pointKey(a);
    const toKey = pointKey(b);
    const direction = getDirection(a, b);
    const opposite = oppositeDirection(direction);

    rails.get(fromKey)?.add(direction);
    rails.get(toKey)?.add(opposite);
  }

  return rails;
}

function buildRouteNodes(edges) {
  const adjacency = new Map();

  const ensure = (point) => {
    const key = pointKey(point);
    if (!adjacency.has(key)) {
      adjacency.set(key, []);
    }

    return adjacency.get(key);
  };

  ensure(station);

  for (const [a, b] of edges) {
    ensure(a)?.push(b);
    ensure(b)?.push(a);
  }

  for (const list of adjacency.values()) {
    list.sort(sortPoints);
  }

  const path = [station];

  const walk = (node, parent) => {
    const neighbors = adjacency.get(pointKey(node)) || [];

    for (const next of neighbors) {
      if (parent && next.x === parent.x && next.y === parent.y) {
        continue;
      }

      path.push(next);
      walk(next, node);
      path.push(node);
    }
  };

  walk(station, null);

  if (path.length === 1) {
    path.push(station);
  }

  return path;
}

function neighbors4(point) {
  return [
    { x: point.x, y: point.y - 1 },
    { x: point.x + 1, y: point.y },
    { x: point.x, y: point.y + 1 },
    { x: point.x - 1, y: point.y }
  ];
}

function pointKey(point) {
  return `${point.x},${point.y}`;
}

function keyToPoint(key) {
  const [x, y] = key.split(',').map(Number);
  return { x, y };
}

function sortPoints(a, b) {
  if (a.y !== b.y) {
    return a.y - b.y;
  }

  return a.x - b.x;
}

function isWithinGrid(point) {
  return point.x >= 0 && point.y >= 0 && point.x < gridSize && point.y < gridSize;
}

function getDirection(from, to) {
  if (to.y < from.y) {
    return 'N';
  }

  if (to.x > from.x) {
    return 'E';
  }

  if (to.y > from.y) {
    return 'S';
  }

  return 'W';
}

function oppositeDirection(direction) {
  switch (direction) {
    case 'N':
      return 'S';
    case 'E':
      return 'W';
    case 'S':
      return 'N';
    default:
      return 'E';
  }
}
