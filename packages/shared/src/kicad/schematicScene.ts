/**
 * Turns one `.kicad_sch` sheet into a drawable scene and resolves which wires,
 * labels and pins belong to the same net.
 */
import {
  boxOfPoints,
  boxOfShapes,
  EMPTY_BOX,
  type Point,
  type Scene,
  type SceneItem,
  type ScenePin,
  type Shape,
  type TextAlign,
  type TextBaseline,
  unionBoxes,
} from "./scene.ts";
import { atoms, child, children, flag, numbers, parseSexpr, type Sexpr, value } from "./sexpr.ts";

type List = ReadonlyArray<Sexpr>;

const WIRE_WIDTH = 0.1524;
const BUS_WIDTH = 0.3048;
const BODY_WIDTH = 0.1524;
const JUNCTION_RADIUS = 0.4572;
const NO_CONNECT_SIZE = 0.6096;
const TEXT_SIZE = 1.27;
const TEXT_GAP = 0.3;

export interface SubSheet {
  readonly name: string;
  readonly file: string;
}

export interface SchematicSheet {
  readonly scene: Scene;
  readonly title?: string;
  readonly subSheets: ReadonlyArray<SubSheet>;
}

/** A 2×2 matrix `[a, b, c, d]` mapping (x, y) to (a·x + b·y, c·x + d·y). */
type Matrix = readonly [number, number, number, number];

const apply = (m: Matrix, p: Point): Point => ({
  x: m[0] * p.x + m[1] * p.y,
  y: m[2] * p.x + m[3] * p.y,
});
const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
];
const add = (p: Point, q: Point): Point => ({ x: p.x + q.x, y: p.y + q.y });

/** Rotation that looks counter-clockwise on screen, where Y points down. */
function rotation(degrees: number): Matrix {
  const turns = ((Math.round(degrees / 90) % 4) + 4) % 4;
  return (
    [
      [1, 0, 0, 1],
      [0, 1, -1, 0],
      [-1, 0, 0, -1],
      [0, -1, 1, 0],
    ] as const
  )[turns] as Matrix;
}

/** Placement of a symbol: its library drawing is rotated first, then mirrored. */
function symbolMatrix(angle: number, mirror: string | undefined): Matrix {
  const mirrored: Matrix =
    mirror === "x" ? [1, 0, 0, -1] : mirror === "y" ? [-1, 0, 0, 1] : [1, 0, 0, 1];
  return multiply(mirrored, rotation(angle));
}

const pointOf = (node: List | undefined): Point => {
  const [x = 0, y = 0] = numbers(node);
  return { x, y };
};
const pointsOf = (node: List | undefined): ReadonlyArray<Point> =>
  children(child(node, "pts"), "xy").map(pointOf);
const strokeWidth = (node: List, fallback: number): number => {
  const width = numbers(child(child(node, "stroke"), "width"))[0];
  return width && width > 0 ? width : fallback;
};
const fontSize = (node: List | undefined): number =>
  numbers(child(child(child(node, "effects"), "font"), "size"))[0] ?? TEXT_SIZE;
const justify = (node: List | undefined): ReadonlyArray<string> =>
  atoms(child(child(node, "effects"), "justify"));
const hidden = (node: List | undefined): boolean =>
  flag(node, "hide") || flag(child(node, "effects"), "hide");
const text = (node: List, index: number): string => {
  const found = node[index];
  return typeof found === "string" ? found : "";
};

interface LibPin {
  readonly number: string;
  readonly name: string;
  readonly at: Point;
  readonly end: Point;
  readonly hidden: boolean;
  readonly powerInput: boolean;
  readonly nameSize: number;
  readonly numberSize: number;
}

interface LibSymbol {
  readonly power: boolean;
  readonly showNames: boolean;
  readonly showNumbers: boolean;
  readonly nameOffset: number;
  /** Drawing per unit; unit 0 is shared by every unit. */
  readonly units: ReadonlyMap<
    number,
    { readonly shapes: ReadonlyArray<Shape>; readonly pins: ReadonlyArray<LibPin> }
  >;
}

