/** Turns a `.kicad_pcb` board into a drawable scene. */
import {
  boxOfPoints,
  boxOfShapes,
  EMPTY_BOX,
  type Point,
  type Scene,
  type SceneItem,
  type Shape,
  unionBoxes,
} from "./scene.ts";
import { atoms, child, children, flag, numbers, parseSexpr, type Sexpr, value } from "./sexpr.ts";

type List = ReadonlyArray<Sexpr>;

/** Paint used by pads and vias that go through every copper layer. */
const THROUGH_PAINT = "through";
const VIA_PAINT = "via";
const HOLE_PAINT = "hole";
/** Paint used by areas that tracks and vias must stay out of. */
const KEEPOUT_PAINT = "keepout";

const DEFAULT_WIDTH = 0.1;
const TEXT_SIZE = 1;
const CORNER_STEPS = 4;

const pointOf = (node: List | undefined): Point => {
  const [x = 0, y = 0] = numbers(node);
  return { x, y };
};
const text = (node: List, index: number): string => {
  const found = node[index];
  return typeof found === "string" ? found : "";
};
const widthOf = (node: List): number => {
  const width =
    numbers(child(child(node, "stroke"), "width"))[0] ?? numbers(child(node, "width"))[0];
  return width && width > 0 ? width : DEFAULT_WIDTH;
};
const filled = (node: List): boolean => {
  const fill = value(node, "fill");
  return fill === "yes" || fill === "solid";
};

/** Rotation that looks counter-clockwise on screen, where Y points down. */
function rotate(point: Point, degrees: number): Point {
  if (degrees === 0) return point;
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: point.x * cos + point.y * sin, y: -point.x * sin + point.y * cos };
}

interface Frame {
  readonly at: Point;
  readonly angle: number;
}
const place = (frame: Frame, point: Point): Point => {
  const turned = rotate(point, frame.angle);
  return { x: frame.at.x + turned.x, y: frame.at.y + turned.y };
};
const WORLD: Frame = { at: { x: 0, y: 0 }, angle: 0 };

/** Outline of a rectangle with rounded corners, centred on the origin. */
function roundedRect(width: number, height: number, radius: number): ReadonlyArray<Point> {
  const hw = width / 2;
  const hh = height / 2;
  const r = Math.max(0, Math.min(radius, hw, hh));
  if (r === 0) {
    return [
      { x: -hw, y: -hh },
      { x: hw, y: -hh },
      { x: hw, y: hh },
      { x: -hw, y: hh },
    ];
  }
  const corners: ReadonlyArray<readonly [number, number, number]> = [
    [hw - r, -hh + r, -90],
    [hw - r, hh - r, 0],
    [-hw + r, hh - r, 90],
    [-hw + r, -hh + r, 180],
  ];
  const points: Array<Point> = [];
  for (const [cx, cy, start] of corners) {
    for (let step = 0; step <= CORNER_STEPS; step++) {
      const a = ((start + (90 * step) / CORNER_STEPS) * Math.PI) / 180;
      points.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    }
  }
  return points;
}

/** A drawn primitive (`gr_line`, `fp_rect`, …) on `paint`, placed by `frame`. */
function graphicShapes(node: List, frame: Frame, paint: string): ReadonlyArray<Shape> {
  const head = String(node[0]).replace(/^(gr|fp)_/, "");
  const width = widthOf(node);
  const fill = filled(node) ? { fill: paint } : {};
  switch (head) {
    case "line":
      return [
        {
          kind: "line",
          points: [
            place(frame, pointOf(child(node, "start"))),
            place(frame, pointOf(child(node, "end"))),
          ],
          width,
          paint,
        },
      ];
    case "rect": {
      const start = pointOf(child(node, "start"));
      const end = pointOf(child(node, "end"));
      const points = [start, { x: end.x, y: start.y }, end, { x: start.x, y: end.y }].map((point) =>
        place(frame, point),
      );
      return [{ kind: "polygon", points, width, paint, ...fill }];
    }
    case "circle": {
      const center = pointOf(child(node, "center"));
      const edge = pointOf(child(node, "end"));
      const radius = Math.hypot(edge.x - center.x, edge.y - center.y);
      return [{ kind: "circle", center: place(frame, center), radius, width, paint, ...fill }];
    }
    case "arc":
      return [
        {
          kind: "arc",
          start: place(frame, pointOf(child(node, "start"))),
          mid: place(frame, pointOf(child(node, "mid"))),
          end: place(frame, pointOf(child(node, "end"))),
          width,
          paint,
        },
      ];
    case "poly": {
      const points = children(child(node, "pts"), "xy").map((xy) => place(frame, pointOf(xy)));
      return [{ kind: "polygon", points, width, paint, ...fill }];
    }
    default:
      return [];
  }
}

