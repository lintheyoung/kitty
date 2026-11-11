/**
 * A drawable model of a KiCad schematic sheet or board. Coordinates are in
 * millimetres with Y pointing down, exactly as KiCad stores them.
 */
export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Box {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export type TextAlign = "left" | "center" | "right";
export type TextBaseline = "top" | "middle" | "bottom";

/** What a shape is painted with: a schematic role or a board layer name. */
export type Paint = string;

export type Shape =
  | {
      readonly kind: "line";
      readonly points: ReadonlyArray<Point>;
      readonly width: number;
      readonly paint: Paint;
    }
  | {
      readonly kind: "polygon";
      readonly points: ReadonlyArray<Point>;
      /** Stroke width; 0 draws no outline. */
      readonly width: number;
      readonly paint: Paint;
      readonly fill?: Paint;
    }
  | {
      readonly kind: "circle";
      readonly center: Point;
      readonly radius: number;
      readonly width: number;
      readonly paint: Paint;
      readonly fill?: Paint;
    }
  | {
      readonly kind: "arc";
      readonly start: Point;
      readonly mid: Point;
      readonly end: Point;
      readonly width: number;
      readonly paint: Paint;
    }
  | {
      readonly kind: "text";
      readonly at: Point;
      readonly text: string;
      /** Character height in millimetres. */
      readonly size: number;
      /** True when the text reads bottom-to-top. */
      readonly vertical: boolean;
      readonly align: TextAlign;
      readonly baseline: TextBaseline;
      readonly paint: Paint;
      /** Outline drawn around the text by the renderer (global labels). */
      readonly frame?: "input" | "output" | "bidirectional" | "passive";
    };

export type SceneItemKind =
  | "symbol"
  | "wire"
  | "junction"
  | "label"
  | "no-connect"
  | "sheet"
  | "graphic"
  | "footprint"
  | "pad"
  | "track"
  | "via"
  | "zone";

/** One pin of a schematic symbol, at the point where a wire attaches. */
export interface ScenePin {
  readonly number: string;
  readonly name: string;
  readonly at: Point;
  net?: string;
  /** A hidden power pin that joins its net by name, not by touching a wire. */
  readonly floating?: boolean;
}

export interface SceneItem {
  readonly id: string;
  readonly kind: SceneItemKind;
  readonly box: Box;
  readonly shapes: ReadonlyArray<Shape>;
  /** Reference designator of the part this belongs to (R1, U3). */
  readonly ref?: string;
  readonly value?: string;
  /** Pad or pin number. */
  readonly number?: string;
  /** Net name, when the file states it or connectivity resolves it. */
  net?: string;
  /** Where a label or junction attaches to a wire. */
  readonly anchor?: Point;
  /** Pins of a schematic symbol. */
  readonly pins?: ReadonlyArray<ScenePin>;
  /** Board layer the item lives on. */
  readonly layer?: string;
  /** Short label for the properties panel. */
  readonly title?: string;
  /** Extra facts for the properties panel, in display order. */
  readonly facts?: ReadonlyArray<readonly [name: string, value: string]>;
}

export interface Scene {
  readonly kind: "schematic" | "board";
  readonly items: ReadonlyArray<SceneItem>;
  readonly bounds: Box;
  /** Copper and drawing layers present, bottom of the draw order first. */
  readonly layers: ReadonlyArray<string>;
}

export const EMPTY_BOX: Box = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

export function boxOfPoints(points: Iterable<Point>, pad = 0): Box | undefined {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  if (minX === Infinity) return undefined;
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

export function unionBoxes(boxes: Iterable<Box>): Box | undefined {
  let result: Box | undefined;
  for (const box of boxes) {
    result = result
      ? {
          minX: Math.min(result.minX, box.minX),
          minY: Math.min(result.minY, box.minY),
          maxX: Math.max(result.maxX, box.maxX),
          maxY: Math.max(result.maxY, box.maxY),
        }
      : box;
  }
  return result;
}

/** Centre and radius of the circle through three points, if they are not collinear. */
function arcCircle(
  start: Point,
  mid: Point,
  end: Point,
): { readonly center: Point; readonly radius: number } | undefined {
  const d = 2 * (start.x * (mid.y - end.y) + mid.x * (end.y - start.y) + end.x * (start.y - mid.y));
  if (Math.abs(d) < 1e-9) return undefined;
  const s2 = start.x * start.x + start.y * start.y;
  const m2 = mid.x * mid.x + mid.y * mid.y;
  const e2 = end.x * end.x + end.y * end.y;
  const center = {
    x: (s2 * (mid.y - end.y) + m2 * (end.y - start.y) + e2 * (start.y - mid.y)) / d,
    y: (s2 * (end.x - mid.x) + m2 * (start.x - end.x) + e2 * (mid.x - start.x)) / d,
  };
  return { center, radius: Math.hypot(start.x - center.x, start.y - center.y) };
}

/** Points along the arc from `start` through `mid` to `end`. */
export function arcPoints(start: Point, mid: Point, end: Point, steps = 24): ReadonlyArray<Point> {
  const circle = arcCircle(start, mid, end);
  if (!circle) return [start, mid, end];
  const angle = (point: Point) => Math.atan2(point.y - circle.center.y, point.x - circle.center.x);
  const a0 = angle(start);
  const full = Math.PI * 2;
  const norm = (value: number) => ((value % full) + full) % full;
  const sweepToMid = norm(angle(mid) - a0);
  let sweep = norm(angle(end) - a0);
  // The arc goes the way that passes through `mid`.
  if (sweepToMid > sweep) sweep -= full;
  const points: Array<Point> = [];
  for (let step = 0; step <= steps; step++) {
    const a = a0 + (sweep * step) / steps;
    points.push({
      x: circle.center.x + circle.radius * Math.cos(a),
      y: circle.center.y + circle.radius * Math.sin(a),
    });
  }
  return points;
}

function shapePoints(shape: Shape): ReadonlyArray<Point> {
  switch (shape.kind) {
    case "line":
    case "polygon":
      return shape.points;
    case "circle":
      return [
        { x: shape.center.x - shape.radius, y: shape.center.y - shape.radius },
        { x: shape.center.x + shape.radius, y: shape.center.y + shape.radius },
      ];
    case "arc":
      return arcPoints(shape.start, shape.mid, shape.end, 8);
    case "text": {
      // Text extent is approximate: the renderer measures the real glyphs.
      const length = shape.text.length * shape.size * 0.6;
      const along =
        shape.align === "left"
          ? [0, length]
          : shape.align === "right"
            ? [-length, 0]
            : [-length / 2, length / 2];
      const across =
        shape.baseline === "top"
          ? [0, shape.size]
          : shape.baseline === "bottom"
            ? [-shape.size, 0]
            : [-shape.size / 2, shape.size / 2];
      const [a0 = 0, a1 = 0] = along;
      const [c0 = 0, c1 = 0] = across;
      return shape.vertical
        ? [
            { x: shape.at.x + c0, y: shape.at.y - a0 },
            { x: shape.at.x + c1, y: shape.at.y - a1 },
          ]
        : [
            { x: shape.at.x + a0, y: shape.at.y + c0 },
            { x: shape.at.x + a1, y: shape.at.y + c1 },
          ];
    }
  }
}

export function boxOfShapes(
  shapes: ReadonlyArray<Shape>,
  options?: { readonly text?: boolean },
): Box {
  const points: Array<Point> = [];
  let pad = 0;
  for (const shape of shapes) {
    if (shape.kind === "text" && options?.text === false) continue;
    points.push(...shapePoints(shape));
    if (shape.kind !== "text") pad = Math.max(pad, shape.width / 2);
  }
  return boxOfPoints(points, pad) ?? EMPTY_BOX;
}