/** Library drawings use Y up; flipping Y here puts every shape in sheet orientation. */
const flip = (p: Point): Point => ({ x: p.x, y: -p.y });

function fillOf(node: List): string | undefined {
  const type = value(child(node, "fill"), "type");
  if (type === "outline") return "body";
  if (type === "background" || type === "color") return "body-fill";
  return undefined;
}

function libShapes(node: List): ReadonlyArray<Shape> {
  const shapes: Array<Shape> = [];
  for (const item of node) {
    if (!Array.isArray(item)) continue;
    const list = item as List;
    const width = strokeWidth(list, BODY_WIDTH);
    const fill = fillOf(list);
    switch (list[0]) {
      case "polyline": {
        const points = pointsOf(list).map(flip);
        shapes.push(
          fill
            ? { kind: "polygon", points, width, paint: "body", fill }
            : { kind: "line", points, width, paint: "body" },
        );
        break;
      }
      case "rectangle": {
        const start = flip(pointOf(child(list, "start")));
        const end = flip(pointOf(child(list, "end")));
        const points = [start, { x: end.x, y: start.y }, end, { x: start.x, y: end.y }];
        shapes.push({ kind: "polygon", points, width, paint: "body", ...(fill ? { fill } : {}) });
        break;
      }
      case "circle": {
        const radius = numbers(child(list, "radius"))[0] ?? 0;
        const center = flip(pointOf(child(list, "center")));
        shapes.push({
          kind: "circle",
          center,
          radius,
          width,
          paint: "body",
          ...(fill ? { fill } : {}),
        });
        break;
      }
      case "arc":
        shapes.push({
          kind: "arc",
          start: flip(pointOf(child(list, "start"))),
          mid: flip(pointOf(child(list, "mid"))),
          end: flip(pointOf(child(list, "end"))),
          width,
          paint: "body",
        });
        break;
      case "bezier":
        shapes.push({ kind: "line", points: pointsOf(list).map(flip), width, paint: "body" });
        break;
      case "text": {
        const [x = 0, y = 0, angle = 0] = numbers(child(list, "at"));
        shapes.push({
          kind: "text",
          at: flip({ x, y }),
          text: text(list, 1),
          size: fontSize(list),
          // Library text angles are in tenths of a degree.
          vertical: Math.abs(angle) === 900 || Math.abs(angle) === 90,
          align: "center",
          baseline: "middle",
          paint: "body",
        });
        break;
      }
    }
  }
  return shapes;
}

function libPins(node: List): ReadonlyArray<LibPin> {
  return children(node, "pin").map((pin) => {
    const [x = 0, y = 0, angle = 0] = numbers(child(pin, "at"));
    const length = numbers(child(pin, "length"))[0] ?? 0;
    const radians = (angle * Math.PI) / 180;
    const name = child(pin, "name");
    const number = child(pin, "number");
    return {
      number: number ? text(number, 1) : "",
      name: name ? text(name, 1) : "",
      at: flip({ x, y }),
      end: flip({ x: x + length * Math.cos(radians), y: y + length * Math.sin(radians) }),
      hidden: hidden(pin),
      powerInput: pin[1] === "power_in",
      nameSize: fontSize(name),
      numberSize: fontSize(number),
    };
  });
}

function readLibSymbol(node: List): LibSymbol {
  const units = new Map<number, { shapes: Array<Shape>; pins: Array<LibPin> }>();
  for (const sub of children(node, "symbol")) {
    // Sub-symbols are named `<name>_<unit>_<style>`; style 2 is the De Morgan alternative.
    const match = /_(\d+)_(\d+)$/.exec(text(sub, 1));
    if (!match || Number(match[2]) > 1) continue;
    const unit = Number(match[1]);
    const entry = units.get(unit) ?? { shapes: [], pins: [] };
    entry.shapes.push(...libShapes(sub));
    entry.pins.push(...libPins(sub));
    units.set(unit, entry);
  }
  const names = child(node, "pin_names");
  return {
    power: child(node, "power") !== undefined,
    showNames: !hidden(names),
    showNumbers: !hidden(child(node, "pin_numbers")),
    nameOffset: numbers(child(names, "offset"))[0] ?? 0.508,
    units,
  };
}