/** Board text is kept readable: it reads left-to-right or bottom-to-top. */
function textShape(node: List, content: string, frame: Frame, paint: string): Shape | undefined {
  if (!content || flag(node, "hide") || flag(child(node, "effects"), "hide")) return undefined;
  const [x = 0, y = 0, angle = 0] = numbers(child(node, "at"));
  const just = atoms(child(child(node, "effects"), "justify"));
  const quarter = ((Math.round(angle / 90) % 2) + 2) % 2;
  return {
    kind: "text",
    at: place(frame, { x, y }),
    text: content,
    size: numbers(child(child(child(node, "effects"), "font"), "size"))[0] ?? TEXT_SIZE,
    vertical: quarter === 1,
    align: just.includes("left") ? "left" : just.includes("right") ? "right" : "center",
    baseline: just.includes("top") ? "top" : just.includes("bottom") ? "bottom" : "middle",
    paint,
  };
}

const COPPER = /\.Cu$/;

/** The copper paint of a pad: its single layer, or "through" when it spans the board. */
function padPaint(layers: ReadonlyArray<string>): string | undefined {
  const copper = layers.filter((layer) => COPPER.test(layer));
  if (copper.length === 0) return undefined;
  if (copper.length > 1 || copper[0] === "*.Cu") return THROUGH_PAINT;
  return copper[0];
}

function padItem(
  pad: List,
  frame: Frame,
  ref: string,
  netName: (node: List | undefined) => string | undefined,
  index: number,
): SceneItem | undefined {
  const [x = 0, y = 0, angle = 0] = numbers(child(pad, "at"));
  const [width = 0, height = 0] = numbers(child(pad, "size"));
  const center = place(frame, { x, y });
  const layers = atoms(child(pad, "layers"));
  const paint = padPaint(layers);
  const kind = text(pad, 3);
  const shapes: Array<Shape> = [];
  const outline = (points: ReadonlyArray<Point>): ReadonlyArray<Point> =>
    points.map((point) => {
      const turned = rotate(point, angle);
      return { x: center.x + turned.x, y: center.y + turned.y };
    });
  if (paint) {
    if (kind === "circle") {
      shapes.push({ kind: "circle", center, radius: width / 2, width: 0, paint, fill: paint });
    } else {
      const ratio = numbers(child(pad, "roundrect_rratio"))[0] ?? 0.25;
      const radius =
        kind === "oval"
          ? Math.min(width, height) / 2
          : kind === "roundrect"
            ? Math.min(width, height) * ratio
            : 0;
      shapes.push({
        kind: "polygon",
        points: outline(roundedRect(width, height, radius)),
        width: 0,
        paint,
        fill: paint,
      });
    }
    for (const primitive of child(pad, "primitives") ?? []) {
      if (!Array.isArray(primitive)) continue;
      for (const shape of graphicShapes(primitive as List, { at: center, angle }, paint)) {
        shapes.push(shape.kind === "polygon" ? { ...shape, fill: paint } : shape);
      }
    }
  }
  const drill = child(pad, "drill");
  const [drillWidth = 0, drillHeight = drillWidth] = numbers(drill);
  if (drillWidth > 0) {
    shapes.push(
      atoms(drill).includes("oval")
        ? {
            kind: "polygon",
            points: outline(
              roundedRect(drillWidth, drillHeight, Math.min(drillWidth, drillHeight) / 2),
            ),
            width: 0,
            paint: HOLE_PAINT,
            fill: HOLE_PAINT,
          }
        : {
            kind: "circle",
            center,
            radius: drillWidth / 2,
            width: 0,
            paint: HOLE_PAINT,
            fill: HOLE_PAINT,
          },
    );
  }
  if (shapes.length === 0) return undefined;
  const number = text(pad, 1);
  const net = netName(child(pad, "net"));
  const pinFunction = value(pad, "pinfunction");
  return {
    id: value(pad, "uuid") ?? `${ref}:${number}:${index}`,
    kind: "pad",
    box: boxOfShapes(shapes),
    shapes,
    ref,
    number,
    title: number ? `${ref} pad ${number}` : `${ref} hole`,
    ...(net ? { net } : {}),
    ...(paint && paint !== THROUGH_PAINT ? { layer: paint } : {}),
    facts: [
      ["Type", text(pad, 2).replaceAll("_", " ")],
      ...(pinFunction ? ([["Pin", pinFunction]] as const) : []),
    ],
  };
}

