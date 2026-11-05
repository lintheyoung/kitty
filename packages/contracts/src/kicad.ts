import * as Schema from "effect/Schema";

/** Kitty's KiCad 10 adapter (`kicad-cli`). See docs/kitty/开发计划.md, Sprint 3. */

const KicadPath = (description: string) => Schema.String.annotate({ description });

const SchematicPath = KicadPath(
  "Schematic (.kicad_sch), project (.kicad_pro) or project directory, relative to the workspace.",
);
const BoardPath = KicadPath(
  "Board (.kicad_pcb), project (.kicad_pro) or project directory, relative to the workspace.",
);

export const KicadSeverity = Schema.Literals(["error", "warning", "exclusion"]);
export type KicadSeverity = typeof KicadSeverity.Type;

export const KicadViolationItem = Schema.Struct({
  description: Schema.String,
  x: Schema.optional(Schema.Number),
  y: Schema.optional(Schema.Number),
});
export type KicadViolationItem = typeof KicadViolationItem.Type;

export const KicadViolation = Schema.Struct({
  /** Stable KiCad check key, e.g. `pin_not_connected`, `clearance`. */
  type: Schema.String,
  severity: KicadSeverity,
  /** In KiCad's UI language. */
  description: Schema.String,
  sheet: Schema.optional(Schema.String),
  items: Schema.Array(KicadViolationItem),
});
export type KicadViolation = typeof KicadViolation.Type;

export const KicadCheckSummary = Schema.Struct({
  errors: Schema.Int,
  warnings: Schema.Int,
  /** Violation count per check key, most frequent first. */
  byType: Schema.Array(Schema.Struct({ type: Schema.String, count: Schema.Int })),
});
export type KicadCheckSummary = typeof KicadCheckSummary.Type;

export const KicadErcInput = Schema.Struct({ path: SchematicPath });
export type KicadErcInput = typeof KicadErcInput.Type;

export const KicadErcResult = Schema.Struct({
  schematic: Schema.String,
  kicadVersion: Schema.optional(Schema.String),
  summary: KicadCheckSummary,
  /** Errors first; at most 100. */
  violations: Schema.Array(KicadViolation),
  truncated: Schema.Boolean,
});
export type KicadErcResult = typeof KicadErcResult.Type;

export const KicadDrcInput = Schema.Struct({
  path: BoardPath,
  schematicParity: Schema.optional(
    Schema.Boolean.annotate({
      description: "Also check the board against the schematic. Default true.",
    }),
  ),
});
export type KicadDrcInput = typeof KicadDrcInput.Type;

export const KicadDrcResult = Schema.Struct({
  board: Schema.String,
  kicadVersion: Schema.optional(Schema.String),
  summary: KicadCheckSummary,
  violations: Schema.Array(KicadViolation),
  unconnected: Schema.Array(KicadViolation),
  /** Board/schematic mismatches (missing or extra footprints, net differences). */
  schematicParity: Schema.Array(KicadViolation),
  truncated: Schema.Boolean,
});
export type KicadDrcResult = typeof KicadDrcResult.Type;

export const KicadNetNode = Schema.Struct({
  ref: Schema.String,
  pin: Schema.String,
  function: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
});
export type KicadNetNode = typeof KicadNetNode.Type;

export const KicadNet = Schema.Struct({
  name: Schema.String,
  nodes: Schema.Array(KicadNetNode),
});
export type KicadNet = typeof KicadNet.Type;

export const KicadComponent = Schema.Struct({
  ref: Schema.String,
  value: Schema.String,
  footprint: Schema.optional(Schema.String),
  /** User fields such as LCSC, MPN, Manufacturer. */
  fields: Schema.Record(Schema.String, Schema.String),
  dnp: Schema.Boolean,
  excludeFromBom: Schema.Boolean,
});
export type KicadComponent = typeof KicadComponent.Type;

/** One pin of a component and what it connects to. */
export const KicadPinConnection = Schema.Struct({
  pin: Schema.String,
  function: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  net: Schema.String,
  /** `false` when KiCad marks the pin unconnected. */
  connected: Schema.Boolean,
  /** The other pins on the same net, e.g. `R3.1`. */
  others: Schema.Array(Schema.String),
});
export type KicadPinConnection = typeof KicadPinConnection.Type;

export const KicadNetlistInput = Schema.Struct({
  path: SchematicPath,
  component: Schema.optional(
    Schema.String.annotate({
      description:
        "Reference, e.g. U1: return that component's pin-to-net table instead of the whole netlist. Use it to see which MCU GPIO drives what.",
    }),
  ),
});
export type KicadNetlistInput = typeof KicadNetlistInput.Type;

export const KicadNetlistResult = Schema.Struct({
  schematic: Schema.String,
  components: Schema.Array(KicadComponent),
  /** Without `component`: nets with at least two pins (unconnected pins are left out). */
  nets: Schema.Array(KicadNet),
  /** With `component`: its pins, in pin-number order. */
  pins: Schema.optional(Schema.Array(KicadPinConnection)),
  truncated: Schema.Boolean,
});
export type KicadNetlistResult = typeof KicadNetlistResult.Type;

export const KicadBomInput = Schema.Struct({
  path: SchematicPath,
  includeDnp: Schema.optional(
    Schema.Boolean.annotate({ description: "Keep Do-Not-Populate parts. Default false." }),
  ),
});
export type KicadBomInput = typeof KicadBomInput.Type;

export const KicadBomLine = Schema.Struct({
  refs: Schema.Array(Schema.String),
  quantity: Schema.Int,
  value: Schema.String,
  footprint: Schema.optional(Schema.String),
  /** LCSC part number (C12345) when the schematic has one. */
  lcsc: Schema.optional(Schema.String),
  mpn: Schema.optional(Schema.String),
  manufacturer: Schema.optional(Schema.String),
  dnp: Schema.Boolean,
});
export type KicadBomLine = typeof KicadBomLine.Type;

export const KicadBomResult = Schema.Struct({
  schematic: Schema.String,
  lines: Schema.Array(KicadBomLine),
  totalParts: Schema.Int,
  /** References with no LCSC or MPN field, which a fab cannot source. */
  unsourced: Schema.Array(Schema.String),
});
export type KicadBomResult = typeof KicadBomResult.Type;

export const KicadFabExportInput = Schema.Struct({
  path: BoardPath,
  outputDir: Schema.optional(
    Schema.String.annotate({
      description: "Output directory relative to the workspace. Default `fab/` next to the board.",
    }),
  ),
});
export type KicadFabExportInput = typeof KicadFabExportInput.Type;

export const KicadFabExportResult = Schema.Struct({
  board: Schema.String,
  outputDir: Schema.String,
  gerbers: Schema.Array(Schema.String),
  drill: Schema.Array(Schema.String),
  positions: Schema.optional(Schema.String),
  /** Gerbers + drill in one zip, ready to upload to a PCB fab. */
  zip: Schema.optional(Schema.String),
});
export type KicadFabExportResult = typeof KicadFabExportResult.Type;
