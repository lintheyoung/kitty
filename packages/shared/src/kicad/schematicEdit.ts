/**
 * Edits to a KiCad schematic, applied to the file's lossless tree: placing
 * parts, connecting their pins by name, wires, labels, moving and removing.
 */
import * as Schema from "effect/Schema";

import type { Box, Point } from "./scene.ts";
import { type Node, numeric, parseDoc, printDoc, quoted, unquoted } from "./sexprDoc.ts";

export type Mirror = "x" | "y";

export type SchematicEdit =
  | {
      readonly op: "place";
      /** Library id: `jlc:AMS1117-3.3` or `power:GND`. */
      readonly symbol: string;
      /** Where the symbol's origin goes; a free spot is found when omitted. */
      readonly at?: Point | undefined;
      readonly rotation?: number | undefined;
      readonly mirror?: Mirror | undefined;
      readonly reference?: string | undefined;
      readonly value?: string | undefined;
      /** The block the part belongs to ("Power", "USB"); parts of a block are kept together. */
      readonly group?: string | undefined;
      /** Net for each pin number: a short wire and a label or power symbol. */
      readonly nets?: Readonly<Record<string, string>> | undefined;
      /** Pin numbers that are left unconnected on purpose. */
      readonly noConnect?: ReadonlyArray<string> | undefined;
      /** Mark every pin without a net as unconnected on purpose. */
      readonly noConnectRest?: boolean | undefined;
    }
  | {
      readonly op: "connect";
      readonly reference: string;
      readonly nets?: Readonly<Record<string, string>> | undefined;
      readonly noConnect?: ReadonlyArray<string> | undefined;
    }
  | { readonly op: "wire"; readonly points: ReadonlyArray<Point> }
  | {
      readonly op: "label";
      readonly net: string;
      readonly at: Point;
      readonly rotation?: number | undefined;
    }
  | { readonly op: "junction"; readonly at: Point }
  | { readonly op: "no_connect"; readonly at: Point }
  | {
      readonly op: "move";
      readonly reference: string;
      /** Where the part goes; or `by`, how far it moves from where it is. */
      readonly at?: Point | undefined;
      readonly by?: Point | undefined;
      /** Turn the part this many degrees counter-clockwise from how it sits. */
      readonly rotateBy?: number | undefined;
      readonly rotation?: number | undefined;
      readonly mirror?: Mirror | undefined;
    }
  | { readonly op: "remove"; readonly reference: string }
  /** Removes a wire, label, junction or no-connect mark by its id. */
  | { readonly op: "erase"; readonly id: string }
  /** Lays the sheet out again: blocks framed and in order, parts on a grid. */
  | { readonly op: "tidy" }
  | {
      readonly op: "set";
      readonly reference: string;
      readonly property: string;
      readonly value: string;
    };

export interface EditContext {
  /** The project name the symbol instances are recorded under. */
  readonly project: string;
  /** A library symbol by id, or undefined when the library has no such symbol. */
  readonly symbol: (libId: string) => ReadonlyArray<Node> | undefined;
  readonly uuid: () => string;
}

export interface PlacedPart {
  readonly reference: string;
  readonly symbol: string;
  readonly at: Point;
  readonly rotation: number;
  /** Nets asked for on this part's pins, by pin number. */
  readonly nets: Readonly<Record<string, string>>;
}

export interface EditResult {
  readonly source: string;
  /** Parts placed or moved by these edits. */
  readonly placed: ReadonlyArray<PlacedPart>;
  readonly removed: ReadonlyArray<string>;
  /** What each edit did, in plain words, for the design's change log. */
  readonly summary: ReadonlyArray<string>;
}

/** An edit that cannot be applied; the message says what to do instead. */
export class SchematicEditError extends Schema.TaggedError<SchematicEditError>()(
  "SchematicEditError",
  { message: Schema.String },
) {}
const refuse = (message: string) => new SchematicEditError({ message });

const GRID = 1.27;
const STUB = 5.08;
const TEXT = 1.27;
// The drawing area of an A4 sheet, clear of the frame and the title block.
const PAGE: Box = { minX: 25.4, minY: 25.4, maxX: 270, maxY: 160 };
const SPACING = 5.08;
/** The symbol field that names the block a part belongs to. */
const GROUP_PROPERTY = "Group";
/** Clear space kept between one block and the next. */
const GROUP_GAP = 25.4;
const TITLE = 2.54;

type List = Array<Node>;
const isList = (node: Node | undefined): node is List => Array.isArray(node);
const head = (node: Node | undefined) =>
  isList(node) && typeof node[0] === "string" ? node[0] : "";
const text = (node: Node | undefined) => (typeof node === "string" ? unquoted(node) : "");
const find = (list: ReadonlyArray<Node>, name: string) =>
  list.find((entry): entry is List => head(entry) === name);
const all = (list: ReadonlyArray<Node>, name: string) =>
  list.filter((entry): entry is List => head(entry) === name);
const num = (node: Node | undefined) => (typeof node === "string" ? Number(node) || 0 : 0);
const clone = (node: Node): Node => (isList(node) ? node.map(clone) : node);
const snap = (value: number) => Math.round(Math.round(value / GRID) * GRID * 1e4) / 1e4;
const same = (a: Point, b: Point) => Math.abs(a.x - b.x) < 1e-3 && Math.abs(a.y - b.y) < 1e-3;
const xy = (point: Point): List => ["xy", numeric(point.x), numeric(point.y)];
const turns = (degrees: number) => ((Math.round(degrees / 90) % 4) + 4) % 4;

/** Library point (Y up) to sheet offset: rotated counter-clockwise, then mirrored. */
function orient(point: Point, rotation: number, mirror: Mirror | undefined): Point {
  const flipped = { x: point.x, y: -point.y };
  const rotated = [
    flipped,
    { x: flipped.y, y: -flipped.x },
    { x: -flipped.x, y: -flipped.y },
    { x: -flipped.y, y: flipped.x },
  ][turns(rotation)] as Point;
  return mirror === "x"
    ? { x: rotated.x, y: -rotated.y }
    : mirror === "y"
      ? { x: -rotated.x, y: rotated.y }
      : rotated;
}

interface Pin {
  readonly number: string;
  readonly name: string;
  /** Where a wire attaches, on the sheet. */
  readonly at: Point;
  /** Unit vector pointing away from the symbol body. */
  readonly out: Point;
}

/** Pins of unit 1 of a library symbol, in library coordinates. */
function libraryPins(library: ReadonlyArray<Node>) {
  const pins: Array<{ number: string; name: string; at: Point; angle: number }> = [];
  for (const unit of all(library, "symbol")) {
    const match = /_(\d+)_(\d+)$/.exec(text(unit[1]));
    if (match && ((match[1] !== "0" && match[1] !== "1") || Number(match[2]) > 1)) continue;
    for (const pin of all(unit, "pin")) {
      const at = find(pin, "at") ?? [];
      pins.push({
        number: text(find(pin, "number")?.[1]),
        name: text(find(pin, "name")?.[1]),
        at: { x: num(at[1]), y: num(at[2]) },
        angle: num(at[3]),
      });
    }
  }
  return pins;
}