function moveShape(shape: Shape, matrix: Matrix, origin: Point): Shape {
  const move = (p: Point) => add(apply(matrix, p), origin);
  switch (shape.kind) {
    case "line":
    case "polygon":
      return { ...shape, points: shape.points.map(move) };
    case "circle":
      return { ...shape, center: move(shape.center) };
    case "arc":
      return { ...shape, start: move(shape.start), mid: move(shape.mid), end: move(shape.end) };
    case "text": {
      const swaps = matrix[0] === 0;
      return { ...shape, at: move(shape.at), vertical: shape.vertical !== swaps };
    }
  }
}

/** Name and number texts of one pin, placed the way KiCad does by default. */
function pinTexts(pin: LibPin, start: Point, end: Point, lib: LibSymbol): ReadonlyArray<Shape> {
  const shapes: Array<Shape> = [];
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  const vertical = Math.abs(dy) > Math.abs(dx);
  const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const inside = lib.nameOffset > 0 && length > 0;
  if (lib.showNames && pin.name && pin.name !== "~") {
    const forward = vertical ? dy < 0 : dx > 0;
    const at = inside
      ? { x: end.x + (dx / length) * lib.nameOffset, y: end.y + (dy / length) * lib.nameOffset }
      : vertical
        ? { x: mid.x - TEXT_GAP, y: mid.y }
        : { x: mid.x, y: mid.y - TEXT_GAP };
    shapes.push({
      kind: "text",
      at,
      text: pin.name,
      size: pin.nameSize,
      vertical,
      align: inside ? (forward ? "left" : "right") : "center",
      baseline: inside ? "middle" : "bottom",
      paint: "pin-name",
    });
  }
  if (lib.showNumbers && pin.number) {
    const above = inside || !lib.showNames;
    shapes.push({
      kind: "text",
      at: vertical
        ? { x: mid.x + (above ? -TEXT_GAP : TEXT_GAP), y: mid.y }
        : { x: mid.x, y: mid.y + (above ? -TEXT_GAP : TEXT_GAP) },
      text: pin.number,
      size: pin.numberSize,
      vertical,
      align: "center",
      baseline: above ? "bottom" : "top",
      paint: "pin-number",
    });
  }
  return shapes;
}

/**
 * A symbol field. KiCad stores the anchor where it is drawn, but the angle and
 * justification in the symbol's own frame, so both follow the placement.
 */
function fieldShape(property: List, matrix: Matrix, paint: string): Shape | undefined {
  const content = text(property, 2);
  if (!content || hidden(property)) return undefined;
  const [x = 0, y = 0, angle = 0] = numbers(child(property, "at"));
  const own = Math.abs(angle) === 90 || Math.abs(angle) === 270;
  const reading = apply(matrix, own ? { x: 0, y: -1 } : { x: 1, y: 0 });
  const down = apply(matrix, own ? { x: 1, y: 0 } : { x: 0, y: 1 });
  const vertical = Math.abs(reading.y) > Math.abs(reading.x);
  const readingKept = vertical ? reading.y < 0 : reading.x > 0;
  const downKept = vertical ? down.x > 0 : down.y > 0;
  const just = justify(property);
  const along: TextAlign = just.includes("left")
    ? "left"
    : just.includes("right")
      ? "right"
      : "center";
  const across: TextBaseline = just.includes("top")
    ? "top"
    : just.includes("bottom")
      ? "bottom"
      : "middle";
  const swapAlign: Record<TextAlign, TextAlign> = {
    left: "right",
    right: "left",
    center: "center",
  };
  const swapBaseline: Record<TextBaseline, TextBaseline> = {
    top: "bottom",
    bottom: "top",
    middle: "middle",
  };
  return {
    kind: "text",
    at: { x, y },
    text: content,
    size: fontSize(property),
    vertical,
    align: readingKept ? along : swapAlign[along],
    baseline: downKept ? across : swapBaseline[across],
    paint,
  };
}

const FIELD_PAINT: Readonly<Record<string, string>> = { Reference: "reference", Value: "value" };

