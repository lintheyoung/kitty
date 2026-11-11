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
    at: Schema.optional(SheetPoint),
    by: Schema.optional(
      Schema.Struct({ x: Schema.Number, y: Schema.Number }).annotate({
        description: "How far to move the part from where it is, instead of `at`.",
      }),
    ),
    rotateBy: Schema.optional(Rotation),
    rotation: Schema.optional(Rotation),
    mirror: Schema.optional(Schema.Literals(["x", "y"])),
  }),
  Schema.Struct({ op: Schema.Literal("remove"), reference: Reference }),
  Schema.Struct({
    op: Schema.Literal("erase"),
    id: Schema.String.annotate({
      description: "The uuid of a wire, label, junction or no-connect mark to remove.",
    }),
  }),
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

/** Which way to step through a schematic's edit history. */
export const SchematicHistoryStep = Schema.Literals(["undo", "redo"]);
export type SchematicHistoryStep = typeof SchematicHistoryStep.Type;

export const SchematicHistoryResult = Schema.Struct({
  schematic: Schema.String,
  /** False when there was nothing to undo or redo. */
  applied: Schema.Boolean,
  /** How many steps remain each way. */
  undo: Schema.Int,
  redo: Schema.Int,
});
export type SchematicHistoryResult = typeof SchematicHistoryResult.Type;

/** What the user decides about the agent's changes under review. */
export const SchematicReviewDecision = Schema.Literals(["keep", "revert"]);
export type SchematicReviewDecision = typeof SchematicReviewDecision.Type;

export const SchematicReviewResult = Schema.Struct({
  schematic: Schema.String,
  /** False when there was nothing under review. */
  applied: Schema.Boolean,
});
export type SchematicReviewResult = typeof SchematicReviewResult.Type;

/** Who made a change: the user in the designer, or the agent with sch_edit. */
export const SchematicChangeAuthor = Schema.Literals(["user", "agent"]);
export type SchematicChangeAuthor = typeof SchematicChangeAuthor.Type;

/** One entry of a design's change log. */
export const SchematicChange = Schema.Struct({
  /** ISO time of the change. */
  at: Schema.String,
  by: SchematicChangeAuthor,
  /** What was done, one line per edit. */
  summary: Schema.Array(Schema.String),
});
export type SchematicChange = typeof SchematicChange.Type;

export const SchematicChangesInput = Schema.Struct({
  path: Schema.String.annotate({
    description: "The design: its .kicad_sch, .kicad_pro or directory, relative to the workspace.",
  }),
  limit: Schema.optional(
    Schema.Int.annotate({ description: "At most this many of the newest changes. Default 30." }),
  ),
});
export type SchematicChangesInput = typeof SchematicChangesInput.Type;

export const SchematicChangesResult = Schema.Struct({
  schematic: Schema.String,
  /** Oldest first. */
  changes: Schema.Array(SchematicChange),
  /** The user's changes since the agent last edited, as plain lines. */
  userChanges: Schema.Array(Schema.String),
});
export type SchematicChangesResult = typeof SchematicChangesResult.Type;

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
  /** What the user changed by hand in the designer since the agent last edited this schematic. */
  userChanges: Schema.Array(Schema.String),
});
export type SchematicEditResult = typeof SchematicEditResult.Type;