function placedPins(
  library: ReadonlyArray<Node>,
  origin: Point,
  rotation: number,
  mirror: Mirror | undefined,
): ReadonlyArray<Pin> {
  return libraryPins(library).map((pin) => {
    const offset = orient(pin.at, rotation, mirror);
    const radians = (pin.angle * Math.PI) / 180;
    // The pin is drawn from its end towards the body, so away is the other way.
    const away = orient({ x: -Math.cos(radians), y: -Math.sin(radians) }, rotation, mirror);
    return {
      number: pin.number,
      name: pin.name,
      at: { x: origin.x + offset.x, y: origin.y + offset.y },
      out: { x: Math.round(away.x), y: Math.round(away.y) },
    };
  });
}

const propertyOf = (symbol: ReadonlyArray<Node>, name: string) =>
  all(symbol, "property").find((property) => text(property[1]) === name);
const referenceOf = (symbol: ReadonlyArray<Node>) => text(propertyOf(symbol, "Reference")?.[2]);
const mirrorOf = (symbol: ReadonlyArray<Node>): Mirror | undefined => {
  const value = text(find(symbol, "mirror")?.[1]);
  return value === "x" || value === "y" ? value : undefined;
};
const positionOf = (node: ReadonlyArray<Node>): Point => {
  const at = find(node, "at") ?? [];
  return { x: num(at[1]), y: num(at[2]) };
};

/** Rotation that turns a power symbol's drawing to point along `out`. */
function powerRotation(library: ReadonlyArray<Node>, out: Point): number {
  const value = find(propertyOf(library, "Value") ?? [], "at");
  // Ground symbols hang below their pin; supply symbols stand above it.
  const natural = { x: 0, y: num(value?.[2]) < 0 ? -1 : 1 };
  for (const rotation of [0, 90, 180, 270]) {
    if (same(orient(natural, rotation, undefined), out)) return rotation;
  }
  return 0;
}

interface Session {
  readonly root: List;
  readonly context: EditContext;
  readonly sheetPath: string;
  /** Boxes of what the edits added, so later parts are placed clear of them. */
  readonly added: Array<Box>;
}

const sheetSymbols = (root: List) => all(root, "symbol");

function insert(session: Session, node: List): void {
  const at = session.root.findIndex((entry) => head(entry) === "sheet_instances");
  if (at < 0) session.root.push(node);
  else session.root.splice(at, 0, node);
}

function removeNode(session: Session, node: Node): void {
  const at = session.root.indexOf(node);
  if (at >= 0) session.root.splice(at, 1);
}

/** The library symbol for `libId`, embedded in the sheet's `lib_symbols` if it was not. */
function embedded(session: Session, libId: string): List {
  let cache = find(session.root, "lib_symbols");
  if (!cache) {
    cache = ["lib_symbols"];
    insert(session, cache);
  }
  const existing = all(cache, "symbol").find((symbol) => text(symbol[1]) === libId);
  if (existing) return existing;
  const [library, name = ""] = libId.split(":");
  if (library !== "jlc" && library !== "power") {
    throw refuse(
      `${libId} is not a JLC part. Parts come from JLC: find one with jlc_part_search, import it with jlc_part_import and place the jlc: symbol it returns. Power symbols are power:GND, power:+3V3 and the like.`,
    );
  }
  const source = session.context.symbol(libId);
  if (!source) {
    throw refuse(
      library === "jlc"
        ? `${libId} is not in the design's JLC library. Import the part with jlc_part_import first.`
        : `KiCad has no power symbol named ${name}. Use a net label for this net instead.`,
    );
  }
  const copy = clone([...source]) as List;
  copy[1] = quoted(libId);
  cache.push(copy);
  return copy;
}

/** The next unused reference for a prefix: R3 after R1 and R2. */
function nextReference(session: Session, prefix: string): string {
  let highest = 0;
  for (const symbol of sheetSymbols(session.root)) {
    const reference = referenceOf(symbol);
    if (!reference.startsWith(prefix)) continue;
    const number = Number(reference.slice(prefix.length));
    if (Number.isInteger(number)) highest = Math.max(highest, number);
  }
  const next = String(highest + 1);
  return `${prefix}${prefix.startsWith("#") ? next.padStart(2, "0") : next}`;
}

function findPart(session: Session, reference: string): List {
  const wanted = reference.trim().toLowerCase();
  const part = sheetSymbols(session.root).find(
    (symbol) => referenceOf(symbol).toLowerCase() === wanted,
  );
  if (!part) {
    const known = sheetSymbols(session.root)
      .map(referenceOf)
      .filter((name) => !name.startsWith("#"));
    throw refuse(`No part ${reference} on this sheet. Parts: ${known.join(", ") || "none"}.`);
  }
  return part;
}

function addSymbolNode(
  session: Session,
  input: {
    readonly libId: string;
    readonly at: Point;
    readonly rotation: number;
    readonly mirror: Mirror | undefined;
    readonly reference: string;
    readonly value: string | undefined;
    readonly group?: string | undefined;
  },
): List {
  const library = embedded(session, input.libId);
  const flag = (name: string, fallback: string) => text(find(library, name)?.[1]) || fallback;
  const node: List = [
    "symbol",
    ["lib_id", quoted(input.libId)],
    ["at", numeric(input.at.x), numeric(input.at.y), String(turns(input.rotation) * 90)],
    ...(input.mirror ? [["mirror", input.mirror] as List] : []),
    ["unit", "1"],
    ["body_style", "1"],
    ["exclude_from_sim", flag("exclude_from_sim", "no")],
    ["in_bom", flag("in_bom", "yes")],
    ["on_board", flag("on_board", "yes")],
    ["in_pos_files", flag("in_pos_files", "yes")],
    ["dnp", "no"],
    ["uuid", quoted(session.context.uuid())],
  ];
  const sideways = turns(input.rotation) % 2 === 1;
  for (const property of all(library, "property")) {
    const name = text(property[1]);
    if (name.startsWith("ki_")) continue;
    const copy = clone(property) as List;
    if (name === "Reference") copy[2] = quoted(input.reference);
    if (name === "Value" && input.value !== undefined) copy[2] = quoted(input.value);
    const at = find(copy, "at");
    if (at) {
      const offset = orient({ x: num(at[1]), y: num(at[2]) }, input.rotation, input.mirror);
      at[1] = numeric(input.at.x + offset.x);
      at[2] = numeric(input.at.y + offset.y);
      // Text turns with the symbol, but never reads upside down.
      if (sideways) at[3] = num(at[3]) % 180 === 0 ? "90" : "0";
    }
    node.push(copy);
  }
  if (input.group) {
    // The block a part belongs to travels with it, out of sight.
    node.push([
      "property",
      quoted(GROUP_PROPERTY),
      quoted(input.group),
      ["at", numeric(input.at.x), numeric(input.at.y), "0"],
      ["hide", "yes"],
      ["effects", ["font", ["size", "1.27", "1.27"]]],
    ]);
  }
  const numbers = new Set(libraryPins(library).map((pin) => pin.number));
  for (const number of numbers) {
    node.push(["pin", quoted(number), ["uuid", quoted(session.context.uuid())]]);
  }
  node.push([
    "instances",
    [
      "project",
      quoted(session.context.project),
      ["path", quoted(session.sheetPath), ["reference", quoted(input.reference)], ["unit", "1"]],
    ],
  ]);
  insert(session, node);
  return node;
}

