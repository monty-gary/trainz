import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE_URL, WS_URL, authenticate, getSession } from './api';
import {
  computeTileTrainState,
  computeTrainState,
  edgePosition,
  pointKey
} from './train';
import type {
  ClaimedCell,
  ClientMessage,
  ClientState,
  Direction,
  Point,
  RailTile,
  ServerMessage,
  Snapshot
} from './types';

const STORAGE_CLIENT_ID = 'trainz.clientId';
const STORAGE_AUTH_TOKEN = 'trainz.authToken';
const STORAGE_USERNAME = 'trainz.username';

type AuthPhase = 'checking' | 'required' | 'ready';
type ConnectionState = 'offline' | 'connecting' | 'online';
type ViewMode = 'lobby' | 'screen';

function App() {
  const [clientId] = useState<string>(getOrCreateClientId);
  const [authToken, setAuthToken] = useState<string | null>(() => localStorage.getItem(STORAGE_AUTH_TOKEN));
  const [authPhase, setAuthPhase] = useState<AuthPhase>(authToken ? 'checking' : 'required');

  const [passwordInput, setPasswordInput] = useState('');
  const [usernameInput, setUsernameInput] = useState<string>(() => localStorage.getItem(STORAGE_USERNAME) || '');
  const [viewMode, setViewMode] = useState<ViewMode>('lobby');

  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>('offline');
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [tickMs, setTickMs] = useState<number>(Date.now());

  const [isWorking, setIsWorking] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);

  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setTickMs(Date.now());
    }, 120);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    if (!authToken) {
      setAuthPhase('required');
      setSnapshot(null);
      return () => {
        cancelled = true;
      };
    }

    setAuthPhase('checking');

    getSession(authToken, clientId)
      .then((session) => {
        if (cancelled) {
          return;
        }

        setAuthPhase('ready');
        if (session.username) {
          setUsernameInput(session.username);
          localStorage.setItem(STORAGE_USERNAME, session.username);
        }

        if (session.claimedCell) {
          setViewMode('screen');
        }
      })
      .catch(() => {
        if (cancelled) {
          return;
        }

        clearAuth();
        setErrorMessage('Session expired. Enter the password again.');
      });

    return () => {
      cancelled = true;
    };
  }, [authToken, clientId]);

  useEffect(() => {
    if (authPhase !== 'ready' || !authToken) {
      return;
    }

    setConnectionState('connecting');
    const ws = new WebSocket(
      `${WS_URL}/ws?token=${encodeURIComponent(authToken)}&clientId=${encodeURIComponent(clientId)}`
    );

    socketRef.current = ws;

    ws.onopen = () => {
      setConnectionState('online');
    };

    ws.onmessage = (event) => {
      const message = safeParseMessage(event.data);
      if (!message) {
        return;
      }

      if (message.type === 'state') {
        setSnapshot(message.snapshot);
        setClockOffsetMs(message.snapshot.serverNowMs - Date.now());
        setErrorMessage(null);

        if (message.snapshot.self.username) {
          setUsernameInput(message.snapshot.self.username);
          localStorage.setItem(STORAGE_USERNAME, message.snapshot.self.username);
        }

        return;
      }

      if (message.type === 'error') {
        setErrorMessage(message.message);
        return;
      }

      if (message.type === 'pong') {
        setClockOffsetMs(message.serverNowMs - Date.now());
      }
    };

    ws.onerror = () => {
      setConnectionState('offline');
    };

    ws.onclose = () => {
      if (socketRef.current === ws) {
        socketRef.current = null;
      }

      setConnectionState('offline');
    };

    const pingId = window.setInterval(() => {
      sendWsMessage({ type: 'ping' });
    }, 5000);

    return () => {
      window.clearInterval(pingId);

      if (socketRef.current === ws) {
        socketRef.current = null;
      }

      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    };
  }, [authPhase, authToken, clientId]);

  const self = snapshot?.self || null;
  const hasUsername = Boolean(self?.username);
  const hasClaimedCell = Boolean(self?.claimedCell);

  useEffect(() => {
    if (hasClaimedCell) {
      setViewMode('screen');
    }
  }, [hasClaimedCell]);

  const serverNowMs = tickMs + clockOffsetMs;
  const trainState = useMemo(() => computeTrainState(snapshot, serverNowMs), [snapshot, serverNowMs]);

  const claimableSet = useMemo(() => {
    const set = new Set<string>();
    if (!snapshot) {
      return set;
    }

    for (const cell of snapshot.claimableCells) {
      set.add(pointKey(cell));
    }

    return set;
  }, [snapshot]);

  const claimedByKey = useMemo(() => {
    const map = new Map<string, ClaimedCell>();
    if (!snapshot) {
      return map;
    }

    for (const cell of snapshot.claimedCells) {
      map.set(pointKey(cell), cell);
    }

    return map;
  }, [snapshot]);

  const railsByKey = useMemo(() => {
    const map = new Map<string, RailTile>();
    if (!snapshot) {
      return map;
    }

    for (const rail of snapshot.railTiles) {
      map.set(pointKey(rail), rail);
    }

    return map;
  }, [snapshot]);

  const trainMarkerStyle = useMemo(() => {
    if (!snapshot || !trainState) {
      return null;
    }

    return {
      left: `${((trainState.worldX + 0.5) / snapshot.gridSize) * 100}%`,
      top: `${((trainState.worldY + 0.5) / snapshot.gridSize) * 100}%`
    };
  }, [snapshot, trainState]);

  const focusedTileTrain = useMemo(() => {
    if (!self?.claimedCell) {
      return null;
    }

    return computeTileTrainState(self.claimedCell, trainState);
  }, [self?.claimedCell, trainState]);

  async function handlePasswordSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const candidate = passwordInput.trim();
    if (!candidate) {
      setErrorMessage('Enter the shared password.');
      return;
    }

    setIsWorking(true);
    setErrorMessage(null);
    setInfoMessage(null);

    try {
      const response = await authenticate(candidate, clientId);
      setAuthToken(response.token);
      localStorage.setItem(STORAGE_AUTH_TOKEN, response.token);
      setAuthPhase('ready');
      if (response.session.username) {
        setUsernameInput(response.session.username);
        localStorage.setItem(STORAGE_USERNAME, response.session.username);
      }

      if (response.session.claimedCell) {
        setViewMode('screen');
      }

      setPasswordInput('');
      setInfoMessage('Access granted.');
    } catch (error) {
      setErrorMessage(errorToMessage(error));
      clearAuth();
    } finally {
      setIsWorking(false);
    }
  }

  function handleUsernameSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const normalized = usernameInput.replace(/\s+/g, ' ').trim();
    if (normalized.length < 2 || normalized.length > 24) {
      setErrorMessage('Use a username between 2 and 24 characters.');
      return;
    }

    setUsernameInput(normalized);
    localStorage.setItem(STORAGE_USERNAME, normalized);
    setInfoMessage('Username saved.');
    setErrorMessage(null);
    sendWsMessage({ type: 'set_username', username: normalized });
  }

  function handleClaimCell(cell: Point) {
    setErrorMessage(null);
    setInfoMessage(`Requesting tile (${cell.x}, ${cell.y}).`);
    sendWsMessage({ type: 'claim_cell', x: cell.x, y: cell.y });
    setViewMode('screen');
  }

  function handleReleaseCell() {
    setInfoMessage('Released your tile.');
    sendWsMessage({ type: 'release_cell' });
    setViewMode('lobby');
  }

  function sendWsMessage(message: ClientMessage) {
    const socket = socketRef.current;

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setErrorMessage('Realtime connection is not ready yet.');
      return;
    }

    socket.send(JSON.stringify(message));
  }

  function clearAuth() {
    setAuthToken(null);
    setAuthPhase('required');
    setSnapshot(null);
    localStorage.removeItem(STORAGE_AUTH_TOKEN);
  }

  if (authPhase === 'checking') {
    return (
      <main className="app-shell">
        <section className="card gate-card">
          <h1>trainz</h1>
          <p>Checking saved session with backend...</p>
        </section>
      </main>
    );
  }

  if (authPhase === 'required') {
    return (
      <main className="app-shell">
        <section className="card gate-card">
          <h1>trainz installation</h1>
          <p>Enter the shared password to join this railway network.</p>
          <form onSubmit={handlePasswordSubmit} className="form-stack">
            <label htmlFor="password-input">Shared password</label>
            <input
              id="password-input"
              type="password"
              value={passwordInput}
              onChange={(event) => setPasswordInput(event.target.value)}
              autoComplete="current-password"
              required
            />
            <button type="submit" disabled={isWorking}>
              {isWorking ? 'Verifying...' : 'Enter'}
            </button>
          </form>
          <p className="hint">Backend endpoint: {API_BASE_URL}</p>
          {errorMessage ? <p className="status error">{errorMessage}</p> : null}
        </section>
      </main>
    );
  }

  if (!hasUsername) {
    return (
      <main className="app-shell">
        <section className="card gate-card">
          <h1>Choose your screen name</h1>
          <p>Other participants will see this label on the shared map.</p>
          <form onSubmit={handleUsernameSubmit} className="form-stack">
            <label htmlFor="username-input">User name</label>
            <input
              id="username-input"
              value={usernameInput}
              onChange={(event) => setUsernameInput(event.target.value)}
              minLength={2}
              maxLength={24}
              required
            />
            <button type="submit">Continue to lobby</button>
          </form>
          <ConnectionPill state={connectionState} />
          {errorMessage ? <p className="status error">{errorMessage}</p> : null}
          {infoMessage ? <p className="status info">{infoMessage}</p> : null}
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <section className="app-frame">
        <header className="topbar">
          <div>
            <h1>trainz control deck</h1>
            <p>
              Client <code>{clientId.slice(0, 8)}</code> | topology rev {snapshot?.topologyRevision ?? '-'}
            </p>
          </div>
          <div className="topbar-right">
            <ConnectionPill state={connectionState} />
            <button type="button" className="ghost" onClick={clearAuth}>
              Lock
            </button>
          </div>
        </header>

        <section className="toolbar">
          <button
            type="button"
            onClick={() => setViewMode('lobby')}
            className={viewMode === 'lobby' ? 'active' : ''}
          >
            Lobby map
          </button>
          <button
            type="button"
            onClick={() => setViewMode('screen')}
            className={viewMode === 'screen' ? 'active' : ''}
            disabled={!hasClaimedCell}
          >
            My tile view
          </button>
          {hasClaimedCell ? (
            <button type="button" className="ghost" onClick={handleReleaseCell}>
              Release tile
            </button>
          ) : (
            <p className="hint">Claim an adjacent empty cell on the map.</p>
          )}
        </section>

        {viewMode === 'lobby' && snapshot ? (
          <LobbyMap
            snapshot={snapshot}
            claimedByKey={claimedByKey}
            railsByKey={railsByKey}
            claimableSet={claimableSet}
            canClaim={!hasClaimedCell}
            selfClientId={clientId}
            trainMarkerStyle={trainMarkerStyle}
            onClaimCell={handleClaimCell}
          />
        ) : null}

        {viewMode === 'screen' && self?.claimedCell && snapshot ? (
          <FocusedScreenView
            cell={self.claimedCell}
            self={self}
            railsByKey={railsByKey}
            claimedByKey={claimedByKey}
            trainTileState={focusedTileTrain}
          />
        ) : null}

        {errorMessage ? <p className="status error">{errorMessage}</p> : null}
        {infoMessage ? <p className="status info">{infoMessage}</p> : null}
      </section>
    </main>
  );
}