function footprintItems(
  node: List,
  netName: (node: List | undefined) => string | undefined,
): ReadonlyArray<SceneItem> {
  const [x = 0, y = 0, angle = 0] = numbers(child(node, "at"));
  const frame: Frame = { at: { x, y }, angle };
  const layer = value(node, "layer") ?? "F.Cu";
  const shapes: Array<Shape> = [];
  const facts: Array<readonly [string, string]> = [
    ["Footprint", text(node, 1)],
    ["Side", layer === "B.Cu" ? "Back" : "Front"],
  ];
  let ref = "";
  let partValue = "";
  for (const property of children(node, "property")) {
    const name = text(property, 1);
    const content = text(property, 2);
    if (name === "Reference") ref = content;
    if (name === "Value") partValue = content;
    if (content && content !== "~" && name !== "Reference" && name !== "Footprint")
      facts.push([name, content]);
    // Fields without a layer (filters, descriptions) are data, not drawings.
    const layer = value(property, "layer");
    const shape = layer ? textShape(property, content, frame, layer) : undefined;
    if (shape) shapes.push(shape);
  }
  for (const entry of node) {
    if (!Array.isArray(entry)) continue;
    const list = entry as List;
    const head = String(list[0]);
    if (head === "fp_text") {
      const content = text(list, 2).replace("${REFERENCE}", ref).replace("${VALUE}", partValue);
      // Legacy boards keep the reference and value as fp_text entries.
      if (list[1] === "reference" && !ref) ref = text(list, 2);
      if (list[1] === "value" && !partValue) partValue = text(list, 2);
      const shape = textShape(list, content, frame, value(list, "layer") ?? "F.SilkS");
      if (shape) shapes.push(shape);
    } else if (head.startsWith("fp_")) {
      shapes.push(...graphicShapes(list, frame, value(list, "layer") ?? "F.SilkS"));
    }
  }
  const pads = children(node, "pad")
    .map((pad, index) => padItem(pad, frame, ref, netName, index))
    .filter((pad): pad is SceneItem => pad !== undefined);
  // The body is what the courtyard or the pads cover; silkscreen text can sit far away.
  const courtyard = shapes.filter((shape) => shape.kind !== "text" && /CrtYd$/.test(shape.paint));
  const body =
    unionBoxes([
      ...(courtyard.length > 0 ? [boxOfShapes(courtyard)] : []),
      ...pads.map((pad) => pad.box),
    ]) ?? boxOfShapes(shapes, { text: false });
  const footprint: SceneItem = {
    id: value(node, "uuid") ?? `footprint:${ref}@${x},${y}`,
    kind: "footprint",
    box: body === EMPTY_BOX ? { minX: x - 1, minY: y - 1, maxX: x + 1, maxY: y + 1 } : body,
    shapes,
    ref,
    value: partValue,
    layer,
    title: ref,
    facts,
  };
  return [footprint, ...pads];
}