function addWire(session: Session, points: ReadonlyArray<Point>): void {
  for (let index = 1; index < points.length; index++) {
    const from = points[index - 1] as Point;
    const to = points[index] as Point;
    if (same(from, to)) continue;
    insert(session, [
      "wire",
      ["pts", xy(from), xy(to)],
      ["stroke", ["width", "0"], ["type", "default"]],
      ["uuid", quoted(session.context.uuid())],
    ]);
  }
}

function addLabel(session: Session, net: string, at: Point, rotation: number): void {
  const angle = turns(rotation) * 90;
  insert(session, [
    "label",
    quoted(net),
    ["at", numeric(at.x), numeric(at.y), String(angle)],
    [
      "effects",
      ["font", ["size", numeric(TEXT), numeric(TEXT)]],
      ["justify", angle === 180 || angle === 270 ? "right" : "left", "bottom"],
    ],
    ["uuid", quoted(session.context.uuid())],
  ]);
}

/** Connects a pin to a net: a short wire ending in a power symbol or a label. */
function connectPin(session: Session, pin: Pin, net: string): void {
  const end = { x: pin.at.x + pin.out.x * STUB, y: pin.at.y + pin.out.y * STUB };
  addWire(session, [pin.at, end]);
  const power = `power:${net}`;
  if (
    session.context.symbol(power) ||
    find(session.root, "lib_symbols")?.some((entry) => isList(entry) && text(entry[1]) === power)
  ) {
    const library = embedded(session, power);
    addSymbolNode(session, {
      libId: power,
      at: end,
      rotation: powerRotation(library, pin.out),
      mirror: undefined,
      reference: nextReference(session, text(propertyOf(library, "Reference")?.[2]) || "#PWR"),
      value: undefined,
    });
    return;
  }
  const rotation = pin.out.x > 0 ? 0 : pin.out.x < 0 ? 180 : pin.out.y < 0 ? 90 : 270;
  addLabel(session, net, end, rotation);
}

function connectPins(
  session: Session,
  pins: ReadonlyArray<Pin>,
  reference: string,
  nets: Readonly<Record<string, string>>,
  noConnect: ReadonlyArray<string>,
): void {
  const known = () => pins.map((pin) => `${pin.number} (${pin.name})`).join(", ");
  for (const [number, net] of Object.entries(nets)) {
    const matches = pins.filter((pin) => pin.number === number);
    if (matches.length === 0) {
      throw refuse(`${reference} has no pin ${number}. Its pins: ${known()}.`);
    }
    if (net.trim() === "") continue;
    for (const pin of matches) connectPin(session, pin, net.trim());
  }
  for (const number of noConnect) {
    const matches = pins.filter((pin) => pin.number === number);
    if (matches.length === 0) {
      throw refuse(`${reference} has no pin ${number}. Its pins: ${known()}.`);
    }
    for (const pin of matches) {
      insert(session, [
        "no_connect",
        ["at", numeric(pin.at.x), numeric(pin.at.y)],
        ["uuid", quoted(session.context.uuid())],
      ]);
    }
  }
}

/** Corner points of a library symbol's drawing and visible fields, in library coordinates. */
function libraryOutline(library: ReadonlyArray<Node>): ReadonlyArray<Point> {
  const points: Array<Point> = [];
  const point = (node: List | undefined) => ({ x: num(node?.[1]), y: num(node?.[2]) });
  for (const unit of all(library, "symbol")) {
    for (const shape of unit.filter(isList)) {
      for (const corner of ["start", "end", "mid"]) {
        const at = find(shape, corner);
        if (at) points.push(point(at));
      }
      for (const at of all(find(shape, "pts") ?? [], "xy")) points.push(point(at));
      const center = find(shape, "center");
      if (center) {
        const radius = num(find(shape, "radius")?.[1]);
        const { x, y } = point(center);
        points.push({ x: x - radius, y: y - radius }, { x: x + radius, y: y + radius });
      }
    }
  }
  for (const property of all(library, "property")) {
    if (text(find(property, "hide")?.[1]) === "yes") continue;
    const at = point(find(property, "at"));
    const reach = (text(property[2]).length * TEXT) / 2;
    points.push({ x: at.x - reach, y: at.y - TEXT }, { x: at.x + reach, y: at.y + TEXT });
  }
  return points;
}

/** The area a part takes with its connections drawn, relative to its origin. */
function footprintBox(
  library: ReadonlyArray<Node>,
  rotation: number,
  mirror: Mirror | undefined,
  nets: Readonly<Record<string, string>>,
): Box {
  let box: Box = { minX: -STUB, minY: -STUB, maxX: STUB, maxY: STUB };
  const grow = (point: Point) => {
    box = {
      minX: Math.min(box.minX, point.x),
      minY: Math.min(box.minY, point.y),
      maxX: Math.max(box.maxX, point.x),
      maxY: Math.max(box.maxY, point.y),
    };
  };
  // The body and the fields can reach past the pins.
  for (const point of libraryOutline(library)) grow(orient(point, rotation, mirror));
  for (const pin of placedPins(library, { x: 0, y: 0 }, rotation, mirror)) {
    grow(pin.at);
    const net = nets[pin.number];
    if (!net) continue;
    // Room for the wire and the label or power symbol at its end.
    const reach = STUB + Math.max(net.length * TEXT * 0.9, 2 * STUB);
    grow({ x: pin.at.x + pin.out.x * reach, y: pin.at.y + pin.out.y * reach });
    const across = { x: Math.abs(pin.out.y) * STUB, y: Math.abs(pin.out.x) * STUB };
    grow({
      x: pin.at.x + pin.out.x * reach + across.x,
      y: pin.at.y + pin.out.y * reach + across.y,
    });
    grow({
      x: pin.at.x + pin.out.x * reach - across.x,
      y: pin.at.y + pin.out.y * reach - across.y,
    });
  }
  return box;
}

const shifted = (box: Box, by: Point): Box => ({
  minX: box.minX + by.x,
  minY: box.minY + by.y,
  maxX: box.maxX + by.x,
  maxY: box.maxY + by.y,
});
const overlaps = (a: Box, b: Box) =>
  a.minX < b.maxX + SPACING &&
  a.maxX + SPACING > b.minX &&
  a.minY < b.maxY + SPACING &&
  a.maxY + SPACING > b.minY;

