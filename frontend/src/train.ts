import type { Direction, Point, Snapshot, TrainComposition } from './types';

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
  distanceFromTile: number;
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

  const deltaX = trainState.worldX - tile.x;
  const deltaY = trainState.worldY - tile.y;
  return {
    x: 50 + deltaX * 100,
    y: 50 + deltaY * 100,
    distanceFromTile: Math.max(Math.abs(deltaX), Math.abs(deltaY))
  };
}

export function shouldRenderTrainOnTile(
  tileTrainState: TileTrainState | null,
  composition: TrainComposition | null
): boolean {
  if (!tileTrainState) {
    return false;
  }

  const wagonCount = Math.max(1, composition?.wagonCount ?? 2);
  const estimatedTrainLengthInTiles = 0.85 + wagonCount * 0.62;
  return tileTrainState.distanceFromTile <= estimatedTrainLengthInTiles;
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
      return 0;
  }
}

export function directionToScaleX(direction: Direction): number {
  return direction === 'W' ? -1 : 1;
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
