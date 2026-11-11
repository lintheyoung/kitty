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

/** Rough boxes of what is already on the sheet. */
function occupied(session: Session): ReadonlyArray<Box> {
  const boxes: Array<Box> = [...session.added];
  const cache = find(session.root, "lib_symbols") ?? [];
  for (const symbol of sheetSymbols(session.root)) {
    const libId = text(find(symbol, "lib_id")?.[1]);
    const library = all(cache, "symbol").find((entry) => text(entry[1]) === libId);
    const at = positionOf(symbol);
    const rotation = num(find(symbol, "at")?.[3]);
    boxes.push(
      shifted(
        library
          ? footprintBox(library, rotation, mirrorOf(symbol), {})
          : {
              minX: -STUB,
              minY: -STUB,
              maxX: STUB,
              maxY: STUB,
            },
        at,
      ),
    );
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
  const at = edit.at
    ? { x: snap(edit.at.x), y: snap(edit.at.y) }
    : freeSpot(box, occupied(session));
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
  const reference = referenceOf(part);
  const libId = text(find(part, "lib_id")?.[1]);
  const nets = detach(session, pinsOfPart(session, part));
  const before = find(part, "at") ?? [];
  const from = positionOf(part);
  const fromRotation = num(before[3]);
  const at = edit.at
    ? { x: snap(edit.at.x), y: snap(edit.at.y) }
    : { x: from.x + (edit.by?.x ?? 0), y: from.y + (edit.by?.y ?? 0) };
  const rotation = turns(edit.rotation ?? fromRotation + (edit.rotateBy ?? 0)) * 90;
  const mirror = edit.mirror ?? mirrorOf(part);
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
  connectPins(session, placedPins(library, at, rotation, mirror), reference, nets, []);
  placed.push({ reference, symbol: libId, at, rotation, nets });
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
      case "set":
        setProperty(session, edit);
        summary.push(`Set ${edit.reference} ${edit.property.trim()} to ${edit.value}`);
        break;
    }
  }
  return { source: printDoc(root), placed, removed, summary };
}
