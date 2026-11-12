/**
 * Seating a part's 3D model on its footprint. JLC's converter places the VRML mesh but
 * leaves the STEP solid, the one a board model is built from, centred on itself.
 */
import { children, numbers, parseSexpr, value, type Sexpr } from "@t3tools/shared/kicad/sexpr";

export interface Extent {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

const extentOf = (points: ReadonlyArray<readonly [number, number]>): Extent | undefined =>
  points.length === 0
    ? undefined
    : {
        minX: Math.min(...points.map(([x]) => x)),
        maxX: Math.max(...points.map(([x]) => x)),
        minY: Math.min(...points.map(([, y]) => y)),
        maxY: Math.max(...points.map(([, y]) => y)),
      };

/** A model's extent from above, and how low it reaches. */
export interface Solid extends Extent {
  readonly minZ: number;
}

const solidOf = (points: ReadonlyArray<readonly [number, number, number]>): Solid | undefined => {
  const extent = extentOf(points.map(([x, y]) => [x, y] as const));
  return extent ? { ...extent, minZ: Math.min(...points.map(([, , z]) => z)) } : undefined;
};

/** A VRML model in millimetres; KiCad's VRML unit is a tenth of an inch. */
export function wrlExtent(text: string): Solid | undefined {
  const points: Array<readonly [number, number, number]> = [];
  for (const [, list = ""] of text.matchAll(/point\s*\[([^\]]*)\]/g)) {
    const values = (list.match(/-?\d+\.?\d*(?:e-?\d+)?/gi) ?? []).map(Number);
    for (let index = 0; index + 2 < values.length; index += 3) {
      points.push([
        (values[index] ?? 0) * 2.54,
        (values[index + 1] ?? 0) * 2.54,
        (values[index + 2] ?? 0) * 2.54,
      ]);
    }
  }
  return solidOf(points);
}

const STEP_POINT =
  /#(\d+)\s*=\s*CARTESIAN_POINT\s*\(\s*'[^']*'\s*,\s*\(\s*([^,)]+),\s*([^,)]+),\s*([^,)]+)\)/g;

