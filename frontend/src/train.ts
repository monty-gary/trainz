import type { Direction, Point, Snapshot } from './types';

export interface TrainState {
  segmentIndex: number;
  from: Point;
  to: Point;
  progress: number;
  worldX: number;
  worldY: number;
  direction: Direction;
  paused: boolean;
}

export interface TileTrainState {
  x: number;
  y: number;
  movement: 'entering' | 'exiting' | 'paused';
  edge: Direction;
}

export function pointKey(point: Point): string {
  return `${point.x},${point.y}`;
}

export function pointsEqual(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y;
}

export function directionBetween(from: Point, to: Point): Direction {
  if (to.x === from.x && to.y === from.y) {
    return 'E';
  }

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

export function oppositeDirection(direction: Direction): Direction {
  switch (direction) {
    case 'N':
      return 'S';
    case 'E':
      return 'W';
    case 'S':
      return 'N';
    case 'W':
      return 'E';
  }
}

export function edgePosition(direction: Direction): Point {
  switch (direction) {
    case 'N':
      return { x: 50, y: 6 };
    case 'E':
      return { x: 94, y: 50 };
    case 'S':
      return { x: 50, y: 94 };
    case 'W':
      return { x: 6, y: 50 };
  }
}

export function computeTrainState(snapshot: Snapshot | null, serverNowMs: number): TrainState | null {
  if (!snapshot || snapshot.routeNodes.length < 2 || snapshot.schedule.segmentCount < 1) {
    return null;
  }

  const { routeNodes, train } = snapshot;
  const segmentCount = Math.max(1, routeNodes.length - 1);
  const segmentIndex = Math.min(segmentCount - 1, Math.max(0, train.segmentIndex % segmentCount));
  const from = routeNodes[segmentIndex] || routeNodes[0];
  const to = routeNodes[segmentIndex + 1] || routeNodes[0];
  const direction = directionBetween(from, to);

  if (train.paused && train.pausedAt) {
    const previousSegmentIndex = (segmentIndex - 1 + segmentCount) % segmentCount;
    const previousNode = routeNodes[previousSegmentIndex] || train.pausedAt;

    return {
      segmentIndex,
      from: train.pausedAt,
      to: train.pausedAt,
      progress: 0,
      worldX: train.pausedAt.x,
      worldY: train.pausedAt.y,
      direction: directionBetween(previousNode, train.pausedAt),
      paused: true
    };
  }

  const elapsed = Math.max(0, serverNowMs - train.segmentStartTimeMs);
  const progress = clamp(elapsed / train.segmentDurationMs, 0, 0.9999);

  return {
    segmentIndex,
    from,
    to,
    progress,
    worldX: lerp(from.x, to.x, progress),
    worldY: lerp(from.y, to.y, progress),
    direction,
    paused: false
  };
}

export function computeTileTrainState(tile: Point, trainState: TrainState | null): TileTrainState | null {
  if (!trainState) {
    return null;
  }

  const { from, to, progress, direction, paused } = trainState;

  if (paused && pointsEqual(tile, from)) {
    return {
      x: 50,
      y: 50,
      movement: 'paused',
      edge: direction
    };
  }

  if (pointsEqual(tile, from) && progress <= 0.5) {
    const edge = edgePosition(direction);
    const localProgress = progress / 0.5;

    return {
      x: lerp(50, edge.x, localProgress),
      y: lerp(50, edge.y, localProgress),
      movement: 'exiting',
      edge: direction
    };
  }

  if (pointsEqual(tile, to) && progress >= 0.5) {
    const incoming = oppositeDirection(direction);
    const edge = edgePosition(incoming);
    const localProgress = (progress - 0.5) / 0.5;

    return {
      x: lerp(edge.x, 50, localProgress),
      y: lerp(edge.y, 50, localProgress),
      movement: 'entering',
      edge: incoming
    };
  }

  return null;
}

export function directionToDegrees(direction: Direction): number {
  switch (direction) {
    case 'N':
      return -90;
    case 'E':
      return 0;
    case 'S':
      return 90;
    case 'W':
      return 180;
  }
}

function lerp(start: number, end: number, amount: number): number {
  return start + (end - start) * amount;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }

  if (value > max) {
    return max;
  }

  return value;
}
