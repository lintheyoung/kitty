/** Seating a part's 3D model on its footprint: JLC's converter sometimes leaves it beside its body. */
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

/** A VRML model's size seen from above, in millimetres; KiCad's VRML unit is a tenth of an inch. */
export function wrlExtent(text: string): Extent | undefined {
  const points: Array<readonly [number, number]> = [];
  for (const [, list = ""] of text.matchAll(/point\s*\[([^\]]*)\]/g)) {
    const values = (list.match(/-?\d+\.?\d*(?:e-?\d+)?/gi) ?? []).map(Number);
    for (let index = 0; index + 2 < values.length; index += 3) {
      points.push([(values[index] ?? 0) * 2.54, (values[index + 1] ?? 0) * 2.54]);
    }
  }
  return extentOf(points);
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
  /(\(model\s[\s\S]*?\(offset\s*\(xyz\s+)(\S+)\s+(\S+)(\s+\S+\s*\)[\s\S]*?\(rotate\s*\(xyz\s+\S+\s+\S+\s+)(-?[\d.]+)/;

/** Under this, in millimetres, a model is taken to sit where it should. */
const OFF_CENTRE = 0.5;
const round = (value: number) => Math.round(value * 100) / 100;
/** Whether two lengths are the same thing measured twice: within a fifth, or a millimetre. */
const alike = (a: number, b: number) => Math.abs(a - b) <= Math.max(1, 0.2 * Math.max(a, b));

/**
 * The footprint with its model slid onto the drawn body, when the model is the
 * size of that body but sits off it. Anything less clear is left as it came.
 */
export function seatModel(source: string, model: Extent | undefined): string {
  const place = MODEL_PLACE.exec(source);
  if (!place || !model) return source;
  const angle = Number(place[5]);
  if ((angle !== 0 && angle !== 180) || Number(place[2]) !== 0 || Number(place[3]) !== 0) {
    return source;
  }
  let body: Extent | undefined;
  try {
    body = bodyExtent(parseSexpr(source));
  } catch {
    return source;
  }
  if (!body) return source;
  const sits = landed(model, angle === 180);
  if (
    !alike(sits.maxX - sits.minX, body.maxX - body.minX) ||
    !alike(sits.maxY - sits.minY, body.maxY - body.minY)
  ) {
    return source;
  }
  const dx = (body.minX + body.maxX - sits.minX - sits.maxX) / 2;
  const dy = (body.minY + body.maxY - sits.minY - sits.maxY) / 2;
  if (Math.hypot(dx, dy) < OFF_CENTRE) return source;
  // A model's offset is measured with y up, the footprint's drawing with y down.
  return source.replace(MODEL_PLACE, `$1${round(dx)} ${round(-dy)}$4$5`);
}

/** The model a footprint shows, as the footprint names it. */
export function modelPath(source: string): string | undefined {
  return /\(model\s+"?([^"\s)]+)/.exec(source)?.[1];
}