interface LobbyMapProps {
  snapshot: Snapshot;
  claimedByKey: Map<string, ClaimedCell>;
  railsByKey: Map<string, RailTile>;
  claimableSet: Set<string>;
  canClaim: boolean;
  selfClientId: string;
  trainMarkerStyle: { left: string; top: string } | null;
  onClaimCell: (cell: Point) => void;
}

function LobbyMap({
  snapshot,
  claimedByKey,
  railsByKey,
  claimableSet,
  canClaim,
  selfClientId,
  trainMarkerStyle,
  onClaimCell
}: LobbyMapProps) {
  const cells: JSX.Element[] = [];

  for (let y = 0; y < snapshot.gridSize; y += 1) {
    for (let x = 0; x < snapshot.gridSize; x += 1) {
      const key = pointKey({ x, y });
      const claimed = claimedByKey.get(key);
      const rail = railsByKey.get(key);
      const isStation = x === snapshot.station.x && y === snapshot.station.y;
      const isClaimable = claimableSet.has(key);
      const isSelf = claimed?.clientId === selfClientId;

      let cellClass = 'cell';
      if (isStation) {
        cellClass += ' station';
      } else if (claimed) {
        cellClass += ' occupied';
      } else if (isClaimable && canClaim) {
        cellClass += ' claimable';
      }

      cells.push(
        <div key={key} className={cellClass}>
          <RailGlyph edges={rail?.edges || []} emphasized={Boolean(isStation || isSelf)} />
          {isStation ? <span className="badge station-badge">Station</span> : null}
          {claimed ? (
            <span className={`badge user-badge${isSelf ? ' self' : ''}`}>
              {claimed.username}
              {claimed.connected ? '' : ' (offline)'}
            </span>
          ) : null}
          {!claimed && !isStation && isClaimable && canClaim ? (
            <button
              type="button"
              className="claim-button"
              onClick={() => onClaimCell({ x, y })}
              aria-label={`Claim cell ${x}, ${y}`}
            >
              Claim
            </button>
          ) : null}
        </div>
      );
    }
  }

  return (
    <section className="panel">
      <h2>Shared topology map</h2>
      <p>
        Claimable cells are adjacent to existing network tiles. Route segments: {snapshot.schedule.segmentCount}.{' '}
        Cycle time: {Math.round(snapshot.schedule.cycleDurationMs / 1000)}s.
      </p>
      <div className="grid-wrap">
        <div
          className="grid"
          style={{
            gridTemplateColumns: `repeat(${snapshot.gridSize}, minmax(0, 1fr))`
          }}
        >
          {cells}
          {trainMarkerStyle ? (
            <div className="train-marker" style={trainMarkerStyle}>
              <span>Loco</span>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

interface FocusedScreenViewProps {
  cell: Point;
  self: ClientState;
  railsByKey: Map<string, RailTile>;
  claimedByKey: Map<string, ClaimedCell>;
  trainTileState: ReturnType<typeof computeTileTrainState>;
}

function FocusedScreenView({
  cell,
  self,
  railsByKey,
  claimedByKey,
  trainTileState
}: FocusedScreenViewProps) {
  const ownRailEdges = railsByKey.get(pointKey(cell))?.edges || [];

  const neighbors = useMemo(() => {
    const nearby: Array<{ label: string; value: string }> = [];
    const offsets: Array<{ label: string; point: Point }> = [
      { label: 'North', point: { x: cell.x, y: cell.y - 1 } },
      { label: 'East', point: { x: cell.x + 1, y: cell.y } },
      { label: 'South', point: { x: cell.x, y: cell.y + 1 } },
      { label: 'West', point: { x: cell.x - 1, y: cell.y } }
    ];

    for (const entry of offsets) {
      const found = claimedByKey.get(pointKey(entry.point));
      if (found) {
        nearby.push({ label: entry.label, value: found.username });
      }
    }

    return nearby;
  }, [cell.x, cell.y, claimedByKey]);

  return (
    <section className="panel focused">
      <h2>Focused tile view</h2>
      <p>
        {self.username} at ({cell.x}, {cell.y})
      </p>
      <div className="focused-tile">
        <RailGlyph edges={ownRailEdges} emphasized />
        {trainTileState ? (
          <div
            className="train-dot"
            style={{ left: `${trainTileState.x}%`, top: `${trainTileState.y}%` }}
            title={`${trainTileState.movement} ${trainTileState.edge}`}
          >
            L
          </div>
        ) : null}
      </div>
      <p className="hint">
        The locomotive appears here as it crosses this tile and exits/enters through the proper edge.
      </p>
      <div className="neighbor-list">
        {neighbors.length > 0 ? (
          neighbors.map((neighbor) => (
            <div key={neighbor.label} className="neighbor-item">
              <strong>{neighbor.label}</strong>
              <span>{neighbor.value}</span>
            </div>
          ))
        ) : (
          <p className="hint">No neighboring claimed tiles yet.</p>
        )}
      </div>
    </section>
  );
}

function RailGlyph({ edges, emphasized = false }: { edges: Direction[]; emphasized?: boolean }) {
  return (
    <svg viewBox="0 0 100 100" aria-hidden="true" className={`rail-svg${emphasized ? ' emphasized' : ''}`}>
      {edges.map((edge) => {
        const endpoint = edgePosition(edge);
        return (
          <line
            key={edge}
            x1="50"
            y1="50"
            x2={endpoint.x}
            y2={endpoint.y}
            className="rail-segment"
          />
        );
      })}
      <circle cx="50" cy="50" r="7" className="rail-hub" />
    </svg>
  );
}

function ConnectionPill({ state }: { state: ConnectionState }) {
  return <span className={`connection-pill ${state}`}>Realtime: {state}</span>;
}

function safeParseMessage(raw: unknown): ServerMessage | null {
  try {
    return JSON.parse(String(raw)) as ServerMessage;
  } catch {
    return null;
  }
}

function getOrCreateClientId(): string {
  const existing = localStorage.getItem(STORAGE_CLIENT_ID);
  if (existing) {
    return existing;
  }

  const generated = crypto.randomUUID();
  localStorage.setItem(STORAGE_CLIENT_ID, generated);
  return generated;
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return 'Unexpected error';
}

export default App;