function symbolItem(node: List, libs: ReadonlyMap<string, LibSymbol>): SceneItem | undefined {
  const libId = value(node, "lib_name") ?? value(node, "lib_id") ?? "";
  const lib = libs.get(libId) ?? libs.get(value(node, "lib_id") ?? "");
  const [x = 0, y = 0, angle = 0] = numbers(child(node, "at"));
  const origin = { x, y };
  const matrix = symbolMatrix(angle, value(node, "mirror"));
  const unit = numbers(child(node, "unit"))[0] ?? 1;
  const shapes: Array<Shape> = [];
  const pins: Array<ScenePin> = [];
  const facts: Array<readonly [string, string]> = [];
  let ref = "";
  let partValue = "";
  for (const property of children(node, "property")) {
    const name = text(property, 1);
    const content = text(property, 2);
    if (name === "Reference") ref = content;
    if (name === "Value") partValue = content;
    if (content && content !== "~" && name !== "Reference") facts.push([name, content]);
    const shape = fieldShape(property, matrix, FIELD_PAINT[name] ?? "field");
    if (shape) shapes.push(shape);
  }
  for (const key of [0, unit]) {
    const drawing = lib?.units.get(key);
    if (!drawing || !lib) continue;
    for (const shape of drawing.shapes) shapes.push(moveShape(shape, matrix, origin));
    for (const pin of drawing.pins) {
      const start = add(apply(matrix, pin.at), origin);
      const end = add(apply(matrix, pin.end), origin);
      pins.push({
        number: pin.number,
        name: pin.name,
        at: start,
        ...(pin.powerInput && lib.power
          ? { net: partValue }
          : pin.powerInput && pin.hidden
            ? { net: pin.name, floating: !ref.startsWith("#") }
            : {}),
      });
      if (pin.hidden) continue;
      shapes.push({ kind: "line", points: [start, end], width: BODY_WIDTH, paint: "pin" });
      shapes.push(...pinTexts(pin, start, end, lib));
    }
  }
  const body = boxOfShapes(shapes, { text: false });
  return {
    id: value(node, "uuid") ?? `${ref}@${x},${y}`,
    kind: "symbol",
    box: body === EMPTY_BOX ? { minX: x - 1, minY: y - 1, maxX: x + 1, maxY: y + 1 } : body,
    shapes,
    ref,
    value: partValue,
    title: lib?.power ? partValue : ref,
    facts,
    pins,
    ...(pins[0]?.net && ref.startsWith("#") ? { net: pins[0].net } : {}),
  };
}

/** Local labels sit just off the wire; angle picks the side the text grows to. */
function labelItem(node: List, kind: "label" | "global_label" | "hierarchical_label"): SceneItem {
  const [x = 0, y = 0, angle = 0] = numbers(child(node, "at"));
  const turns = ((Math.round(angle / 90) % 4) + 4) % 4;
  const vertical = turns === 1 || turns === 3;
  const forward = turns === 0 || turns === 1;
  const size = fontSize(node);
  const name = text(node, 1);
  const local = kind === "label";
  const shape = value(node, "shape");
  const frame =
    shape === "input" || shape === "output" || shape === "bidirectional"
      ? shape
      : ("passive" as const);
  // Framed labels leave room for the arrow tip between the wire and the text.
  const lead = local ? 0 : size * 0.6;
  const direction = forward ? 1 : -1;
  const at = local
    ? vertical
      ? { x: x - TEXT_GAP, y }
      : { x, y: y - TEXT_GAP }
    : vertical
      ? { x, y: y - lead * direction }
      : { x: x + lead * direction, y };
  const drawn: Shape = {
    kind: "text",
    at,
    text: name,
    size,
    vertical,
    align: forward ? "left" : "right",
    baseline: local ? "bottom" : "middle",
    paint: local ? "label" : kind === "global_label" ? "global-label" : "hier-label",
    ...(local ? {} : { frame }),
  };
  const box = boxOfShapes([drawn]);
  return {
    id: value(node, "uuid") ?? `${kind}:${name}@${x},${y}`,
    kind: "label",
    box: unionBoxes([box, { minX: x, minY: y, maxX: x, maxY: y }]) ?? box,
    shapes: [drawn],
    anchor: { x, y },
    net: name,
    title: name,
    facts: [
      ["Kind", local ? "Local label" : kind === "global_label" ? "Global label" : "Sheet label"],
    ],
  };
}

