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

/**
 * For each net, the shortest set of lines that would join everything not yet
 * joined by tracks. Nets with a copper zone are left out: the zone joins them.
 */
export function ratsnest(scene: Scene): ReadonlyArray<Airwire> {
  const byNet = new Map<string, { pads: Array<SceneItem>; copper: Array<SceneItem> }>();
  const zoned = new Set<string>();
  for (const item of scene.items) {
    if (!item.net || item.net.startsWith("unconnected-")) continue;
    if (item.kind === "zone") zoned.add(item.net);
    if (item.kind !== "pad" && item.kind !== "track" && item.kind !== "via") continue;
    const net = byNet.get(item.net) ?? { pads: [], copper: [] };
    (item.kind === "pad" ? net.pads : net.copper).push(item);
    byNet.set(item.net, net);
  }
  const wires: Array<Airwire> = [];
  for (const [net, { pads, copper }] of byNet) {
    if (pads.length < 2 || zoned.has(net)) continue;
    // Islands of copper: pads start alone and tracks and vias merge what they touch.
    const island = pads.map((_, index) => index);
    const find = (index: number): number => {
      let root = index;
      while (island[root] !== root) root = island[root] ?? root;
      return root;
    };
    const points = copper.map(touchPoints);
    const padsAt = (spots: ReadonlyArray<Point>) =>
      pads.flatMap((pad, index) =>
        spots.some((spot) => within(spot, pad.box, TOUCH)) ? [index] : [],
      );
    // Tracks that meet end to end carry a connection on to the pads at either end.
    const chain = copper.map((_, index) => index);
    const chainOf = (index: number): number => {
      let root = index;
      while (chain[root] !== root) root = chain[root] ?? root;
      return root;
    };
    for (let a = 0; a < copper.length; a++) {
      for (let b = a + 1; b < copper.length; b++) {
        const meets = (points[a] ?? []).some((p) =>
          (points[b] ?? []).some((q) => Math.hypot(p.x - q.x, p.y - q.y) <= TOUCH),
        );
        if (meets) chain[chainOf(a)] = chainOf(b);
      }
    }
    const reached = new Map<number, Array<number>>();
    copper.forEach((_, index) => {
      const root = chainOf(index);
      reached.set(root, [...(reached.get(root) ?? []), ...padsAt(points[index] ?? [])]);
    });
    for (const joined of reached.values()) {
      const [first, ...rest] = joined;
      if (first === undefined) continue;
      for (const other of rest) island[find(other)] = find(first);
    }
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
      island[find(best.a)] = find(best.b);
    }
  }
  return wires;
}
