import * as Schema from "effect/Schema";

const SheetPoint = Schema.Struct({ x: Schema.Number, y: Schema.Number }).annotate({
  description: "A position on the sheet in millimetres; Y grows downwards.",
});
const Rotation = Schema.Literals([0, 90, 180, 270]).annotate({
  description: "Counter-clockwise, in degrees.",
});
const PinNets = Schema.Record(Schema.String, Schema.String).annotate({
  description:
    'Net for each pin number, e.g. {"1":"GND","2":"+3V3","5":"SDA"}. Each pin gets a short wire ending in a power symbol (GND, +3V3, +5V, VBUS and other KiCad power names) or a net label. Pins with the same net name are connected.',
});
const Reference = Schema.String.annotate({ description: "The part's reference, e.g. U1." });

/** One change to a schematic sheet. */
export const SchematicEdit = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("place"),
    symbol: Schema.String.annotate({
      description:
        "Library id of the part: the `jlc:` symbol returned by jlc_part_import, or a power symbol such as power:PWR_FLAG.",
    }),
    at: Schema.optional(SheetPoint),
    rotation: Schema.optional(Rotation),
    mirror: Schema.optional(Schema.Literals(["x", "y"])),
    reference: Schema.optional(Schema.String),
    value: Schema.optional(
      Schema.String.annotate({ description: 'Shown next to the part, e.g. "10k".' }),
    ),
    nets: Schema.optional(PinNets),
    noConnect: Schema.optional(Schema.Array(Schema.String)),
    noConnectRest: Schema.optional(
      Schema.Boolean.annotate({
        description: "Mark every pin without a net as unconnected on purpose.",
      }),
    ),
  }),
  Schema.Struct({
    op: Schema.Literal("connect"),
    reference: Reference,
    nets: Schema.optional(PinNets),
    noConnect: Schema.optional(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    op: Schema.Literal("move"),
    reference: Reference,
    at: SheetPoint,
    rotation: Schema.optional(Rotation),
    mirror: Schema.optional(Schema.Literals(["x", "y"])),
  }),
  Schema.Struct({ op: Schema.Literal("remove"), reference: Reference }),
  Schema.Struct({
    op: Schema.Literal("set"),
    reference: Reference,
    property: Schema.String.annotate({ description: "Value, Reference, or any other field." }),
    value: Schema.String,
  }),
  Schema.Struct({ op: Schema.Literal("wire"), points: Schema.Array(SheetPoint) }),
  Schema.Struct({
    op: Schema.Literal("label"),
    net: Schema.String,
    at: SheetPoint,
    rotation: Schema.optional(Rotation),
  }),
  Schema.Struct({ op: Schema.Literal("junction"), at: SheetPoint }),
  Schema.Struct({ op: Schema.Literal("no_connect"), at: SheetPoint }),
]);
export type SchematicEdit = typeof SchematicEdit.Type;

export const SchematicEditInput = Schema.Struct({
  path: Schema.String.annotate({
    description: "The design: its .kicad_sch, .kicad_pro or directory, relative to the workspace.",
  }),
  edits: Schema.Array(SchematicEdit).annotate({
    description: "Applied in order. If one cannot be made, the schematic is left as it was.",
  }),
});
export type SchematicEditInput = typeof SchematicEditInput.Type;

export const SchematicEditedPart = Schema.Struct({
  reference: Schema.String,
  symbol: Schema.String,
  at: SheetPoint,
  /** The net KiCad resolves for each pin after the edit. */
  pins: Schema.Array(
    Schema.Struct({
      number: Schema.String,
      name: Schema.optional(Schema.String),
      net: Schema.optional(Schema.String),
    }),
  ),
});
export type SchematicEditedPart = typeof SchematicEditedPart.Type;

export const SchematicEditResult = Schema.Struct({
  schematic: Schema.String,
  /** Parts placed, moved or reconnected. */
  parts: Schema.Array(SchematicEditedPart),
  removed: Schema.Array(Schema.String),
  /** Pins that did not end up on the net that was asked for. */
  warnings: Schema.Array(Schema.String),
  /** KiCad's electrical check of the result. Use kicad_erc for the details. */
  erc: Schema.Struct({ errors: Schema.Int, warnings: Schema.Int }),
});
export type SchematicEditResult = typeof SchematicEditResult.Type;