/** The first spot, reading the sheet in rows, where `box` is clear of everything. */
function freeSpot(box: Box, taken: ReadonlyArray<Box>): Point {
  const step = 2 * GRID;
  for (let y = snap(PAGE.minY - box.minY); y + box.maxY <= PAGE.maxY; y += step) {
    for (let x = snap(PAGE.minX - box.minX); x + box.maxX <= PAGE.maxX; x += step) {
      const candidate = shifted(box, { x, y });
      if (!taken.some((other) => overlaps(candidate, other))) return { x: snap(x), y: snap(y) };
    }
  }
  throw refuse(
    "The sheet has no free space for this part. Remove parts or give a position with `at`.",
  );
}

/** How far apart two boxes are; 0 when they touch or overlap. */
const gap = (a: Box, b: Box) =>
  Math.max(0, a.minX - b.maxX, b.minX - a.maxX) + Math.max(0, a.minY - b.maxY, b.minY - a.maxY);
/**
 * A free spot for a part of a block: beside the block's other parts, or, for
 * the first part of a block, clear of the other blocks.
 */
function groupSpot(
  box: Box,
  taken: ReadonlyArray<Box>,
  own: Box | undefined,
  others: ReadonlyArray<Box>,
): Point {
  const step = 2 * GRID;
  let best: Point | undefined;
  let bestScore = Infinity;
  for (let y = snap(PAGE.minY - box.minY); y + box.maxY <= PAGE.maxY; y += step) {
    for (let x = snap(PAGE.minX - box.minX); x + box.maxX <= PAGE.maxX; x += step) {
      const candidate = shifted(box, { x, y });
      if (taken.some((other) => overlaps(candidate, other))) continue;
      const crowding = others.some((other) => gap(candidate, other) < GROUP_GAP) ? 1e6 : 0;
      const score = crowding + (own ? gap(candidate, own) : 0);
      if (score < bestScore) {
        bestScore = score;
        best = { x: snap(x), y: snap(y) };
      }
      // A new block takes the first clear spot, reading the sheet in rows.
      if (!own && score === 0) return best ?? { x: snap(x), y: snap(y) };
    }
  }
  if (best) return best;
  throw refuse(
    "The sheet has no free space for this part. Remove parts or give a position with `at`.",
  );
}

/** The area a placed symbol takes, without its connections. */
function symbolBox(session: Session, symbol: List): Box {
  const cache = find(session.root, "lib_symbols") ?? [];
  const libId = text(find(symbol, "lib_id")?.[1]);
  const library = all(cache, "symbol").find((entry) => text(entry[1]) === libId);
  const rotation = num(find(symbol, "at")?.[3]);
  return shifted(
    library
      ? footprintBox(library, rotation, mirrorOf(symbol), {})
      : { minX: -STUB, minY: -STUB, maxX: STUB, maxY: STUB },
    positionOf(symbol),
  );
}

/** The area each block's parts cover. */
function groupAreas(session: Session): Map<string, Box> {
  const areas = new Map<string, Box>();
  for (const symbol of sheetSymbols(session.root)) {
    const group = text(propertyOf(symbol, GROUP_PROPERTY)?.[2]);
    if (!group) continue;
    const box = symbolBox(session, symbol);
    const area = areas.get(group);
    areas.set(
      group,
      area
        ? {
            minX: Math.min(area.minX, box.minX),
            minY: Math.min(area.minY, box.minY),
            maxX: Math.max(area.maxX, box.maxX),
            maxY: Math.max(area.maxY, box.maxY),
          }
        : box,
    );
  }
  return areas;
}

/** The block's name written above its first part. */
function addGroupTitle(session: Session, group: string, box: Box): void {
  const at = { x: snap(box.minX), y: snap(box.minY - SPACING) };
  insert(session, [
    "text",
    quoted(group),
    ["exclude_from_sim", "no"],
    ["at", numeric(at.x), numeric(at.y), "0"],
    ["effects", ["font", ["size", numeric(TITLE), numeric(TITLE)]], ["justify", "left", "bottom"]],
    ["uuid", quoted(session.context.uuid())],
  ]);
}

/** Rough boxes of what is already on the sheet. */
function occupied(session: Session): ReadonlyArray<Box> {
  const boxes: Array<Box> = [...session.added];
  for (const symbol of sheetSymbols(session.root)) boxes.push(symbolBox(session, symbol));
  for (const note of all(session.root, "text")) {
    const at = positionOf(note);
    const size = num(find(find(find(note, "effects") ?? [], "font") ?? [], "size")?.[1]) || TEXT;
    boxes.push({
      minX: at.x,
      minY: at.y - size * 1.5,
      maxX: at.x + text(note[1]).length * size,
      maxY: at.y,
    });
  }
  for (const wire of all(session.root, "wire")) {
    const points = all(find(wire, "pts") ?? [], "xy").map((point) => ({
      x: num(point[1]),
      y: num(point[2]),
    }));
    const [a, b] = points;
    if (!a || !b) continue;
    boxes.push({
      minX: Math.min(a.x, b.x),
      minY: Math.min(a.y, b.y),
      maxX: Math.max(a.x, b.x),
      maxY: Math.max(a.y, b.y),
    });
  }
  for (const label of [...all(session.root, "label"), ...all(session.root, "global_label")]) {
    const at = positionOf(label);
    const reach = text(label[1]).length * TEXT;
    boxes.push({ minX: at.x - reach, minY: at.y - reach, maxX: at.x + reach, maxY: at.y + reach });
  }
  return boxes;
}

/**
 * Removes the short connections made for a part's pins and returns the net
 * each pin was on, so the part can be connected again somewhere else.
 */
function detach(session: Session, pins: ReadonlyArray<Pin>): Record<string, string> {
  const nets: Record<string, string> = {};
  for (const pin of pins) {
    for (const marker of all(session.root, "no_connect")) {
      if (same(positionOf(marker), pin.at)) removeNode(session, marker);
    }
    for (const wire of all(session.root, "wire")) {
      const [a, b] = ends(wire);
      if (!a || !b || (!same(a, pin.at) && !same(b, pin.at))) continue;
      const far = same(a, pin.at) ? b : a;
      const shared = all(session.root, "wire").some(
        (other) => other !== wire && ends(other).some((point) => same(point, far)),
      );
      if (shared) continue;
      const labels = all(session.root, "label").filter((label) => same(positionOf(label), far));
      const powers = sheetSymbols(session.root).filter(
        (symbol) =>
          text(find(symbol, "lib_id")?.[1]).startsWith("power:") && same(positionOf(symbol), far),
      );
      const net = text(labels[0]?.[1]) || text(propertyOf(powers[0] ?? [], "Value")?.[2]);
      if (!net) continue;
      nets[pin.number] = net;
      for (const node of [wire, ...labels, ...powers]) removeNode(session, node);
    }
  }
  return nets;
}

function pinsOfPart(session: Session, part: List): ReadonlyArray<Pin> {
  const libId = text(find(part, "lib_id")?.[1]);
  const library = all(find(session.root, "lib_symbols") ?? [], "symbol").find(
    (entry) => text(entry[1]) === libId,
  );
  if (!library) return [];
  return placedPins(library, positionOf(part), num(find(part, "at")?.[3]), mirrorOf(part));
}

