import type {
  KicadBomLine,
  KicadCheckSummary,
  KicadComponent,
  KicadNet,
  KicadPinConnection,
  KicadSeverity,
  KicadViolation,
} from "@t3tools/contracts";

import { child, children, parseSexpr, type Sexpr, value } from "@t3tools/shared/kicad/sexpr";

const MAX_VIOLATIONS = 100;

const asRecord = (input: unknown): Record<string, unknown> =>
  typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
const asArray = (input: unknown): ReadonlyArray<unknown> => (Array.isArray(input) ? input : []);
const asString = (input: unknown): string | undefined =>
  typeof input === "string" ? input : undefined;
const asNumber = (input: unknown): number | undefined =>
  typeof input === "number" && Number.isFinite(input) ? input : undefined;

const SEVERITIES: ReadonlySet<string> = new Set(["error", "warning", "exclusion"]);

function toViolation(raw: unknown, sheet?: string): KicadViolation {
  const record = asRecord(raw);
  const severity = asString(record.severity) ?? "error";
  return {
    type: asString(record.type) ?? "unknown",
    severity: (SEVERITIES.has(severity) ? severity : "error") as KicadSeverity,
    description: asString(record.description) ?? "",
    ...(sheet ? { sheet } : {}),
    items: asArray(record.items).map((item) => {
      const entry = asRecord(item);
      const pos = asRecord(entry.pos);
      const x = asNumber(pos.x);
      const y = asNumber(pos.y);
      const uuid = asString(entry.uuid);
      return {
        description: asString(entry.description) ?? "",
        ...(x !== undefined ? { x } : {}),
        ...(y !== undefined ? { y } : {}),
        ...(uuid ? { uuid } : {}),
      };
    }),
  };
}

const severityRank = (severity: KicadSeverity) =>
  severity === "error" ? 0 : severity === "warning" ? 1 : 2;

function summarize(violations: ReadonlyArray<KicadViolation>): KicadCheckSummary {
  const counts = new Map<string, number>();
  for (const violation of violations) {
    counts.set(violation.type, (counts.get(violation.type) ?? 0) + 1);
  }
  return {
    errors: violations.filter((violation) => violation.severity === "error").length,
    warnings: violations.filter((violation) => violation.severity === "warning").length,
    byType: [...counts]
      .map(([type, count]) => ({ type, count }))
      .toSorted((a, b) => b.count - a.count || a.type.localeCompare(b.type)),
  };
}

/** Errors first, then at most `MAX_VIOLATIONS`. */
function limit(violations: ReadonlyArray<KicadViolation>) {
  const sorted = violations.toSorted((a, b) => severityRank(a.severity) - severityRank(b.severity));
  return {
    shown: sorted.slice(0, MAX_VIOLATIONS),
    truncated: sorted.length > MAX_VIOLATIONS,
  };
}

/** `kicad-cli sch erc --format json` (schema erc.v1). */
export function parseErcReport(json: string) {
  const report = asRecord(JSON.parse(json));
  const all = asArray(report.sheets).flatMap((sheet) => {
    const record = asRecord(sheet);
    const path = asString(record.path);
    return asArray(record.violations).map((violation) => toViolation(violation, path));
  });
  const { shown, truncated } = limit(all);
  const kicadVersion = asString(report.kicad_version);
  return {
    ...(kicadVersion ? { kicadVersion } : {}),
    summary: summarize(all),
    violations: shown,
    truncated,
  };
}

/** `kicad-cli pcb drc --format json` (schema drc.v1). */
export function parseDrcReport(json: string) {
  const report = asRecord(JSON.parse(json));
  const violations = asArray(report.violations).map((violation) => toViolation(violation));
  const unconnected = asArray(report.unconnected_items).map((item) => toViolation(item));
  const parity = asArray(report.schematic_parity).map((item) => toViolation(item));
  const { shown, truncated } = limit(violations);
  const kicadVersion = asString(report.kicad_version);
  return {
    ...(kicadVersion ? { kicadVersion } : {}),
    summary: summarize([...violations, ...unconnected, ...parity]),
    violations: shown,
    unconnected: unconnected.slice(0, MAX_VIOLATIONS),
    schematicParity: parity.slice(0, MAX_VIOLATIONS),
    truncated: truncated || unconnected.length > MAX_VIOLATIONS || parity.length > MAX_VIOLATIONS,
  };
}

/** Fields KiCad itself manages; everything else is a user field. */
const BUILTIN_FIELDS = new Set(["Reference", "Value", "Footprint", "Datasheet", "Description"]);
const TRUE_VALUES = new Set(["", "1", "true", "yes", "y"]);

