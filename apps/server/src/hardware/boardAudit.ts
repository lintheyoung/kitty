/** Kitty's own checks of a board, beyond what KiCad's DRC and Copper's review look at. */
import type { Box, Point, Scene, SceneItem } from "@t3tools/shared/kicad/scene";
import { unionBoxes } from "@t3tools/shared/kicad/scene";

export interface AuditPoint {
  readonly type: string;
  readonly description: string;
  readonly fix: string;
  /** Where to look, in millimetres. */
  readonly x: number;
  readonly y: number;
}

/** A radio module that carries its own PCB antenna at one end of its body. */
const RADIO_MODULE = /ESP32|ESP8266|ESP-?(0[1-9]|1[0-9])\b|WROOM|WROVER|MINI-1|PICO-(D4|V3|MINI)/i;
/** A body end this much longer than its pads holds the antenna. */
const ANTENNA_MIN_MM = 3;
/** Copper this close beside the antenna still detunes it. */
const ANTENNA_SIDE_MM = 3;
/** An antenna further than this inside the outline has board under or ahead of it. */
const EDGE_REACH_MM = 1;
/** The antenna stops short of the first pads; this much of the strip beside them is not antenna. */
const PAD_MARGIN_MM = 1;
const NAMED = 4;

type Side = "left" | "right" | "top" | "bottom";

const overlaps = (a: Box, b: Box) =>
  a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;

function insidePolygon(point: Point, polygon: ReadonlyArray<Point>): boolean {
  let inside = false;
  for (let index = 0, last = polygon.length - 1; index < polygon.length; last = index++) {
    const a = polygon[index];
    const b = polygon[last];
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

/** Whether a filled copper shape reaches into the box: by a corner of its own or by covering it. */
function fillReaches(polygon: ReadonlyArray<Point>, box: Box): boolean {
  if (polygon.some((p) => p.x > box.minX && p.x < box.maxX && p.y > box.minY && p.y < box.maxY)) {
    return true;
  }
  const steps = 6;
  for (let i = 1; i < steps; i++) {
    for (let j = 1; j < steps; j++) {
      const point = {
        x: box.minX + ((box.maxX - box.minX) * i) / steps,
        y: box.minY + ((box.maxY - box.minY) * j) / steps,
      };
      if (insidePolygon(point, polygon)) return true;
    }
  }
  return false;
}

/** The antenna end of a module: the strip of its body that reaches past its pads. */
export function antennaArea(
  body: Box,
  pads: Box,
): { readonly side: Side; readonly area: Box } | undefined {
  const reach: ReadonlyArray<readonly [Side, number]> = [
    ["left", pads.minX - body.minX],
    ["right", body.maxX - pads.maxX],
    ["top", pads.minY - body.minY],
    ["bottom", body.maxY - pads.maxY],
  ];
  const [side, length] = reach.toSorted((a, b) => b[1] - a[1])[0] ?? ["left", 0];
  if (length < ANTENNA_MIN_MM) return undefined;
  const area: Box =
    side === "left"
      ? { ...body, maxX: pads.minX - PAD_MARGIN_MM }
      : side === "right"
        ? { ...body, minX: pads.maxX + PAD_MARGIN_MM }
        : side === "top"
          ? { ...body, maxY: pads.minY - PAD_MARGIN_MM }
          : { ...body, minY: pads.maxY + PAD_MARGIN_MM };
  return { side, area };
}

const isCopper = (layer: string | undefined) => layer === undefined || /\.Cu$/.test(layer);

/** What sits in the antenna's way on one module, and whether the antenna reaches the board edge. */
function auditAntenna(module: SceneItem, scene: Scene, outline: Box | undefined): AuditPoint[] {
  const pads = unionBoxes(
    scene.items
      .filter((item) => item.kind === "pad" && item.ref === module.ref)
      .map((item) => item.box),
  );
  const found = pads ? antennaArea(module.box, pads) : undefined;
  if (!found) return [];
  const { side, area } = found;
  const across = side === "left" || side === "right";
  // Beside the antenna counts too, not ahead of it: ahead is the edge check's business.
  const guarded: Box = across
    ? { ...area, minY: area.minY - ANTENNA_SIDE_MM, maxY: area.maxY + ANTENNA_SIDE_MM }
    : { ...area, minX: area.minX - ANTENNA_SIDE_MM, maxX: area.maxX + ANTENNA_SIDE_MM };
  const x = (area.minX + area.maxX) / 2;
  const y = (area.minY + area.maxY) / 2;
  const name = `${module.ref ?? "The module"}${module.value ? ` (${module.value})` : ""}`;
  const points: AuditPoint[] = [];

  const inTheWay = new Set<string>();
  let poured = false;
  for (const item of scene.items) {
    if (item.ref === module.ref && (item.kind === "pad" || item.kind === "footprint")) continue;
    if (item.kind === "track" || item.kind === "via") {
      if (overlaps(item.box, guarded)) inTheWay.add(item.net ? `net ${item.net}` : item.kind);
    } else if (item.kind === "pad" && isCopper(item.layer)) {
      if (overlaps(item.box, guarded)) inTheWay.add(item.ref ?? "a pad");
    } else if (item.kind === "zone" && !item.title?.startsWith("Keep-out")) {
      const reaches = item.shapes.some(
        (shape) =>
          shape.kind === "polygon" &&
          shape.fill !== undefined &&
          fillReaches(shape.points, guarded),
      );
      if (reaches) poured = true;
    }
  }
  if (inTheWay.size > 0 || poured) {
    const what = [...(poured ? ["the copper pour"] : []), ...[...inTheWay].slice(0, NAMED)];
    const more = inTheWay.size > NAMED ? ` and ${inTheWay.size - NAMED} more` : "";
    points.push({
      type: "audit_antenna_copper",
      description: `Copper under or beside the antenna of ${name}: ${what.join(", ")}${more}`,
      fix: `Keep every layer free of copper under the antenna end of ${module.ref ?? "the module"} and ${ANTENNA_SIDE_MM} mm to each side of it: add a keep-out area there for tracks, vias and pours, and move what crosses it. Copper there detunes the antenna and shortens the radio's range.`,
      x,
      y,
    });
  }

  if (outline) {
    const inset =
      side === "left"
        ? area.minX - outline.minX
        : side === "right"
          ? outline.maxX - area.maxX
          : side === "top"
            ? area.minY - outline.minY
            : outline.maxY - area.maxY;
    if (inset > EDGE_REACH_MM) {
      points.push({
        type: "audit_antenna_edge",
        description: `The antenna of ${name} is ${inset.toFixed(1)} mm inside the board edge`,
        fix: `Move ${module.ref ?? "the module"} so its antenna end sits on the board edge or hangs over it, or cut the board away under the antenna. Board material and parts ahead of the antenna weaken the radio.`,
        x,
        y,
      });
    }
  }
  return points;
}

/** Every point Kitty's own checks raise on a board. */
export function auditBoard(scene: Scene): ReadonlyArray<AuditPoint> {
  const outline = unionBoxes(
    scene.items.filter((item) => item.layer === "Edge.Cuts").map((item) => item.box),
  );
  return scene.items
    .filter(
      (item) =>
        item.kind === "footprint" &&
        RADIO_MODULE.test(
          `${item.value ?? ""} ${(item.facts ?? []).map(([, fact]) => fact).join(" ")}`,
        ),
    )
    .flatMap((module) => auditAntenna(module, scene, outline));
}
