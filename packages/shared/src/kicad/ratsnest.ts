/** The connections a board still needs: one thin line per pair of pads left to join. */
import type { Box, Point, Scene, SceneItem } from "./scene.ts";

export interface Airwire {
  readonly net: string;
  readonly from: Point;
  readonly to: Point;
}

const centre = (box: Box): Point => ({
  x: (box.minX + box.maxX) / 2,
  y: (box.minY + box.maxY) / 2,
});
const within = (point: Point, box: Box, slack: number) =>
  point.x >= box.minX - slack &&
  point.x <= box.maxX + slack &&
  point.y >= box.minY - slack &&
  point.y <= box.maxY + slack;

/** Where a track or via can touch something: its ends, or its centre. */
function touchPoints(item: SceneItem): ReadonlyArray<Point> {
  if (item.kind === "via") return [centre(item.box)];
  const points: Array<Point> = [];
  for (const shape of item.shapes) {
    if (shape.kind === "line") points.push(...shape.points);
    else if (shape.kind === "arc") points.push(shape.start, shape.end);
  }
  return points;
}

const TOUCH = 0.05;

/** The straight runs of a track; a via has none. */
function runs(item: SceneItem): ReadonlyArray<readonly [Point, Point]> {
  const result: Array<readonly [Point, Point]> = [];
  for (const shape of item.shapes) {
    if (shape.kind !== "line" || item.kind !== "track") continue;
    for (let index = 1; index < shape.points.length; index++) {
      const from = shape.points[index - 1];
      const to = shape.points[index];
      if (from && to) result.push([from, to]);
    }
  }
  return result;
}

function distanceToRun(point: Point, [from, to]: readonly [Point, Point]): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = dx * dx + dy * dy;
  const along =
    length === 0
      ? 0
      : Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / length));
  return Math.hypot(point.x - (from.x + along * dx), point.y - (from.y + along * dy));
}

/** Whether two pieces of copper join: an end of one lies on the other, on a shared layer. */
function copperMeets(a: SceneItem, b: SceneItem): boolean {
  if (a.kind === "track" && b.kind === "track" && a.layer !== b.layer) return false;
  const lands = (from: SceneItem, on: SceneItem) =>
    touchPoints(from).some(
      (point) =>
        touchPoints(on).some(
          (other) => Math.hypot(point.x - other.x, point.y - other.y) <= TOUCH,
        ) || runs(on).some((run) => distanceToRun(point, run) <= TOUCH),
    );
  return lands(a, b) || lands(b, a);
}

/** One filled piece of a copper zone: everything of its net that lands on it is joined. */
interface Pour {
  readonly layer: string;
  readonly points: ReadonlyArray<Point>;
  readonly box: Box;
}

function pours(zone: SceneItem): ReadonlyArray<Pour> {
  const result: Array<Pour> = [];
  for (const shape of zone.shapes) {
    if (shape.kind !== "polygon" || shape.fill === undefined || shape.points.length < 3) continue;
    let box: Box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const point of shape.points) {
      box = {
        minX: Math.min(box.minX, point.x),
        minY: Math.min(box.minY, point.y),
        maxX: Math.max(box.maxX, point.x),
        maxY: Math.max(box.maxY, point.y),
      };
    }
    result.push({ layer: shape.paint, points: shape.points, box });
  }
  return result;
}

/** Even-odd test, which also holds for KiCad's fills, where holes are cut in by slits. */
function covers(pour: Pour, point: Point): boolean {
  if (!within(point, pour.box, 0)) return false;
  let inside = false;
  const { points } = pour;
  for (let index = 0, last = points.length - 1; index < points.length; last = index++) {
    const a = points[index];
    const b = points[last];
    if (!a || !b || a.y > point.y === b.y > point.y) continue;
    if (point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** A pad sits on a pour when its middle is covered, or a thermal spoke reaches into it. */
const pourReachesPad = (pour: Pour, pad: SceneItem) =>
  (!pad.layer || pad.layer === pour.layer) &&
  pad.box.maxX >= pour.box.minX &&
  pad.box.minX <= pour.box.maxX &&
  pad.box.maxY >= pour.box.minY &&
  pad.box.minY <= pour.box.maxY &&
  (covers(pour, centre(pad.box)) || pour.points.some((point) => within(point, pad.box, 0)));

/**
 * For each net, the shortest set of lines that would join everything not yet
 * joined by tracks, vias and filled copper zones.
 */
export function ratsnest(scene: Scene): ReadonlyArray<Airwire> {
  const byNet = new Map<string, { pads: Array<SceneItem>; copper: Array<SceneItem> }>();
  const filled = new Map<string, Array<Pour>>();
  for (const item of scene.items) {
    if (!item.net || item.net.startsWith("unconnected-")) continue;
    if (item.kind === "zone")
      filled.set(item.net, [...(filled.get(item.net) ?? []), ...pours(item)]);
    if (item.kind !== "pad" && item.kind !== "track" && item.kind !== "via") continue;
    const net = byNet.get(item.net) ?? { pads: [], copper: [] };
    (item.kind === "pad" ? net.pads : net.copper).push(item);
    byNet.set(item.net, net);
  }
  const wires: Array<Airwire> = [];
  for (const [net, { pads, copper }] of byNet) {
    if (pads.length < 2) continue;
    // Islands of copper: pads, tracks, vias and pours start alone and merge where they touch.
    const netPours = filled.get(net) ?? [];
    const copperAt = pads.length;
    const pourAt = copperAt + copper.length;
    const island = Array.from({ length: pourAt + netPours.length }, (_, index) => index);
    const find = (index: number): number => {
      let root = index;
      while (island[root] !== root) root = island[root] ?? root;
      return root;
    };
    const join = (a: number, b: number) => {
      island[find(a)] = find(b);
    };
    const points = copper.map(touchPoints);
    copper.forEach((item, index) => {
      const spots = points[index] ?? [];
      // A track reaches a pad only on the pad's own side; a via reaches either side.
      pads.forEach((pad, padIndex) => {
        if (
          (item.kind === "via" || !pad.layer || pad.layer === item.layer) &&
          spots.some((spot) => within(spot, pad.box, TOUCH))
        )
          join(copperAt + index, padIndex);
      });
      for (let other = index + 1; other < copper.length; other++) {
        const second = copper[other];
        if (second && copperMeets(item, second)) join(copperAt + index, copperAt + other);
      }
      netPours.forEach((pour, pourIndex) => {
        if (
          (item.kind === "via" || item.layer === pour.layer) &&
          spots.some((spot) => covers(pour, spot))
        )
          join(copperAt + index, pourAt + pourIndex);
      });
    });
    netPours.forEach((pour, pourIndex) => {
      pads.forEach((pad, padIndex) => {
        if (pourReachesPad(pour, pad)) join(pourAt + pourIndex, padIndex);
      });
    });
    // Join the islands with the shortest lines, nearest first.
    const centres = pads.map((pad) => centre(pad.box));
    for (;;) {
      let best: { a: number; b: number; distance: number } | undefined;
      for (let a = 0; a < pads.length; a++) {
        for (let b = a + 1; b < pads.length; b++) {
          if (find(a) === find(b)) continue;
          const from = centres[a];
          const to = centres[b];
          if (!from || !to) continue;
          const distance = Math.hypot(from.x - to.x, from.y - to.y);
          if (!best || distance < best.distance) best = { a, b, distance };
        }
      }
      if (!best) break;
      const from = centres[best.a];
      const to = centres[best.b];
      if (from && to) wires.push({ net, from, to });
      join(best.a, best.b);
    }
  }
  return wires;
}
