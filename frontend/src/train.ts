import type { Direction, Point, Snapshot } from './types';

export interface TrainState {
  segmentIndex: number;
  from: Point;
  to: Point;
  progress: number;
  worldX: number;
  worldY: number;
  direction: Direction;
}

export interface TileTrainState {
  x: number;
  y: number;
  movement: 'entering' | 'exiting';
  edge: Direction;
}

export function pointKey(point: Point): string {
  return `${point.x},${point.y}`;
}

export function pointsEqual(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y;
}

export function directionBetween(from: Point, to: Point): Direction {
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

  const { schedule, routeNodes } = snapshot;
  const cycleDuration = Math.max(schedule.segmentDurationMs, schedule.cycleDurationMs);
  const elapsed = mod(serverNowMs - schedule.cycleStartTimeMs, cycleDuration);
  const segmentIndex = Math.min(
    schedule.segmentCount - 1,
    Math.floor(elapsed / schedule.segmentDurationMs)
  );

  const segmentElapsed = elapsed - segmentIndex * schedule.segmentDurationMs;
  const progress = clamp(segmentElapsed / schedule.segmentDurationMs, 0, 0.9999);

  const from = routeNodes[segmentIndex] || routeNodes[0];
  const to = routeNodes[segmentIndex + 1] || routeNodes[0];

  return {
    segmentIndex,
    from,
    to,
    progress,
    worldX: lerp(from.x, to.x, progress),
    worldY: lerp(from.y, to.y, progress),
    direction: directionBetween(from, to)
  };
}

export function computeTileTrainState(tile: Point, trainState: TrainState | null): TileTrainState | null {
  if (!trainState) {
    return null;
  }

  const { from, to, progress, direction } = trainState;

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

function mod(value: number, base: number): number {
  return ((value % base) + base) % base;
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