function sheetItem(node: List): { readonly item: SceneItem; readonly sub: SubSheet } {
  const at = pointOf(child(node, "at"));
  const [width = 0, height = 0] = numbers(child(node, "size"));
  const corners = [
    at,
    { x: at.x + width, y: at.y },
    { x: at.x + width, y: at.y + height },
    { x: at.x, y: at.y + height },
  ];
  const shapes: Array<Shape> = [
    { kind: "polygon", points: corners, width: BODY_WIDTH, paint: "sheet", fill: "sheet-fill" },
  ];
  let name = "";
  let file = "";
  for (const property of children(node, "property")) {
    const key = text(property, 1);
    if (key === "Sheetname" || key === "Sheet name") name = text(property, 2);
    if (key === "Sheetfile" || key === "Sheet file") file = text(property, 2);
    const shape = fieldShape(property, [1, 0, 0, 1], "sheet");
    if (shape) shapes.push(shape);
  }
  for (const pin of children(node, "pin")) {
    const [x = 0, y = 0, angle = 0] = numbers(child(pin, "at"));
    const turns = ((Math.round(angle / 90) % 4) + 4) % 4;
    // Sheet pins point outwards, so their text grows back into the sheet.
    shapes.push({
      kind: "text",
      at: { x, y },
      text: text(pin, 1),
      size: fontSize(pin),
      vertical: turns === 1 || turns === 3,
      align: turns === 0 || turns === 1 ? "right" : "left",
      baseline: "middle",
      paint: "hier-label",
    });
  }
  return {
    item: {
      id: value(node, "uuid") ?? `sheet:${name}`,
      kind: "sheet",
      box: boxOfPoints(corners) ?? EMPTY_BOX,
      shapes,
      title: name,
      facts: [["File", file]],
    },
    sub: { name, file },
  };
}

function graphicItem(node: List, index: number): SceneItem | undefined {
  const width = strokeWidth(node, BODY_WIDTH);
  let shape: Shape | undefined;
  switch (node[0]) {
    case "polyline":
      shape = { kind: "line", points: pointsOf(node), width, paint: "note" };
      break;
    case "rectangle": {
      const start = pointOf(child(node, "start"));
      const end = pointOf(child(node, "end"));
      const points = [start, { x: end.x, y: start.y }, end, { x: start.x, y: end.y }];
      shape = { kind: "polygon", points, width, paint: "note" };
      break;
    }
    case "circle":
      shape = {
        kind: "circle",
        center: pointOf(child(node, "center")),
        radius: numbers(child(node, "radius"))[0] ?? 0,
        width,
        paint: "note",
      };
      break;
    case "arc":
      shape = {
        kind: "arc",
        start: pointOf(child(node, "start")),
        mid: pointOf(child(node, "mid")),
        end: pointOf(child(node, "end")),
        width,
        paint: "note",
      };
      break;
    case "text": {
      const [x = 0, y = 0, angle = 0] = numbers(child(node, "at"));
      const just = justify(node);
      shape = {
        kind: "text",
        at: { x, y },
        text: text(node, 1),
        size: fontSize(node),
        vertical: Math.abs(angle) === 90 || Math.abs(angle) === 270,
        align: just.includes("left") ? "left" : just.includes("right") ? "right" : "center",
        baseline: just.includes("top") ? "top" : just.includes("bottom") ? "bottom" : "middle",
        paint: "note",
      };
      break;
    }
  }
  if (!shape) return undefined;
  return {
    id: value(node, "uuid") ?? `graphic:${index}`,
    kind: "graphic",
    box: boxOfShapes([shape]),
    shapes: [shape],
  };
}

/** The sub-sheets a schematic refers to, without building its drawing. */
export function schematicSubSheets(source: string): ReadonlyArray<SubSheet> {
  const root = parseSexpr(source);
  return children(root, "sheet")
    .map((sheet) => sheetItem(sheet).sub)
    .filter((sub) => sub.file !== "");
}