/** A STEP solid by its vertices. Undefined for an assembly, whose parts are placed by transforms. */
export function stepExtent(text: string): Solid | undefined {
  if (/ITEM_DEFINED_TRANSFORMATION|NEXT_ASSEMBLY_USAGE_OCCURRENCE/.test(text)) return undefined;
  const places = new Map<string, readonly [number, number, number]>();
  for (const [, id = "", x, y, z] of text.matchAll(STEP_POINT)) {
    places.set(id, [Number(x), Number(y), Number(z)]);
  }
  const points: Array<readonly [number, number, number]> = [];
  for (const [, id = ""] of text.matchAll(/VERTEX_POINT\s*\(\s*'[^']*'\s*,\s*#(\d+)/g)) {
    const place = places.get(id);
    if (place && place.every(Number.isFinite)) points.push(place);
  }
  return solidOf(points);
}

const DRAWN = ["fp_line", "fp_rect", "fp_poly", "fp_arc", "fp_circle"];
const CORNERS = ["start", "end", "mid", "center"];

/** The part's body as the footprint draws it: its courtyard, else its silkscreen. */
function bodyExtent(footprint: Sexpr): Extent | undefined {
  for (const layer of ["F.CrtYd", "F.SilkS"]) {
    const points: Array<readonly [number, number]> = [];
    for (const kind of DRAWN) {
      for (const shape of children(footprint, kind)) {
        if (value(shape, "layer") !== layer) continue;
        const corners = [
          ...CORNERS.flatMap((name) => children(shape, name)),
          ...children(shape, "pts").flatMap((pts) => children(pts, "xy")),
        ];
        for (const corner of corners) {
          const [x, y] = numbers(corner);
          if (x !== undefined && y !== undefined) points.push([x, y]);
        }
      }
    }
    const extent = extentOf(points);
    if (extent) return extent;
  }
  return undefined;
}

/** Where the model lands on the footprint, whose y runs down, when turned by 0 or 180 degrees. */
const landed = (model: Extent, turned: boolean): Extent =>
  turned
    ? { minX: -model.maxX, maxX: -model.minX, minY: model.minY, maxY: model.maxY }
    : { minX: model.minX, maxX: model.maxX, minY: -model.maxY, maxY: -model.minY };

const MODEL_PLACE =
  /(\(model\s+"[^"]+)\.wrl("[\s\S]*?\(offset\s*\(xyz\s+)(\S+)\s+(\S+)\s+([^\s)]+)(\s*\)[\s\S]*?\(rotate\s*\(xyz\s+\S+\s+\S+\s+)(-?[\d.]+)/;

/** Under this, in millimetres, a model is taken to sit where it should. */
const OFF_CENTRE = 0.5;
const round = (value: number) => Math.round(value * 100) / 100;
/** Whether two lengths are the same thing measured twice: within a fifth, or a millimetre. */
const alike = (a: number, b: number) => Math.abs(a - b) <= Math.max(1, 0.2 * Math.max(a, b));
const middle = (extent: Extent) => ({
  x: (extent.minX + extent.maxX) / 2,
  y: (extent.minY + extent.maxY) / 2,
});

/** A model's two files: the mesh the converter placed, and the solid a board model uses. */
export interface ModelShapes {
  readonly wrl?: Solid | undefined;
  readonly step?: Solid | undefined;
}

/**
 * The footprint with its model seated: where the converter put the mesh, slid
 * onto the drawn body when it is that body's size but sits off it, and shown
 * by the STEP solid offset to land on the same spot. A model that is not the
 * converter's untouched mesh, or is turned sideways, is left as it came.
 */
export function seatModel(source: string, shapes: ModelShapes): string {
  const place = MODEL_PLACE.exec(source);
  const { wrl, step } = shapes;
  if (!place || !wrl) return source;
  const angle = Number(place[7]);
  const offset = { x: Number(place[3]), y: Number(place[4]), z: Number(place[5]) };
  if ((angle !== 0 && angle !== 180) || !Object.values(offset).every(Number.isFinite)) {
    return source;
  }
  // Where the mesh lands now; an offset is measured with y up, the footprint with y down.
  const sits = landed(wrl, angle === 180);
  const target = { x: middle(sits).x + offset.x, y: middle(sits).y - offset.y };
  let body: Extent | undefined;
  try {
    body = bodyExtent(parseSexpr(source));
  } catch {
    return source;
  }
  if (
    body &&
    alike(sits.maxX - sits.minX, body.maxX - body.minX) &&
    alike(sits.maxY - sits.minY, body.maxY - body.minY) &&
    Math.hypot(middle(body).x - target.x, middle(body).y - target.y) >= OFF_CENTRE
  ) {
    target.x = middle(body).x;
    target.y = middle(body).y;
  }
  const shown = step ?? wrl;
  const from = middle(landed(shown, angle === 180));
  const next = {
    x: round(target.x - from.x),
    y: round(from.y - target.y),
    z: round(wrl.minZ + offset.z - shown.minZ),
  };
  const moved = Math.hypot(next.x - offset.x, next.y - offset.y, next.z - offset.z) >= 0.01;
  if (!step && !moved) return source;
  return source.replace(
    MODEL_PLACE,
    `$1${step ? ".step" : ".wrl"}$2${next.x} ${next.y} ${next.z}$6$7`,
  );
}

/** The model a footprint shows, as the footprint names it. */
export function modelPath(source: string): string | undefined {
  return /\(model\s+"?([^"\s)]+)/.exec(source)?.[1];
}

/** Where the footprint that opens at `start` closes, minding quoted text. */
function blockEnd(source: string, start: number): number {
  let depth = 0;
  let quoted = false;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (char === "\\") index++;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return index + 1;
  }
  return source.length;
}

/** The models a board's footprints show, as the board names them. */
export function boardModelPaths(board: string): ReadonlyArray<string> {
  return [
    ...new Set([...board.matchAll(/\(model\s+"?([^"\s)]+)/g)].map((match) => match[1] ?? "")),
  ];
}

/** A board with the models of its front-side parts seated, as `seatModel` does for a footprint. */
export function seatBoardModels(board: string, shapesOf: (model: string) => ModelShapes): string {
  let result = "";
  let cursor = 0;
  for (const match of board.matchAll(/\(footprint\s/g)) {
    const start = match.index;
    if (start < cursor) continue;
    const end = blockEnd(board, start);
    const block = board.slice(start, end);
    const model = modelPath(block);
    // A part on the back is stored mirrored, which this does not read.
    const front = !/^\(footprint\s+"[^"]*"\s*\(layer\s+"B\.Cu"\)/.test(block);
    result +=
      board.slice(cursor, start) + (model && front ? seatModel(block, shapesOf(model)) : block);
    cursor = end;
  }
  return result + board.slice(cursor);
}