function place(
  session: Session,
  edit: Extract<SchematicEdit, { op: "place" }>,
  placed: Array<PlacedPart>,
): void {
  const library = embedded(session, edit.symbol);
  const rotation = turns(edit.rotation ?? 0) * 90;
  const nets = edit.nets ?? {};
  const box = footprintBox(library, rotation, edit.mirror, nets);
  const group = edit.group?.trim() || undefined;
  const areas = groupAreas(session);
  const own = group ? areas.get(group) : undefined;
  // Room above the first part of a block for the block's name.
  const roomy = group && !own ? { ...box, minY: box.minY - SPACING - TITLE * 1.5 } : box;
  const at = edit.at
    ? { x: snap(edit.at.x), y: snap(edit.at.y) }
    : group
      ? groupSpot(
          roomy,
          occupied(session),
          own,
          [...areas].filter(([name]) => name !== group).map(([, area]) => area),
        )
      : freeSpot(box, occupied(session));
  if (group && !own) addGroupTitle(session, group, shifted(box, at));
  const prefix = (text(propertyOf(library, "Reference")?.[2]) || "U").replace(/[?\d]+$/, "") || "U";
  const reference = edit.reference?.trim() || nextReference(session, prefix);
  if (sheetSymbols(session.root).some((symbol) => referenceOf(symbol) === reference)) {
    throw refuse(
      `${reference} is already on the sheet. Leave out the reference to get the next free one.`,
    );
  }
  addSymbolNode(session, {
    libId: edit.symbol,
    at,
    rotation,
    mirror: edit.mirror,
    reference,
    value: edit.value,
    group,
  });
  const pins = placedPins(library, at, rotation, edit.mirror);
  const unused = edit.noConnectRest
    ? pins.map((pin) => pin.number).filter((number) => !nets[number]?.trim())
    : [];
  connectPins(session, pins, reference, nets, [...new Set([...(edit.noConnect ?? []), ...unused])]);
  session.added.push(shifted(box, at));
  placed.push({ reference, symbol: edit.symbol, at, rotation, nets });
}

function move(
  session: Session,
  edit: Extract<SchematicEdit, { op: "move" }>,
  placed: Array<PlacedPart>,
): void {
  const part = findPart(session, edit.reference);
  const pins = pinsOfPart(session, part);
  const unconnected = markedUnconnected(session, pins);
  const nets = detach(session, pins);
  const from = positionOf(part);
  const fromRotation = num(find(part, "at")?.[3]);
  const at = edit.at
    ? { x: snap(edit.at.x), y: snap(edit.at.y) }
    : { x: from.x + (edit.by?.x ?? 0), y: from.y + (edit.by?.y ?? 0) };
  const rotation = turns(edit.rotation ?? fromRotation + (edit.rotateBy ?? 0)) * 90;
  settle(session, part, at, rotation, edit.mirror ?? mirrorOf(part), nets, unconnected, placed);
}

/** The pins of a part that carry a no-connect mark. */
function markedUnconnected(session: Session, pins: ReadonlyArray<Pin>): ReadonlyArray<string> {
  const marks = all(session.root, "no_connect").map(positionOf);
  return pins.filter((pin) => marks.some((mark) => same(mark, pin.at))).map((pin) => pin.number);
}

/** Puts a detached part at its new place and connects its pins again. */
function settle(
  session: Session,
  part: List,
  at: Point,
  rotation: number,
  mirror: Mirror | undefined,
  nets: Readonly<Record<string, string>>,
  unconnected: ReadonlyArray<string>,
  placed: Array<PlacedPart>,
): void {
  const reference = referenceOf(part);
  const libId = text(find(part, "lib_id")?.[1]);
  const before = find(part, "at") ?? [];
  const from = positionOf(part);
  const fromRotation = num(before[3]);
  // Fields keep their place relative to the part when it only slides.
  const slides = rotation === fromRotation && mirror === mirrorOf(part);
  const library = embedded(session, libId);
  for (const property of all(part, "property")) {
    const position = find(property, "at");
    if (!position) continue;
    if (slides) {
      position[1] = numeric(num(position[1]) + at.x - from.x);
      position[2] = numeric(num(position[2]) + at.y - from.y);
      continue;
    }
    const original = find(propertyOf(library, text(property[1])) ?? [], "at");
    const offset = orient({ x: num(original?.[1]), y: num(original?.[2]) }, rotation, mirror);
    position[1] = numeric(at.x + offset.x);
    position[2] = numeric(at.y + offset.y);
    position[3] = (num(original?.[3]) % 180 === 0) === (rotation % 180 === 0) ? "0" : "90";
  }
  part[part.indexOf(before)] = ["at", numeric(at.x), numeric(at.y), String(rotation)];
  const mirrorNode = find(part, "mirror");
  if (mirror && mirrorNode) mirrorNode[1] = mirror;
  else if (mirror)
    part.splice(part.findIndex((entry) => head(entry) === "at") + 1, 0, ["mirror", mirror]);
  connectPins(session, placedPins(library, at, rotation, mirror), reference, nets, unconnected);
  placed.push({ reference, symbol: libId, at, rotation, nets });
}

/** What names the far end of a pin's short wire: its labels and power symbols. */
function namesAt(session: Session, point: Point): ReadonlyArray<List> {
  return [
    ...all(session.root, "label").filter((label) => same(positionOf(label), point)),
    ...sheetSymbols(session.root).filter(
      (symbol) =>
        text(find(symbol, "lib_id")?.[1]).startsWith("power:") &&
        referenceOf(symbol).startsWith("#PWR") &&
        same(positionOf(symbol), point),
    ),
  ];
}

/** The wires at a pin, each with the end away from it. */
function wiresAt(session: Session, pin: Pin): ReadonlyArray<{ wire: List; far: Point }> {
  return all(session.root, "wire").flatMap((wire) => {
    const [a, b] = ends(wire);
    if (!a || !b || (!same(a, pin.at) && !same(b, pin.at))) return [];
    return [{ wire, far: same(a, pin.at) ? b : a }];
  });
}

/** Whether a pin is wired by hand: by a wire that does not end in a label or power symbol. */
function drawnByHand(session: Session, pin: Pin): boolean {
  return (
    all(session.root, "wire").some((wire) => insideWire(pin.at, wire)) ||
    wiresAt(session, pin).some(({ far }) => namesAt(session, far).length === 0)
  );
}

/**
 * Takes a part's short wires off the sheet and returns the net of each pin.
 * Two parts may share the label where their short wires meet; it goes with the last of them.
 */
function unhook(session: Session, pins: ReadonlyArray<Pin>): Record<string, string> {
  const nets: Record<string, string> = {};
  for (const pin of pins) {
    for (const marker of all(session.root, "no_connect")) {
      if (same(positionOf(marker), pin.at)) removeNode(session, marker);
    }
    for (const { wire, far } of wiresAt(session, pin)) {
      const names = namesAt(session, far);
      const first = names[0];
      if (!first) continue;
      nets[pin.number] =
        head(first) === "label" ? text(first[1]) : text(propertyOf(first, "Value")?.[2]);
      removeNode(session, wire);
      const shared = all(session.root, "wire").some((other) =>
        ends(other).some((point) => same(point, far)),
      );
      if (!shared) for (const name of names) removeNode(session, name);
    }
  }
  return nets;
}

