/** Hit testing and cross-referencing for scenes. */
import { arcPoints, type Point, type Scene, type SceneItem, type Shape } from "./scene.ts";

/** Lower numbers win when several items lie under the pointer. */
const PRIORITY: Readonly<Record<SceneItem["kind"], number>> = {
  pad: 0,
  via: 0,
  junction: 1,
  label: 1,
  "no-connect": 1,
  track: 2,
  wire: 2,
  symbol: 3,
  footprint: 3,
  sheet: 4,
  graphic: 5,
  zone: 6,
};

function distanceToSegment(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t =
    length === 0
      ? 0
      : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

function distanceToPath(point: Point, path: ReadonlyArray<Point>): number {
  let best = Infinity;
  for (let index = 1; index < path.length; index++) {
    const a = path[index - 1];
    const b = path[index];
    if (a && b) best = Math.min(best, distanceToSegment(point, a, b));
  }
  return best;
}

function inPolygon(point: Point, polygon: ReadonlyArray<Point>): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (!a || !b) continue;
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function hitsShape(shape: Shape, point: Point, tolerance: number): boolean {
  switch (shape.kind) {
    case "line":
      return distanceToPath(point, shape.points) <= shape.width / 2 + tolerance;
    case "arc":
      return (
        distanceToPath(point, arcPoints(shape.start, shape.mid, shape.end)) <=
        shape.width / 2 + tolerance
      );
    case "polygon":
      return shape.fill !== undefined
        ? inPolygon(point, shape.points)
        : distanceToPath(point, [...shape.points, ...shape.points.slice(0, 1)]) <=
            shape.width / 2 + tolerance;
    case "circle": {
      const distance = Math.hypot(point.x - shape.center.x, point.y - shape.center.y);
      return shape.fill !== undefined
        ? distance <= shape.radius + tolerance
        : Math.abs(distance - shape.radius) <= shape.width / 2 + tolerance;
    }
    case "text":
      return false;
  }
}

const inBox = (item: SceneItem, point: Point, tolerance: number) =>
  point.x >= item.box.minX - tolerance &&
  point.x <= item.box.maxX + tolerance &&
  point.y >= item.box.minY - tolerance &&
  point.y <= item.box.maxY + tolerance;

/** Parts and labels are picked by their box; lines and copper by their exact shape. */
const BY_BOX: ReadonlySet<SceneItem["kind"]> = new Set([
  "symbol",
  "footprint",
  "label",
  "sheet",
  "no-connect",
]);

/**
 * The item under `point`, preferring small precise things (a pad over its
 * footprint, a track over a zone). `visible` filters out hidden layers.
 */
export function pickItem(
  scene: Scene,
  point: Point,
  tolerance: number,
  visible: (item: SceneItem) => boolean = () => true,
): SceneItem | undefined {
  let best: SceneItem | undefined;
  let bestRank = Infinity;
  for (const item of scene.items) {
    if (!inBox(item, point, tolerance) || !visible(item)) continue;
    const hit =
      BY_BOX.has(item.kind) || item.shapes.some((shape) => hitsShape(shape, point, tolerance));
    if (!hit) continue;
    const area = (item.box.maxX - item.box.minX) * (item.box.maxY - item.box.minY);
    // Priority decides first; among equals the smaller item is the one aimed at.
    const rank = PRIORITY[item.kind] * 1e9 + Math.min(area, 1e8);
    if (rank < bestRank) {
      best = item;
      bestRank = rank;
    }
  }
  return best;
}

/** KiCad writes `/` inside a net name as `{slash}`. */
export const displayNet = (net: string): string => net.replaceAll("{slash}", "/");

/**
 * Whether a schematic net and a board net are the same. The board prefixes
 * local nets with their sheet path (`/RX`, `/power/EN`); global nets match as is.
 */
export function sameNet(schematicNet: string, boardNet: string): boolean {
  const a = displayNet(schematicNet);
  const b = displayNet(boardNet);
  return a === b || b === `/${a}` || (b.startsWith("/") && b.endsWith(`/${a}`) && !a.includes("/"));
}