function propertyFlag(comp: Sexpr, name: string): boolean {
  const property = children(comp, "property").find((entry) => value(entry, "name") === name);
  if (!property) return false;
  return TRUE_VALUES.has((value(property, "value") ?? "").toLowerCase());
}

const KICAD_ESCAPES: Readonly<Record<string, string>> = {
  slash: "/",
  backslash: "\\",
  lt: "<",
  gt: ">",
  colon: ":",
  dblquote: '"',
  quote: "'",
  space: " ",
  tab: "\t",
  return: "\n",
  brace: "{",
};

/** KiCad escapes characters in net and pin names as `{slash}` and friends. */
export const unescapeKicad = (text: string): string =>
  text.replace(/\{(\w+)\}/g, (match, name: string) => KICAD_ESCAPES[name] ?? match);

export interface KicadNetlist {
  readonly components: ReadonlyArray<KicadComponent>;
  readonly nets: ReadonlyArray<KicadNet>;
}

/** `kicad-cli sch export netlist --format kicadsexpr`. */
export function parseNetlist(text: string): KicadNetlist {
  const root = parseSexpr(text);
  const components = children(child(root, "components"), "comp").map((comp): KicadComponent => {
    const fields: Record<string, string> = {};
    for (const field of children(child(comp, "fields"), "field")) {
      const name = value(field, "name");
      const fieldValue = field[2];
      if (name && !BUILTIN_FIELDS.has(name) && typeof fieldValue === "string" && fieldValue) {
        fields[name] = fieldValue;
      }
    }
    const footprint = value(comp, "footprint");
    return {
      ref: value(comp, "ref") ?? "?",
      value: value(comp, "value") ?? "",
      ...(footprint ? { footprint } : {}),
      fields,
      dnp: propertyFlag(comp, "dnp"),
      excludeFromBom: propertyFlag(comp, "exclude_from_bom"),
    };
  });
  const nets = children(child(root, "nets"), "net").map((net): KicadNet => ({
    name: unescapeKicad(value(net, "name") ?? ""),
    nodes: children(net, "node").map((node) => {
      const fn = value(node, "pinfunction");
      const type = value(node, "pintype");
      return {
        ref: value(node, "ref") ?? "?",
        pin: value(node, "pin") ?? "?",
        ...(fn ? { function: unescapeKicad(fn) } : {}),
        ...(type ? { type } : {}),
      };
    }),
  }));
  return { components, nets: stripPinNumberSuffixes(nets) };
}

/**
 * KiCad 10 can name a pin's function `<name>_<pin number>` (`IO4_3`, `EN_2`),
 * which reads like a bit index. When every pin of a component follows that
 * pattern, drop the suffix; a component with real names like `GPIO_3` on
 * other pins keeps its names untouched.
 */
function stripPinNumberSuffixes(nets: ReadonlyArray<KicadNet>): ReadonlyArray<KicadNet> {
  const suffixed = new Map<string, boolean>();
  for (const net of nets) {
    for (const node of net.nodes) {
      if (node.function === undefined) continue;
      const ok =
        node.function.endsWith(`_${node.pin}`) && node.function.length > node.pin.length + 1;
      suffixed.set(node.ref, (suffixed.get(node.ref) ?? true) && ok);
    }
  }
  return nets.map((net) => ({
    ...net,
    nodes: net.nodes.map((node) =>
      node.function !== undefined && suffixed.get(node.ref)
        ? { ...node, function: node.function.slice(0, -(node.pin.length + 1)) }
        : node,
    ),
  }));
}

const naturalCompare = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

/** Which net each pin of `ref` is on, and what else is on that net. */
export function componentPins(netlist: KicadNetlist, ref: string): Array<KicadPinConnection> {
  const pins: Array<KicadPinConnection> = [];
  for (const net of netlist.nets) {
    for (const node of net.nodes) {
      if (node.ref !== ref) continue;
      const others = net.nodes
        .filter((other) => other !== node)
        .map((other) => `${other.ref}.${other.pin}`);
      pins.push({
        pin: node.pin,
        ...(node.function ? { function: node.function } : {}),
        ...(node.type ? { type: node.type } : {}),
        net: net.name,
        connected: !net.name.startsWith("unconnected-"),
        others,
      });
    }
  }
  return pins.toSorted((a, b) => naturalCompare(a.pin, b.pin));
}