const GROUND = /^\/?[ADP]?GND|^\/?VSS/i;
const isRail = (session: Session, net: string) =>
  session.context.symbol(`power:${net}`) !== undefined ||
  (find(session.root, "lib_symbols")?.some(
    (entry) => isList(entry) && text(entry[1]) === `power:${net}`,
  ) ??
    false);

/**
 * How a two-pin part should stand: between a rail above and ground below when
 * it hangs off one, else lying flat with pin 1 on the left.
 */
function standing(
  session: Session,
  library: ReadonlyArray<Node>,
  mirror: Mirror | undefined,
  nets: Readonly<Record<string, string>>,
  rotation: number,
): number {
  const pins = placedPins(library, { x: 0, y: 0 }, 0, mirror);
  const [first, second] = pins;
  if (pins.length !== 2 || !first || !second) return rotation;
  const ground = pins.filter((pin) => GROUND.test(nets[pin.number] ?? ""));
  const rails = pins.filter(
    (pin) => !GROUND.test(nets[pin.number] ?? "") && isRail(session, nets[pin.number] ?? ""),
  );
  const down = ground.length === 1 ? ground[0] : undefined;
  const up = !down && rails.length === 1 ? rails[0] : undefined;
  for (const turn of [0, 90, 180, 270]) {
    const turned = placedPins(library, { x: 0, y: 0 }, turn, mirror);
    const out = (pin: Pin) => turned.find((other) => other.number === pin.number)?.out;
    if (down ? (out(down)?.y ?? 0) > 0 : up ? (out(up)?.y ?? 0) < 0 : (out(first)?.x ?? 0) < 0) {
      return turn;
    }
  }
  return rotation;
}

/** Which stage of the signal's way across the sheet a block belongs to: in, core, out. */
function stage(group: string): number {
  if (/usb|connector|input|jack|batter|charg|power|supply|regulat|ldo|buck|boost/i.test(group)) {
    return 0;
  }
  return /mcu|cpu|soc|core|processor|controller|esp32|stm32|module/i.test(group) ? 1 : 2;
}

const PAPERS: ReadonlyArray<readonly [string, number, number]> = [
  ["A4", 297, 210],
  ["A3", 420, 297],
  ["A2", 594, 420],
  ["A1", 841, 594],
];
/** Room kept clear inside the sheet's border, and above the title block at its foot. */
const SHEET_EDGE = 15.24;
const TITLE_BLOCK = 40.64;
const FRAME_MARGIN = 5.08;
const FRAME_GAP = 7.62;
const FRAME_STROKE = "0.1524";
const OTHER_BLOCK = "Other";
const naturally = new Intl.Collator("en", { numeric: true }).compare;

/**
 * Lays the sheet out: each block framed and named, blocks in columns from power in
 * to what the controller drives, big parts on a block's left and small ones in rows
 * beside them. Blocks with wires drawn by hand are left exactly as they are.
 */