/** Parses one schematic sheet. Nets are resolved as part of it. */
export function buildSchematicScene(source: string): SchematicSheet {
  const root = parseSexpr(source);
  if (!Array.isArray(root) || root[0] !== "kicad_sch") {
    throw new Error("Not a KiCad schematic file.");
  }
  const libs = new Map<string, LibSymbol>();
  for (const lib of children(child(root, "lib_symbols"), "symbol")) {
    libs.set(text(lib, 1), readLibSymbol(lib));
  }
  const items: Array<SceneItem> = [];
  const subSheets: Array<SubSheet> = [];
  (root as List).forEach((entry, index) => {
    if (!Array.isArray(entry)) return;
    const node = entry as List;
    const head = node[0];
    switch (head) {
      case "wire":
      case "bus": {
        const points = pointsOf(node);
        const width = strokeWidth(node, head === "wire" ? WIRE_WIDTH : BUS_WIDTH);
        items.push({
          id: value(node, "uuid") ?? `${head}:${index}`,
          kind: "wire",
          box: boxOfPoints(points, width) ?? EMPTY_BOX,
          shapes: [{ kind: "line", points, width, paint: head }],
          title: head === "wire" ? "Wire" : "Bus",
        });
        break;
      }
      case "bus_entry": {
        const at = pointOf(child(node, "at"));
        const [dx = 0, dy = 0] = numbers(child(node, "size"));
        const points = [at, { x: at.x + dx, y: at.y + dy }];
        items.push({
          id: value(node, "uuid") ?? `entry:${index}`,
          kind: "wire",
          box: boxOfPoints(points, WIRE_WIDTH) ?? EMPTY_BOX,
          shapes: [{ kind: "line", points, width: WIRE_WIDTH, paint: "wire" }],
          title: "Bus entry",
        });
        break;
      }
      case "junction": {
        const center = pointOf(child(node, "at"));
        const diameter = numbers(child(node, "diameter"))[0];
        const radius = diameter && diameter > 0 ? diameter / 2 : JUNCTION_RADIUS;
        items.push({
          id: value(node, "uuid") ?? `junction:${index}`,
          kind: "junction",
          box: boxOfPoints([center], radius) ?? EMPTY_BOX,
          shapes: [
            { kind: "circle", center, radius, width: 0, paint: "junction", fill: "junction" },
          ],
          anchor: center,
        });
        break;
      }
      case "no_connect": {
        const { x, y } = pointOf(child(node, "at"));
        const s = NO_CONNECT_SIZE;
        items.push({
          id: value(node, "uuid") ?? `nc:${index}`,
          kind: "no-connect",
          box: { minX: x - s, minY: y - s, maxX: x + s, maxY: y + s },
          shapes: [
            {
              kind: "line",
              points: [
                { x: x - s, y: y - s },
                { x: x + s, y: y + s },
              ],
              width: WIRE_WIDTH,
              paint: "no-connect",
            },
            {
              kind: "line",
              points: [
                { x: x - s, y: y + s },
                { x: x + s, y: y - s },
              ],
              width: WIRE_WIDTH,
              paint: "no-connect",
            },
          ],
          title: "No connection",
        });
        break;
      }
      case "label":
      case "global_label":
      case "hierarchical_label":
        items.push(labelItem(node, head));
        break;
      case "symbol": {
        const item = symbolItem(node, libs);
        if (item) items.push(item);
        break;
      }
      case "sheet": {
        const { item, sub } = sheetItem(node);
        items.push(item);
        if (sub.file) subSheets.push(sub);
        break;
      }
      case "polyline":
      case "rectangle":
      case "circle":
      case "arc":
      case "text": {
        const item = graphicItem(node, index);
        if (item) items.push(item);
        break;
      }
    }
  });
  const title = value(child(root, "title_block"), "title");
  const scene: Scene = {
    kind: "schematic",
    items,
    bounds: unionBoxes(items.map((item) => item.box)) ?? EMPTY_BOX,
    layers: [],
  };
  connectSchematic(scene);
  return { scene, subSheets, ...(title ? { title } : {}) };
}