const findField = (fields: Readonly<Record<string, string>>, pattern: RegExp) =>
  Object.entries(fields).find(([name, fieldValue]) => pattern.test(name) && fieldValue.trim())?.[1];

// Copper also stamps `JLC Class` (Basic, Extended), which is not a part number.
const LCSC_FIELD = /^(lcsc|jlc)(?![ _]?class)/i;
const MPN_FIELD = /^(mpn|manufacturer[ _]?part|mfr\.?[ _]?part|part[ _]?number|mfg[ _]?part)/i;
const MANUFACTURER_FIELD = /^(manufacturer|mfr|mfg)$/i;

/** BOM grouped by value, footprint and sourcing fields, like KiCad's "Grouped By Value". */
export function buildBom(
  components: ReadonlyArray<KicadComponent>,
  includeDnp: boolean,
): { lines: Array<KicadBomLine>; totalParts: number; unsourced: Array<string> } {
  const groups = new Map<
    string,
    { line: Omit<KicadBomLine, "refs" | "quantity">; refs: string[] }
  >();
  const unsourced: Array<string> = [];
  for (const component of components) {
    if (component.excludeFromBom || component.ref.startsWith("#")) continue;
    if (component.dnp && !includeDnp) continue;
    const lcsc = findField(component.fields, LCSC_FIELD);
    const mpn = findField(component.fields, MPN_FIELD);
    const manufacturer = findField(component.fields, MANUFACTURER_FIELD);
    if (!lcsc && !mpn && !component.dnp) unsourced.push(component.ref);
    const key = [component.value, component.footprint, lcsc, mpn, component.dnp].join("\u0000");
    const group = groups.get(key);
    if (group) {
      group.refs.push(component.ref);
      continue;
    }
    groups.set(key, {
      refs: [component.ref],
      line: {
        value: component.value,
        ...(component.footprint ? { footprint: component.footprint } : {}),
        ...(lcsc ? { lcsc } : {}),
        ...(mpn ? { mpn } : {}),
        ...(manufacturer ? { manufacturer } : {}),
        dnp: component.dnp,
      },
    });
  }
  const lines = [...groups.values()]
    .map(({ line, refs }) => {
      const sorted = refs.toSorted(naturalCompare);
      return { refs: sorted, quantity: sorted.length, ...line };
    })
    .toSorted((a, b) => naturalCompare(a.refs[0] ?? "", b.refs[0] ?? ""));
  return {
    lines,
    totalParts: lines.reduce((total, line) => total + line.quantity, 0),
    unsourced: unsourced.toSorted(naturalCompare),
  };
}

/** Below this an exported board drawing holds nothing (KiCad writes a 0.254 mm page). */
const MIN_BOARD_DRAWING_MM = 1;

/** Width and height of an SVG's viewBox, or null when it has none. */
function svgSize(svg: string): { readonly width: number; readonly height: number } | null {
  const match = /viewBox="\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)\s*"/.exec(svg);
  if (!match) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** True when kicad-cli drew an empty board: no outline, footprints or tracks yet. */
export function isBlankBoardSvg(svg: string): boolean {
  const size = svgSize(svg);
  return size === null || (size.width < MIN_BOARD_DRAWING_MM && size.height < MIN_BOARD_DRAWING_MM);
}

/**
 * Orders the SVG files `kicad-cli sch export svg` wrote for `stem`: the root
 * sheet (`<stem>.svg`) first, then sub-sheets (`<stem>-<sheet>.svg`) by name,
 * keeping as many as fit in `maxBytes`.
 */
export function schematicPages(
  stem: string,
  files: ReadonlyArray<{ readonly name: string; readonly svg: string }>,
  maxBytes: number,
): { readonly pages: ReadonlyArray<{ name: string; svg: string }>; readonly omitted: number } {
  const named = files
    .filter((file) => file.name.endsWith(".svg"))
    .map((file) => {
      const base = file.name.slice(0, -".svg".length);
      const root = base === stem;
      const name = root
        ? "Root sheet"
        : base.startsWith(`${stem}-`)
          ? base.slice(stem.length + 1)
          : base;
      return { root, name, svg: file.svg };
    })
    .toSorted((a, b) => (a.root === b.root ? a.name.localeCompare(b.name) : a.root ? -1 : 1));
  const pages: Array<{ name: string; svg: string }> = [];
  let used = 0;
  for (const page of named) {
    if (pages.length > 0 && used + page.svg.length > maxBytes) break;
    pages.push({ name: page.name, svg: page.svg });
    used += page.svg.length;
  }
  return { pages, omitted: named.length - pages.length };
}
