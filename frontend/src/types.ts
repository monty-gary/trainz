export type Direction = 'N' | 'E' | 'S' | 'W';
export type SignalState = 'red' | 'green';

export interface Point {
  x: number;
  y: number;
}

export interface ClientState {
  clientId: string;
  username: string | null;
  claimedCell: Point | null;
  signalState: SignalState | null;
  connected: boolean;
  lastSeenAtMs: number;
}

export interface ClaimedCell extends Point {
  clientId: string;
  username: string;
  connected: boolean;
  signalState: SignalState;
}

export interface RailTile extends Point {
  edges: Direction[];
}

export interface TrainSchedule {
  revision: number;
  cycleStartTimeMs: number;
  segmentDurationMs: number;
  segmentCount: number;
  cycleDurationMs: number;
}

export interface TrainRuntime {
  segmentIndex: number;
  segmentStartTimeMs: number;
  segmentDurationMs: number;
  paused: boolean;
  pausedAt: Point | null;
}

export interface Snapshot {
  serverNowMs: number;
  gridSize: number;
  station: Point;
  claimedCells: ClaimedCell[];
  claimableCells: Point[];
  railTiles: RailTile[];
  routeNodes: Point[];
  topologyRevision: number;
  schedule: TrainSchedule;
  train: TrainRuntime;
  clients: ClientState[];
  self: ClientState;
}

export interface SessionResponse {
  ok: boolean;
  session: ClientState;
  config: {
    gridSize: number;
    station: Point;
    trainSegmentDurationMs: number;
  };
}

export type ServerMessage =
  | {
      type: 'state';
      snapshot: Snapshot;
    }
  | {
      type: 'error';
      message: string;
    }
  | {
      type: 'pong';
      serverNowMs: number;
    };

export type ClientMessage =
  | {
      type: 'set_username';
      username: string;
    }
  | {
      type: 'claim_cell';
      x: number;
      y: number;
    }
  | {
      type: 'release_cell';
    }
  | {
      type: 'toggle_signal';
    }
  | {
      type: 'ping';
    };