export function buildBoardScene(source: string): Scene {
  const root = parseSexpr(source);
  if (!Array.isArray(root) || root[0] !== "kicad_pcb") {
    throw new Error("Not a KiCad board file.");
  }
  const netNames = new Map<string, string>();
  for (const net of children(root, "net")) netNames.set(text(net, 1), text(net, 2));
  // Nets are written as `(net 3)`, `(net 3 "GND")` or `(net "GND")` depending on the version.
  const netName = (node: List | undefined): string | undefined => {
    const parts = atoms(node);
    const last = parts.at(-1);
    if (!last) return undefined;
    if (parts.length === 1 && /^\d+$/.test(last) && netNames.size > 0) {
      return netNames.get(last) || undefined;
    }
    return last;
  };
  const layers = (child(root, "layers") ?? [])
    .filter((entry): entry is List => Array.isArray(entry))
    .map((entry) => text(entry, 1));

  const items: Array<SceneItem> = [];
  (root as List).forEach((entry, index) => {
    if (!Array.isArray(entry)) return;
    const node = entry as List;
    const head = String(node[0]);
    switch (head) {
      case "footprint":
      case "module":
        items.push(...footprintItems(node, netName));
        break;
      case "segment":
      case "arc": {
        const layer = value(node, "layer") ?? "F.Cu";
        const width = widthOf(node);
        const start = pointOf(child(node, "start"));
        const end = pointOf(child(node, "end"));
        const shape: Shape =
          head === "arc"
            ? { kind: "arc", start, mid: pointOf(child(node, "mid")), end, width, paint: layer }
            : { kind: "line", points: [start, end], width, paint: layer };
        const net = netName(child(node, "net"));
        items.push({
          id: value(node, "uuid") ?? `track:${index}`,
          kind: "track",
          box: boxOfShapes([shape]),
          shapes: [shape],
          layer,
          title: "Track",
          ...(net ? { net } : {}),
          facts: [["Width", `${width} mm`]],
        });
        break;
      }
      case "via": {
        const center = pointOf(child(node, "at"));
        const size = numbers(child(node, "size"))[0] ?? 0.6;
        const drill = numbers(child(node, "drill"))[0] ?? 0.3;
        const net = netName(child(node, "net"));
        items.push({
          id: value(node, "uuid") ?? `via:${index}`,
          kind: "via",
          box: boxOfPoints([center], size / 2) ?? EMPTY_BOX,
          shapes: [
            {
              kind: "circle",
              center,
              radius: size / 2,
              width: 0,
              paint: VIA_PAINT,
              fill: VIA_PAINT,
            },
            {
              kind: "circle",
              center,
              radius: drill / 2,
              width: 0,
              paint: HOLE_PAINT,
              fill: HOLE_PAINT,
            },
          ],
          title: "Via",
          ...(net ? { net } : {}),
          facts: [
            ["Size", `${size} mm`],
            ["Drill", `${drill} mm`],
          ],
        });
        break;
      }
      case "zone": {
        const net = value(node, "net_name") || netName(child(node, "net"));
        const shapes: Array<Shape> = [];
        for (const fill of children(node, "filled_polygon")) {
          const layer = value(fill, "layer") ?? "F.Cu";
          const points = children(child(fill, "pts"), "xy").map(pointOf);
          shapes.push({ kind: "polygon", points, width: 0, paint: layer, fill: layer });
        }
        const keepout = child(node, "keepout") !== undefined;
        const layer = keepout
          ? KEEPOUT_PAINT
          : (value(node, "layer") ?? atoms(child(node, "layers"))[0] ?? "F.Cu");
        if (shapes.length === 0) {
          // An unfilled zone only has its drawn boundary.
          for (const outline of children(node, "polygon")) {
            const points = children(child(outline, "pts"), "xy").map(pointOf);
            shapes.push({ kind: "polygon", points, width: DEFAULT_WIDTH, paint: layer });
          }
        }
        if (shapes.length === 0) break;
        items.push({
          id: value(node, "uuid") ?? `zone:${index}`,
          kind: "zone",
          box: boxOfShapes(shapes),
          shapes,
          layer,
          title: keepout ? `Keep-out area ${value(node, "name") ?? ""}`.trim() : "Copper zone",
          ...(net ? { net } : {}),
        });
        break;
      }
      case "gr_text": {
        const shape = textShape(node, text(node, 1), WORLD, value(node, "layer") ?? "F.SilkS");
        if (!shape) break;
        items.push({
          id: value(node, "uuid") ?? `text:${index}`,
          kind: "graphic",
          box: boxOfShapes([shape]),
          shapes: [shape],
          layer: shape.paint,
          title: "Text",
        });
        break;
      }
      default: {
        if (!head.startsWith("gr_")) break;
        const layer = value(node, "layer") ?? "Dwgs.User";
        const shapes = graphicShapes(node, WORLD, layer);
        if (shapes.length === 0) break;
        items.push({
          id: value(node, "uuid") ?? `graphic:${index}`,
          kind: "graphic",
          box: boxOfShapes(shapes),
          shapes,
          layer,
          title: layer === "Edge.Cuts" ? "Board outline" : "Drawing",
        });
      }
    }
  });
  // Frame the board by its outline when it has one, so stray drawings do not shrink it.
  const outline = items.filter((item) => item.layer === "Edge.Cuts").map((item) => item.box);
  const solid = items.filter((item) => item.kind !== "graphic").map((item) => item.box);
  return {
    kind: "board",
    items,
    bounds:
      unionBoxes([...outline, ...solid]) ?? unionBoxes(items.map((item) => item.box)) ?? EMPTY_BOX,
    layers,
  };
}