const key = (point: Point) => `${Math.round(point.x * 1000)},${Math.round(point.y * 1000)}`;

function onSegment(point: Point, a: Point, b: Point): boolean {
  const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
  if (Math.abs(cross) > 1e-3) return false;
  const dot = (point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y);
  return dot >= -1e-6 && dot <= (b.x - a.x) ** 2 + (b.y - a.y) ** 2 + 1e-6;
}

function touches(point: Point, line: ReadonlyArray<Point>): boolean {
  for (let index = 1; index < line.length; index++) {
    const a = line[index - 1];
    const b = line[index];
    if (a && b && onSegment(point, a, b)) return true;
  }
  return false;
}

/**
 * Groups wires, labels and pins that touch into nets and names each net after
 * its label or power symbol, falling back to `Net-(R1-1)` like KiCad does.
 */
function connectSchematic(scene: Scene): void {
  const parent: Array<number> = [];
  const find = (node: number): number => {
    let root = node;
    while (parent[root] !== root) root = parent[root] ?? root;
    while (parent[node] !== root) {
      const next = parent[node] ?? root;
      parent[node] = root;
      node = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };
  const make = () => parent.push(parent.length) - 1;

  const wires: Array<{ readonly node: number; readonly points: ReadonlyArray<Point> }> = [];
  const itemNode = new Map<SceneItem, number>();
  const pinNode = new Map<ScenePin, number>();
  const atPoint = new Map<string, number>();
  const named = new Map<string, number>();
  const names = new Map<number, string>();
  const fallback = new Map<number, string>();
  const touch = (point: Point, node: number) => {
    const existing = atPoint.get(key(point));
    if (existing === undefined) atPoint.set(key(point), node);
    else union(existing, node);
  };
  const name = (label: string, node: number) => {
    const existing = named.get(label);
    if (existing === undefined) named.set(label, node);
    else union(existing, node);
    names.set(node, label);
  };

  for (const item of scene.items) {
    if (item.kind === "wire") {
      const line = item.shapes[0];
      if (line?.kind !== "line") continue;
      const node = make();
      itemNode.set(item, node);
      wires.push({ node, points: line.points });
      for (const point of [line.points[0], line.points.at(-1)]) if (point) touch(point, node);
    } else if (item.kind === "junction" && item.anchor) {
      const node = make();
      itemNode.set(item, node);
      touch(item.anchor, node);
    } else if (item.kind === "symbol") {
      for (const pin of item.pins ?? []) {
        const node = make();
        pinNode.set(pin, node);
        if (!pin.floating) touch(pin.at, node);
        // A pin that already has a net is a power input: it names a global net.
        if (pin.net) name(pin.net, node);
        else if (item.ref && !fallback.has(node))
          fallback.set(node, `Net-(${item.ref}-${pin.number})`);
      }
    }
  }
  // A point lying anywhere on a wire joins it; crossing wires only join at a junction.
  for (const [at, node] of atPoint) {
    const [x = 0, y = 0] = at.split(",").map((part) => Number(part) / 1000);
    for (const wire of wires) if (touches({ x, y }, wire.points)) union(node, wire.node);
  }
  // Labels attach to whatever passes through their anchor and name that net.
  for (const item of scene.items) {
    if (item.kind !== "label" || !item.anchor) continue;
    const node = make();
    itemNode.set(item, node);
    const existing = atPoint.get(key(item.anchor));
    if (existing !== undefined) union(existing, node);
    for (const wire of wires) if (touches(item.anchor, wire.points)) union(node, wire.node);
    if (item.net) name(item.net, node);
  }

  const resolved = new Map<number, string>();
  for (const [node, label] of names) if (!resolved.has(find(node))) resolved.set(find(node), label);
  for (const [node, label] of fallback)
    if (!resolved.has(find(node))) resolved.set(find(node), label);
  for (const [item, node] of itemNode) {
    const net = resolved.get(find(node));
    if (net) item.net = net;
  }
  for (const [pin, node] of pinNode) {
    const net = resolved.get(find(node));
    if (net) pin.net = net;
  }
}