function tidy(session: Session, placed: Array<PlacedPart>): ReadonlyArray<string> {
  interface Member {
    readonly part: List;
    readonly library: ReadonlyArray<Node>;
    readonly pins: ReadonlyArray<Pin>;
    readonly big: boolean;
  }
  const blocks = new Map<string, Array<Member>>();
  const supply = [...groupAreas(session).keys()].find((name) => /power|supply/i.test(name));
  for (const part of sheetSymbols(session.root)) {
    const reference = referenceOf(part);
    if (reference.startsWith("#PWR")) continue;
    const named = text(propertyOf(part, GROUP_PROPERTY)?.[2]);
    const group = named || (reference.startsWith("#FLG") && supply) || OTHER_BLOCK;
    const library = embedded(session, text(find(part, "lib_id")?.[1]));
    const pins = pinsOfPart(session, part);
    blocks.set(group, [
      ...(blocks.get(group) ?? []),
      { part, library, pins, big: pins.length > 3 },
    ]);
  }
  const kept = [...blocks].filter(([, members]) =>
    members.some((member) => member.pins.some((pin) => drawnByHand(session, pin))),
  );
  for (const [name] of kept) blocks.delete(name);
  if (blocks.size === 0) {
    throw refuse(
      "Every block has wires drawn by hand, and tidying would pull those apart. Nothing was moved.",
    );
  }

  // Everything comes off the sheet before anything goes back, so no part lands on another's wires.
  const names = new Set(blocks.keys());
  for (const node of session.root.slice()) {
    if (!isList(node)) continue;
    const stroke = find(node, "stroke") ?? [];
    const framed =
      head(node) === "rectangle" &&
      text(find(stroke, "type")?.[1]) === "dash" &&
      text(find(stroke, "width")?.[1]) === FRAME_STROKE;
    if (framed || (head(node) === "text" && names.has(text(node[1])))) removeNode(session, node);
  }
  const loose = new Map<List, { nets: Record<string, string>; open: ReadonlyArray<string> }>();
  for (const members of blocks.values()) {
    for (const { part, pins } of members) {
      const open = markedUnconnected(session, pins);
      loose.set(part, { nets: unhook(session, pins), open });
    }
  }

  // Each block on its own: big parts in a column, small ones in rows to their right.
  const laid = [...blocks].map(([name, members]) => {
    const sized = [...members]
      .sort((a, b) => naturally(referenceOf(a.part), referenceOf(b.part)))
      .map((member) => {
        const nets = loose.get(member.part)?.nets ?? {};
        const mirror = mirrorOf(member.part);
        const now = num(find(member.part, "at")?.[3]);
        const rotation = member.big ? now : standing(session, member.library, mirror, nets, now);
        return { ...member, rotation, box: footprintBox(member.library, rotation, mirror, nets) };
      });
    const big = sized.filter((member) => member.big).sort((a, b) => b.pins.length - a.pins.length);
    const small = sized.filter((member) => !member.big);
    const spots: Array<{ member: (typeof sized)[number]; x: number; y: number }> = [];
    let height = 0;
    let width = 0;
    for (const member of big) {
      spots.push({ member, x: -member.box.minX, y: height - member.box.minY });
      width = Math.max(width, member.box.maxX - member.box.minX);
      height += member.box.maxY - member.box.minY + 2 * SPACING;
    }
    height = Math.max(0, height - 2 * SPACING);
    if (small.length > 0) {
      const tallest = Math.max(...small.map(({ box }) => box.maxY - box.minY)) + SPACING;
      // As many rows as the big parts are tall, and never a row longer than four.
      const beside = big.length > 0 ? Math.floor((height + SPACING) / tallest) : 1;
      const rows = Math.min(small.length, Math.max(1, beside, Math.ceil(small.length / 4)));
      const columns = Math.ceil(small.length / rows);
      // Each column is as wide, and each row as tall, as the largest part in it.
      const widths = Array.from({ length: columns }, () => 0);
      const heights = Array.from({ length: Math.ceil(small.length / columns) }, () => 0);
      small.forEach(({ box }, index) => {
        const column = index % columns;
        const row = Math.floor(index / columns);
        widths[column] = Math.max(widths[column] ?? 0, box.maxX - box.minX);
        heights[row] = Math.max(heights[row] ?? 0, box.maxY - box.minY);
      });
      const before = (sizes: ReadonlyArray<number>, index: number) =>
        sizes.slice(0, index).reduce((sum, size) => sum + size + SPACING, 0);
      const left = big.length > 0 ? width + 2 * SPACING : 0;
      small.forEach((member, index) => {
        const column = index % columns;
        const slack = (widths[column] ?? 0) - (member.box.maxX - member.box.minX);
        spots.push({
          member,
          x: left + before(widths, column) + slack / 2 - member.box.minX,
          y: before(heights, Math.floor(index / columns)) - member.box.minY,
        });
      });
      width = left + before(widths, columns) - SPACING;
      height = Math.max(height, before(heights, heights.length) - SPACING);
    }
    return {
      name,
      spots,
      width: width + 2 * FRAME_MARGIN,
      height: height + 2 * FRAME_MARGIN + 2 * TITLE,
    };
  });
  const order = [...laid].sort((a, b) => stage(a.name) - stage(b.name));

  // What stays as drawn keeps the top of the sheet; the tidy blocks start below it.
  let top = SHEET_EDGE;
  for (const [, members] of kept) {
    for (const { part } of members) top = Math.max(top, symbolBox(session, part).maxY + GROUP_GAP);
  }
  // Columns from left to right, a new one for each stage and whenever one is full.
  const columnsOn = (sheetHeight: number) => {
    const bottom = sheetHeight - SHEET_EDGE - TITLE_BLOCK;
    const frames: Array<{ block: (typeof order)[number]; x: number; y: number }> = [];
    let x = SHEET_EDGE;
    let y = top;
    let wide = 0;
    let before: (typeof order)[number] | undefined;
    for (const block of order) {
      const full = y > top && y + block.height > bottom;
      if (before && (full || stage(before.name) !== stage(block.name))) {
        x += wide + FRAME_GAP;
        y = top;
        wide = 0;
      }
      frames.push({ block, x: snap(x), y: snap(y) });
      wide = Math.max(wide, block.width);
      y += block.height + FRAME_GAP;
      before = block;
    }
    return {
      frames,
      right: x + wide,
      bottom: Math.max(...frames.map(({ block, y: at }) => at + block.height)),
    };
  };
  const fitting = PAPERS.map(([paper, sheetWidth, sheetHeight]) => ({
    paper,
    ...columnsOn(sheetHeight),
    fits: (layout: { right: number; bottom: number }) =>
      layout.right <= sheetWidth - SHEET_EDGE &&
      layout.bottom <= sheetHeight - SHEET_EDGE - TITLE_BLOCK,
  }));
  const chosen = fitting.find((layout) => layout.fits(layout)) ?? fitting.at(-1);
  if (!chosen) throw refuse("The sheet could not be laid out.");
  const paper = find(session.root, "paper");
  if (paper) paper[1] = quoted(chosen.paper);

  let count = 0;
  for (const { block, x, y } of chosen.frames) {
    insert(session, [
      "rectangle",
      ["start", numeric(x), numeric(y)],
      ["end", numeric(snap(x + block.width)), numeric(snap(y + block.height))],
      ["stroke", ["width", FRAME_STROKE], ["type", "dash"]],
      ["fill", ["type", "none"]],
      ["uuid", quoted(session.context.uuid())],
    ]);
    insert(session, [
      "text",
      quoted(block.name),
      ["exclude_from_sim", "no"],
      ["at", numeric(x + GRID), numeric(y + TITLE + GRID), "0"],
      [
        "effects",
        ["font", ["size", numeric(TITLE), numeric(TITLE)]],
        ["justify", "left", "bottom"],
      ],
      ["uuid", quoted(session.context.uuid())],
    ]);
    for (const { member, x: dx, y: dy } of block.spots) {
      const held = loose.get(member.part);
      settle(
        session,
        member.part,
        { x: snap(x + FRAME_MARGIN + dx), y: snap(y + FRAME_MARGIN + 2 * TITLE + dy) },
        member.rotation,
        mirrorOf(member.part),
        held?.nets ?? {},
        held?.open ?? [],
        placed,
      );
      count++;
    }
  }
  return [
    `Tidied the schematic: ${chosen.frames.length} blocks framed and set in order, ${count} parts aligned, on an ${chosen.paper} sheet`,
    ...(kept.length > 0
      ? [
          `Left ${kept.map(([name]) => name).join(", ")} as drawn: wires drawn by hand would be pulled apart`,
        ]
      : []),
  ];
}

const ERASABLE = new Set(["wire", "label", "global_label", "junction", "no_connect"]);
const ERASED_NAME: Readonly<Record<string, string>> = {
  wire: "a wire",
  label: "a label",
  global_label: "a label",
  junction: "a junction",
  no_connect: "a no-connect mark",
};

const ends = (wire: List) =>
  all(find(wire, "pts") ?? [], "xy").map((point) => ({ x: num(point[1]), y: num(point[2]) }));

