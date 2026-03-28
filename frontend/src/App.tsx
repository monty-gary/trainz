import { CSSProperties, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE_URL, WS_URL, authenticate, getSession } from './api';
import {
  computeTileTrainState,
  computeTrainState,
  directionToDegrees,
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
const LOBBY_CELL_SIZE = 72;
const LOBBY_CELL_GAP = 8;

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
  const shouldAnimateTrain = Boolean(snapshot);
  const sendWsMessage = useCallback((message: ClientMessage) => {
    const socket = socketRef.current;

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setErrorMessage('Realtime connection is not ready yet.');
      return;
    }

    socket.send(JSON.stringify(message));
  }, []);
  const clearAuth = useCallback(() => {
    setAuthToken(null);
    setAuthPhase('required');
    setSnapshot(null);
    localStorage.removeItem(STORAGE_AUTH_TOKEN);
  }, []);

  useEffect(() => {
    if (!shouldAnimateTrain) {
      setTickMs(Date.now());
      return;
    }

    let frameId = 0;

    const tick = () => {
      setTickMs(Date.now());
      frameId = window.requestAnimationFrame(tick);
    };

    frameId = window.requestAnimationFrame(tick);

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [shouldAnimateTrain]);

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
  }, [authToken, clientId, clearAuth]);

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
  }, [authPhase, authToken, clientId, sendWsMessage]);

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

    const unit = LOBBY_CELL_SIZE + LOBBY_CELL_GAP;
    const x = trainState.worldX * unit + LOBBY_CELL_SIZE / 2;
    const y = trainState.worldY * unit + LOBBY_CELL_SIZE / 2;

    return {
      '--train-x': `${x}px`,
      '--train-y': `${y}px`,
      '--train-rotation': `${directionToDegrees(trainState.direction)}deg`
    } as CSSProperties;
  }, [snapshot, trainState]);

  const focusedTileTrain = useMemo(() => {
    if (!self?.claimedCell) {
      return null;
    }

    return computeTileTrainState(self.claimedCell, trainState);
  }, [self?.claimedCell, trainState]);

  const focusedTrainStyle = useMemo(() => {
    if (!focusedTileTrain || !trainState) {
      return null;
    }

    return {
      left: `${focusedTileTrain.x}%`,
      top: `${focusedTileTrain.y}%`,
      '--train-rotation': `${directionToDegrees(trainState.direction)}deg`
    } as CSSProperties;
  }, [focusedTileTrain, trainState]);

  const handleClaimCell = useCallback(
    (cell: Point) => {
      setErrorMessage(null);
      setInfoMessage(`Requesting tile (${cell.x}, ${cell.y}).`);
      sendWsMessage({ type: 'claim_cell', x: cell.x, y: cell.y });
      setViewMode('screen');
    },
    [sendWsMessage]
  );

  const handleReleaseCell = useCallback(() => {
    setInfoMessage('Released your tile.');
    sendWsMessage({ type: 'release_cell' });
    setViewMode('lobby');
  }, [sendWsMessage]);

  const handleToggleSignal = useCallback(() => {
    setErrorMessage(null);
    setInfoMessage('Signal toggle requested.');
    sendWsMessage({ type: 'toggle_signal' });
  }, [sendWsMessage]);

  async function handlePasswordSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const candidate = passwordInput.trim();
    if (!candidate) {
      setErrorMessage('Enter the shared password.');
      return;
    }

    setIsWorking(true);
    setErrorMessage(null);
    setInfoMessage('Authenticating and waking backend...');

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

  if (authPhase === 'checking') {
    return (
      <main className="app-shell">
        <section className="card gate-card">
          <h1>trainz</h1>
          <p>Waking backend and checking saved session...</p>
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
          {infoMessage ? <p className="status info">{infoMessage}</p> : null}
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
            trainPaused={Boolean(trainState?.paused)}
            onClaimCell={handleClaimCell}
            onToggleSignal={handleToggleSignal}
          />
        ) : null}

        {viewMode === 'screen' && self?.claimedCell && snapshot ? (
          <FocusedScreenView
            cell={self.claimedCell}
            self={self}
            railsByKey={railsByKey}
            claimedCells={snapshot.claimedCells}
            trainTileState={focusedTileTrain}
            trainStyle={focusedTrainStyle}
            onToggleSignal={handleToggleSignal}
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
  trainMarkerStyle: CSSProperties | null;
  trainPaused: boolean;
  onClaimCell: (cell: Point) => void;
  onToggleSignal: () => void;
}

function LobbyMap({
  snapshot,
  claimedByKey,
  railsByKey,
  claimableSet,
  canClaim,
  selfClientId,
  trainMarkerStyle,
  trainPaused,
  onClaimCell,
  onToggleSignal
}: LobbyMapProps) {
  const cells = useMemo(() => {
    const renderedCells: JSX.Element[] = [];

    for (let y = 0; y < snapshot.gridSize; y += 1) {
      for (let x = 0; x < snapshot.gridSize; x += 1) {
        const key = pointKey({ x, y });
        const claimed = claimedByKey.get(key);
        const rail = railsByKey.get(key);
        const isStation = x === snapshot.station.x && y === snapshot.station.y;
        const isClaimable = claimableSet.has(key);
        const isSelf = claimed?.clientId === selfClientId;
        const signalState = claimed?.signalState === 'red' ? 'red' : 'green';

        let cellClass = 'cell';
        if (isStation) {
          cellClass += ' station';
        } else if (claimed) {
          cellClass += ' occupied';
        } else if (isClaimable && canClaim) {
          cellClass += ' claimable';
        }

        renderedCells.push(
          <div key={key} className={cellClass}>
            <RailGlyph edges={rail?.edges || []} emphasized={Boolean(isStation || isSelf)} />
            {isStation ? <span className="badge station-badge">Station</span> : null}
            {claimed ? (
              <span className={`badge user-badge${isSelf ? ' self' : ''}`}>
                {claimed.username}
                {claimed.connected ? '' : ' (offline)'}
              </span>
            ) : null}
            {claimed ? (
              <button
                type="button"
                className={`signal-zone ${signalState}${isSelf ? ' self' : ''}`}
                onClick={isSelf ? onToggleSignal : undefined}
                disabled={!isSelf}
                aria-label={isSelf ? 'Toggle tile stop/passthrough signal' : undefined}
                title={`Signal: ${signalState === 'red' ? 'stop' : 'passthrough'}`}
              >
                {signalState === 'red' ? 'STOP' : 'PASS'}
              </button>
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

    return renderedCells;
  }, [snapshot, claimedByKey, railsByKey, claimableSet, canClaim, selfClientId, onClaimCell, onToggleSignal]);

  return (
    <section className="panel">
      <h2>Shared topology map</h2>
      <p>
        Tap your signal zone to toggle stop/passthrough. Route segments: {snapshot.schedule.segmentCount}. Cycle time:{' '}
        {Math.round(snapshot.schedule.cycleDurationMs / 1000)}s.
      </p>
      <div className="grid-wrap">
        <div
          className="grid"
          style={{
            gridTemplateColumns: `repeat(${snapshot.gridSize}, ${LOBBY_CELL_SIZE}px)`,
            gridAutoRows: `${LOBBY_CELL_SIZE}px`,
            gap: `${LOBBY_CELL_GAP}px`
          }}
        >
          {cells}
          {trainMarkerStyle ? (
            <TrainSprite className="lobby" style={trainMarkerStyle} paused={trainPaused} />
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
  claimedCells: ClaimedCell[];
  trainTileState: ReturnType<typeof computeTileTrainState>;
  trainStyle: CSSProperties | null;
  onToggleSignal: () => void;
}

function FocusedScreenView({
  cell,
  self,
  railsByKey,
  claimedCells,
  trainTileState,
  trainStyle,
  onToggleSignal
}: FocusedScreenViewProps) {
  const ownRailEdges = railsByKey.get(pointKey(cell))?.edges || [];
  const ownSignalState = self.signalState === 'red' ? 'red' : 'green';

  const networkSignals = useMemo(() => {
    return claimedCells
      .map((entry) => ({
        id: entry.clientId,
        label: `${entry.username} (${entry.x}, ${entry.y})`,
        signalState: entry.signalState
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [claimedCells]);

  return (
    <section className="panel focused">
      <h2>Focused tile view</h2>
      <p>
        {self.username} at ({cell.x}, {cell.y})
      </p>
      <div className="focused-tile">
        <RailGlyph edges={ownRailEdges} emphasized />
        {trainStyle && trainTileState ? (
          <TrainSprite
            className="focused"
            style={trainStyle}
            paused={trainTileState.movement === 'paused'}
          />
        ) : null}
        <button
          type="button"
          className={`focused-signal ${ownSignalState}`}
          onClick={onToggleSignal}
          aria-label="Toggle stop/passthrough signal"
          title="Toggle stop/passthrough"
        >
          {ownSignalState === 'red' ? 'STOP' : 'PASS'}
        </button>
      </div>
      <p className="hint">
        Red holds the train at this station point. Green releases it onto the next route segment.
      </p>
      <div className="neighbor-list">
        {networkSignals.length > 0 ? (
          networkSignals.map((entry) => (
            <div key={entry.id} className="neighbor-item">
              <strong>{entry.label}</strong>
              <span className={`signal-pill ${entry.signalState}`}>
                {entry.signalState === 'red' ? 'STOP' : 'PASS'}
              </span>
            </div>
          ))
        ) : (
          <p className="hint">No claimed tiles yet.</p>
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

function TrainSprite({
  className,
  style,
  paused
}: {
  className: 'lobby' | 'focused';
  style: CSSProperties;
  paused: boolean;
}) {
  return (
    <div className={`train-sprite ${className}${paused ? ' paused' : ''}`} style={style}>
      <svg viewBox="0 0 120 56" aria-hidden="true" className="train-svg">
        <rect x="14" y="12" width="42" height="24" rx="6" className="train-locomotive" />
        <rect x="34" y="18" width="12" height="10" rx="2" className="train-window" />
        <rect x="62" y="20" width="8" height="5" rx="2.5" className="train-coupler" />
        <rect x="74" y="14" width="34" height="22" rx="6" className="train-carriage" />
        <rect x="82" y="20" width="12" height="8" rx="2" className="train-window" />
        <circle cx="26" cy="40" r="5.5" className="train-wheel" />
        <circle cx="44" cy="40" r="5.5" className="train-wheel" />
        <circle cx="84" cy="40" r="5.5" className="train-wheel" />
        <circle cx="100" cy="40" r="5.5" className="train-wheel" />
      </svg>
    </div>
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