/** True when `point` lies on a wire between its ends. */
function insideWire(point: Point, wire: List): boolean {
  const [a, b] = ends(wire);
  if (!a || !b || same(point, a) || same(point, b)) return false;
  const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
  if (Math.abs(cross) > 1e-3) return false;
  const along = (point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y);
  return along > 0 && along < (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
}

/** A wire that ends in the middle of another one only connects through a junction. */
function joinWire(session: Session, point: Point, before: ReadonlyArray<List>): void {
  if (!before.some((wire) => insideWire(point, wire))) return;
  if (all(session.root, "junction").some((junction) => same(positionOf(junction), point))) return;
  insert(session, [
    "junction",
    ["at", numeric(point.x), numeric(point.y)],
    ["diameter", "0"],
    ["color", "0", "0", "0", "0"],
    ["uuid", quoted(session.context.uuid())],
  ]);
}

/** A point in words: the pin that sits there, or its coordinates. */
function describePoint(session: Session, point: Point): string {
  for (const part of sheetSymbols(session.root)) {
    const reference = referenceOf(part);
    if (reference.startsWith("#")) continue;
    const pin = pinsOfPart(session, part).find((candidate) => same(candidate.at, point));
    if (pin) {
      // Passives name their pins by number, which adds nothing.
      const named = pin.name !== "" && pin.name !== "~" && pin.name !== pin.number;
      return `${reference} pin ${pin.number}${named ? ` (${pin.name})` : ""}`;
    }
  }
  return `(${numeric(point.x)}, ${numeric(point.y)})`;
}

function describeNets(
  reference: string,
  nets: Readonly<Record<string, string>>,
  noConnect: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return [
    ...Object.entries(nets).map(([pin, net]) =>
      net.trim() === ""
        ? `Disconnected ${reference} pin ${pin}`
        : `Connected ${reference} pin ${pin} to ${net.trim()}`,
    ),
    ...noConnect.map((pin) => `Marked ${reference} pin ${pin} as not connected`),
  ];
}

function setProperty(session: Session, edit: Extract<SchematicEdit, { op: "set" }>): void {
  const part = findPart(session, edit.reference);
  const name = edit.property.trim();
  if (name === "Reference") {
    const taken = sheetSymbols(session.root).some(
      (symbol) => symbol !== part && referenceOf(symbol) === edit.value,
    );
    if (taken) throw refuse(`${edit.value} is already on the sheet.`);
    for (const project of all(find(part, "instances") ?? [], "project")) {
      for (const sheet of all(project, "path")) {
        const reference = find(sheet, "reference");
        if (reference) reference[1] = quoted(edit.value);
      }
    }
  }
  const property = propertyOf(part, name);
  if (property) {
    property[2] = quoted(edit.value);
    return;
  }
  const at = positionOf(part);
  part.splice(
    part.findIndex((entry) => head(entry) === "pin" || head(entry) === "instances"),
    0,
    [
      "property",
      quoted(name),
      quoted(edit.value),
      ["at", numeric(at.x), numeric(at.y), "0"],
      ["hide", "yes"],
      ["effects", ["font", ["size", numeric(TEXT), numeric(TEXT)]]],
    ],
  );
}

/**
 * Applies `edits` in order to a schematic's text and returns the new text.
 * Throws SchematicEditError, leaving nothing half-applied, when an edit cannot be made.
 */
export function applySchematicEdits(
  source: string,
  edits: ReadonlyArray<SchematicEdit>,
  context: EditContext,
): EditResult {
  const root = parseDoc(source);
  if (!isList(root) || head(root) !== "kicad_sch") {
    throw refuse("This file is not a KiCad schematic.");
  }
  let sheet = find(root, "uuid");
  if (!sheet) {
    // A sheet KiCad has never saved has no id yet; parts are recorded under it.
    sheet = ["uuid", quoted(context.uuid())];
    root.splice(
      Math.max(
        root.findIndex((entry) => head(entry) === "paper"),
        1,
      ),
      0,
      sheet,
    );
  }
  const session: Session = {
    root,
    context,
    sheetPath: `/${text(sheet[1])}`,
    added: [],
  };
  const placed: Array<PlacedPart> = [];
  const removed: Array<string> = [];
  const summary: Array<string> = [];
  for (const edit of edits) {
    switch (edit.op) {
      case "place": {
        place(session, edit, placed);
        const part = placed.at(-1);
        const nets = Object.entries(edit.nets ?? {})
          .filter(([, net]) => net.trim() !== "")
          .map(([pin, net]) => `${pin}=${net.trim()}`);
        summary.push(
          `Placed ${part?.reference} (${edit.symbol}${edit.value ? `, ${edit.value}` : ""})${
            nets.length > 0 ? ` with pins ${nets.join(", ")}` : ""
          }`,
        );
        break;
      }
      case "erase": {
        const node = session.root.find(
          (entry): entry is List =>
            ERASABLE.has(head(entry)) && text(find(entry as List, "uuid")?.[1]) === edit.id,
        );
        if (!node) throw refuse("That item is no longer on the sheet.");
        const where = head(node) === "wire" ? ends(node)[0] : positionOf(node);
        removeNode(session, node);
        summary.push(
          `Removed ${ERASED_NAME[head(node)]}${
            head(node).endsWith("label") ? ` ${text(node[1])}` : ""
          } at ${describePoint(session, where ?? { x: 0, y: 0 })}`,
        );
        break;
      }
      case "wire":
        if (edit.points.length < 2) throw refuse("A wire needs two points or more.");
        {
          const before = all(session.root, "wire");
          const first = edit.points[0] as Point;
          const last = edit.points.at(-1) as Point;
          addWire(session, edit.points);
          joinWire(session, first, before);
          joinWire(session, last, before);
          summary.push(
            `Drew a wire from ${describePoint(session, first)} to ${describePoint(session, last)}`,
          );
        }
        break;
      case "label":
        if (edit.net.trim() === "") throw refuse("A label needs a net name.");
        addLabel(session, edit.net.trim(), edit.at, edit.rotation ?? 0);
        summary.push(`Added the label ${edit.net.trim()} at ${describePoint(session, edit.at)}`);
        break;
      case "junction":
        insert(session, [
          "junction",
          ["at", numeric(edit.at.x), numeric(edit.at.y)],
          ["diameter", "0"],
          ["color", "0", "0", "0", "0"],
          ["uuid", quoted(context.uuid())],
        ]);
        summary.push(`Added a junction at ${describePoint(session, edit.at)}`);
        break;
      case "no_connect":
        insert(session, [
          "no_connect",
          ["at", numeric(edit.at.x), numeric(edit.at.y)],
          ["uuid", quoted(context.uuid())],
        ]);
        summary.push(`Marked ${describePoint(session, edit.at)} as not connected`);
        break;
      case "move": {
        move(session, edit, placed);
        const part = placed.at(-1);
        const turned = edit.rotateBy !== undefined || edit.rotation !== undefined;
        const slid = edit.at !== undefined || edit.by !== undefined;
        summary.push(
          `${slid ? "Moved" : "Turned"} ${part?.reference}${
            slid ? ` to (${numeric(part?.at.x ?? 0)}, ${numeric(part?.at.y ?? 0)})` : ""
          }${turned ? `${slid ? ", turned" : ""} to ${part?.rotation} degrees` : ""}`,
        );
        break;
      }
      case "connect": {
        const part = findPart(session, edit.reference);
        const pins = pinsOfPart(session, part);
        const nets = edit.nets ?? {};
        const changed = new Set([...Object.keys(nets), ...(edit.noConnect ?? [])]);
        // A pin that is connected again loses the connection it had.
        detach(
          session,
          pins.filter((pin) => changed.has(pin.number)),
        );
        connectPins(session, pins, referenceOf(part), nets, edit.noConnect ?? []);
        summary.push(...describeNets(referenceOf(part), nets, edit.noConnect ?? []));
        placed.push({
          reference: referenceOf(part),
          symbol: text(find(part, "lib_id")?.[1]),
          at: positionOf(part),
          rotation: num(find(part, "at")?.[3]),
          nets,
        });
        break;
      }
      case "remove": {
        const part = findPart(session, edit.reference);
        detach(session, pinsOfPart(session, part));
        removeNode(session, part);
        removed.push(referenceOf(part));
        summary.push(`Removed ${referenceOf(part)} (${text(propertyOf(part, "Value")?.[2])})`);
        break;
      }
      case "tidy":
        summary.push(...tidy(session, placed));
        break;
      case "set":
        setProperty(session, edit);
        summary.push(`Set ${edit.reference} ${edit.property.trim()} to ${edit.value}`);
        break;
    }
  }
  return { source: printDoc(root), placed, removed, summary };
}
