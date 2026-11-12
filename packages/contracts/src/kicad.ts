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
  /** The id of the symbol, pin, track or pad in the design file. */
  uuid: Schema.optional(Schema.String),
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

export const KicadPreviewKind = Schema.Literals(["schematic", "board"]);
export type KicadPreviewKind = typeof KicadPreviewKind.Type;

/** One drawing: a schematic sheet, or the board's copper, silkscreen and outline. */
export const KicadPreviewPage = Schema.Struct({
  name: Schema.String,
  svg: Schema.String,
});
export type KicadPreviewPage = typeof KicadPreviewPage.Type;

export const KicadPreviewResult = Schema.Struct({
  kind: KicadPreviewKind,
  /** The design file drawn, relative to the workspace. */
  file: Schema.String,
  /** Empty when there is nothing to draw yet (a blank board). */
  pages: Schema.Array(KicadPreviewPage),
  /** Sheets left out to keep the reply small. */
  omitted: Schema.Int,
});
export type KicadPreviewResult = typeof KicadPreviewResult.Type;

export const BoardSyncInput = Schema.Struct({
  path: Schema.String.annotate({
    description: "The design: its .kicad_pcb, .kicad_pro or directory, relative to the workspace.",
  }),
});
export type BoardSyncInput = typeof BoardSyncInput.Type;

/** What bringing the schematic onto the board changed. */
export const BoardSyncResult = Schema.Struct({
  board: Schema.String,
  /** Parts new on the board, set down beside it, still to be placed. */
  added: Schema.Array(Schema.String),
  /** Parts whose value, footprint or nets changed. */
  updated: Schema.Array(Schema.String),
  /** Parts taken off the board because the schematic no longer has them. */
  removed: Schema.Array(Schema.String),
  /** Parts whose footprint is not in any library. */
  missing: Schema.Array(Schema.Struct({ ref: Schema.String, footprint: Schema.String })),
  /** Parts the schematic gives no footprint. */
  withoutFootprint: Schema.Array(Schema.String),
  /** How many parts the board holds now. */
  parts: Schema.Int,
});
export type BoardSyncResult = typeof BoardSyncResult.Type;

const BoardPoint = Schema.Struct({ x: Schema.Number, y: Schema.Number }).annotate({
  description: "A point on the board in millimetres; y grows downwards.",
});

/** A place on the board: a point, or the centre of a pad named like "U1.3". */
const BoardSpot = Schema.Union([
  BoardPoint,
  Schema.Struct({
    pad: Schema.String.annotate({ description: "A pad as REF.NUMBER, e.g. U1.3." }),
  }),
]);

/** One change to a board. */
export const BoardEdit = Schema.Union([
  Schema.Struct({
    op: Schema.Literal("move"),
    reference: Schema.String.annotate({ description: "The part to move, e.g. U1." }),
    at: Schema.optional(BoardPoint),
    by: Schema.optional(BoardPoint),
    rotation: Schema.optional(
      Schema.Number.annotate({ description: "Angle in degrees, counter-clockwise." }),
    ),
    rotateBy: Schema.optional(Schema.Number),
    side: Schema.optional(Schema.Literals(["front", "back"])),
  }),
  Schema.Struct({
    op: Schema.Literal("outline"),
    x: Schema.Number,
    y: Schema.Number,
    width: Schema.Number,
    height: Schema.Number,
  }).annotate({ description: "Make the board a rectangle; replaces the outline it has." }),
  Schema.Struct({
    op: Schema.Literal("keepout"),
    name: Schema.String.annotate({
      description: "What the area is for, e.g. 'U2 antenna'; reusing a name replaces that area.",
    }),
    x: Schema.Number,
    y: Schema.Number,
    width: Schema.Number,
    height: Schema.Number,
  }).annotate({
    description: "A rectangle where no track, via or copper fill may go, on every copper layer.",
  }),
  Schema.Struct({
    op: Schema.Literal("remove_keepout"),
    name: Schema.String,
  }),
  Schema.Struct({
    op: Schema.Literal("pour"),
    net: Schema.String.annotate({ description: "The net to fill with, usually GND." }),
    layers: Schema.optional(
      Schema.Array(Schema.String).annotate({
        description: "Copper layers to fill; every copper layer when absent.",
      }),
    ),
    x: Schema.optional(Schema.Number),
    y: Schema.optional(Schema.Number),
    width: Schema.optional(Schema.Number),
    height: Schema.optional(Schema.Number),
  }).annotate({
    description:
      "Fill the free copper with a net: the whole board, or the rectangle given. Replaces that net's pour on those layers. Pours are refilled after every edit.",
  }),
  Schema.Struct({
    op: Schema.Literal("remove_pour"),
    net: Schema.String,
    layers: Schema.optional(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    op: Schema.Literal("text"),
    text: Schema.String,
    x: Schema.Number,
    y: Schema.Number,
    side: Schema.optional(Schema.Literals(["front", "back"])),
    size: Schema.optional(
      Schema.Number.annotate({ description: "Letter height in millimetres; 1 when absent." }),
    ),
    rotation: Schema.optional(Schema.Number),
  }).annotate({
    description:
      "Print text on the silkscreen, centred on the point: a name, version or pin label.",
  }),
  Schema.Struct({
    op: Schema.Literal("remove_text"),
    id: Schema.String.annotate({ description: "The id of a text from the reply's texts." }),
  }),
  Schema.Struct({
    op: Schema.Literal("label"),
    reference: Schema.String,
    at: Schema.optional(BoardPoint),
    rotation: Schema.optional(Schema.Number),
    hidden: Schema.optional(Schema.Boolean),
  }).annotate({ description: "Move, turn, hide or show one part's reference on the silkscreen." }),
  Schema.Struct({
    op: Schema.Literal("tidy_labels"),
  }).annotate({
    description:
      "Put every part's reference beside its part at one readable size, clear of pads and of each other.",
  }),
  Schema.Struct({
    op: Schema.Literal("track"),
    points: Schema.Array(BoardSpot).annotate({
      description: "The corners of the track in order, at least two; pads by name or points.",
    }),
    layer: Schema.optional(
      Schema.String.annotate({ description: "Copper layer, F.Cu (default) or B.Cu." }),
    ),
    width: Schema.optional(
      Schema.Number.annotate({ description: "Millimetres; the net's usual width when absent." }),
    ),
    net: Schema.optional(
      Schema.String.annotate({ description: "Needed only when the track starts on bare board." }),
    ),
  }).annotate({ description: "Draw a track. Refused if it would touch another net." }),
  Schema.Struct({
    op: Schema.Literal("via"),
    at: BoardSpot,
    net: Schema.optional(Schema.String),
  }).annotate({ description: "Join the front and back copper at a point." }),
  Schema.Struct({
    op: Schema.Literal("unroute"),
    net: Schema.optional(
      Schema.String.annotate({ description: "Remove every track and via of this net." }),
    ),
    ids: Schema.optional(
      Schema.Array(Schema.String).annotate({ description: "Remove these tracks and vias." }),
    ),
  }),
]);
export type BoardEdit = typeof BoardEdit.Type;

export const BoardEditInput = Schema.Struct({
  path: Schema.String.annotate({
    description: "The design: its .kicad_pcb, .kicad_pro or directory, relative to the workspace.",
  }),
  edits: Schema.Array(BoardEdit).annotate({
    description: "Applied in order, all or none. Leave empty to only read the board.",
  }),
  nets: Schema.optional(
    Schema.Array(Schema.String).annotate({
      description: "Nets to describe in the reply: where their pads, tracks and vias are.",
    }),
  ),
});
export type BoardEditInput = typeof BoardEditInput.Type;

export const BoardPart = Schema.Struct({
  reference: Schema.String,
  value: Schema.String,
  /** The footprint's origin. */
  at: BoardPoint,
  rotation: Schema.Number,
  side: Schema.Literals(["front", "back"]),
  /** The space the part takes as it lies now, in millimetres. */
  width: Schema.Number,
  height: Schema.Number,
  pads: Schema.Int,
  /** The schematic block the part belongs to; empty when it has none. */
  group: Schema.String,
  /** Whether the whole part is inside the board outline. */
  inside: Schema.Boolean,
});
export type BoardPart = typeof BoardPart.Type;

/** Where one net's copper is, for routing it. */
export const BoardNet = Schema.Struct({
  net: Schema.String,
  pads: Schema.Array(
    Schema.Struct({
      pad: Schema.String,
      at: BoardPoint,
      /** The copper a track can reach the pad on. */
      side: Schema.Literals(["front", "back", "both"]),
    }),
  ),
  tracks: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      layer: Schema.String,
      width: Schema.Number,
      from: BoardPoint,
      to: BoardPoint,
    }),
  ),
  vias: Schema.Array(Schema.Struct({ id: Schema.String, at: BoardPoint })),
});
export type BoardNet = typeof BoardNet.Type;

export const BoardEditResult = Schema.Struct({
  board: Schema.String,
  /** What the edits did, one line each. */
  summary: Schema.Array(Schema.String),
  /** The rectangle around the board outline; absent when the board has no outline. */
  outline: Schema.optional(
    Schema.Struct({
      x: Schema.Number,
      y: Schema.Number,
      width: Schema.Number,
      height: Schema.Number,
    }),
  ),
  /** Every part on the board after the edits. */
  parts: Schema.Array(BoardPart),
  /** Pairs of parts on the same side whose bodies overlap. */
  overlaps: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  /** Copper fills, with the copper each really got; 0 means the fill found no room. */
  pours: Schema.Array(
    Schema.Struct({
      net: Schema.String,
      layer: Schema.String,
      /** Filled copper in square millimetres. */
      area: Schema.Number,
    }),
  ),
  /** Free text on the silkscreen. */
  texts: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      text: Schema.String,
      at: BoardPoint,
      side: Schema.Literals(["front", "back"]),
    }),
  ),
  /** Areas where tracks and vias may not go. */
  keepouts: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      x: Schema.Number,
      y: Schema.Number,
      width: Schema.Number,
      height: Schema.Number,
    }),
  ),
  /** Pairs of pads still to be joined by a track, nearest first within each net. */
  toRoute: Schema.Array(
    Schema.Struct({ net: Schema.String, from: Schema.String, to: Schema.String }),
  ),
  /** How many connections are left in all; `toRoute` may list fewer. */
  unrouted: Schema.Int,
  nets: Schema.optional(Schema.Array(BoardNet)),
});
export type BoardEditResult = typeof BoardEditResult.Type;

export const BoardAutorouteInput = Schema.Struct({
  path: Schema.String.annotate({
    description: "The design: its .kicad_pcb, .kicad_pro or directory, relative to the workspace.",
  }),
  passes: Schema.optional(
    Schema.Int.annotate({
      description: "How many tries the router gets, 1 to 100; 20 when absent.",
    }),
  ),
  finish: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Afterwards pour GND over the free copper, unless the board has a pour, and tidy the references. True when absent.",
    }),
  ),
});
export type BoardAutorouteInput = typeof BoardAutorouteInput.Type;

export const BoardAutorouteResult = Schema.Struct({
  board: Schema.String,
  summary: Schema.Array(Schema.String),
  tracks: Schema.Int,
  vias: Schema.Int,
  /** Tracks left thinner than the board allows; DRC lists them. */
  narrow: Schema.Int,
  /** Pairs of pads the router could not join. */
  toRoute: Schema.Array(
    Schema.Struct({ net: Schema.String, from: Schema.String, to: Schema.String }),
  ),
  unrouted: Schema.Int,
});
export type BoardAutorouteResult = typeof BoardAutorouteResult.Type;

/** The text of one design file, for the client to draw. */
export const KicadDesignFile = Schema.Struct({
  /** Sheet name, or "Board". */
  name: Schema.String,
  /** The file, relative to the workspace. */
  file: Schema.String,
  source: Schema.String,
  /** The agent's changes to this file that the user has not yet kept or reverted. */
  review: Schema.optional(
    Schema.Struct({
      /** The file as it was before the agent changed it. */
      baseline: Schema.String,
      /** What the agent did, one line per edit. */
      summary: Schema.Array(Schema.String),
    }),
  ),
});
export type KicadDesignFile = typeof KicadDesignFile.Type;

export const KicadDesignSourceResult = Schema.Struct({
  /** Root sheet first, then its sub-sheets in the order they are found. */
  sheets: Schema.Array(KicadDesignFile),
  board: Schema.optional(KicadDesignFile),
  /** Files left out to keep the reply small. */
  omitted: Schema.Int,
});
export type KicadDesignSourceResult = typeof KicadDesignSourceResult.Type;

/** Changes whenever a design's schematic or board files are saved. */
export const KicadDesignStampResult = Schema.Struct({ stamp: Schema.String });
export type KicadDesignStampResult = typeof KicadDesignStampResult.Type;

/** The board as a 3D model for the client to show. */
export const KicadBoardModelResult = Schema.Struct({
  /** The board file, relative to the workspace. */
  file: Schema.String,
  /** A binary glTF file, base64 encoded. */
  glb: Schema.String,
  /** False when silkscreen and solder mask were left out to keep the model small. */
  detailed: Schema.Boolean,
});
export type KicadBoardModelResult = typeof KicadBoardModelResult.Type;

export const KicadFabExportInput = Schema.Struct({
  path: BoardPath,
  outputDir: Schema.optional(
    Schema.String.annotate({
      description: "Output directory relative to the workspace. Default `fab/` next to the board.",
    }),
  ),
  force: Schema.optional(
    Schema.Boolean.annotate({
      description: "Export even though DRC finds errors or unrouted connections. Default false.",
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
  /** JLC assembly: the bill of materials and the placement file. */
  bom: Schema.optional(Schema.String),
  cpl: Schema.optional(Schema.String),
  /** Parts with no LCSC number, which JLC cannot fit as they are. */
  unsourced: Schema.Array(Schema.String),
  /** What DRC still finds; only non-empty when the export was forced. */
  blockers: Schema.Array(Schema.String),
});
export type KicadFabExportResult = typeof KicadFabExportResult.Type;

/*
 * Kitty hardware project model (PRD §6): files under `hardware/` that tell an
 * agent what the board is. The schematic is the source of truth; these files
 * are exported from it and checked against it.
 */

export const KITTY_PROJECT_SCHEMA_VERSION = "0.1";

export const KittyPin = Schema.Struct({
  gpio: Schema.Int,
  /** Module/package pin number in the schematic symbol. */
  pin: Schema.String,
  pin_name: Schema.String,
  net: Schema.String,
  /** False when the schematic leaves the pin unconnected. */
  connected: Schema.Boolean,
  /** Other pins on the net, e.g. `D1.2`. */
  peers: Schema.Array(Schema.String),
  /** Hand-written: what the pin is for, e.g. "status LED". Kept across syncs. */
  function: Schema.optional(Schema.String),
  /** Hand-written electrical notes, e.g. "active low", "max 20 mA". Kept across syncs. */
  notes: Schema.optional(Schema.String),
});
export type KittyPin = typeof KittyPin.Type;

export const KittyPinmap = Schema.Struct({
  schema_version: Schema.Literal(KITTY_PROJECT_SCHEMA_VERSION),
  mcu: Schema.Struct({ ref: Schema.String, part: Schema.String }),
  source: Schema.Struct({ schematic: Schema.String }),
  pins: Schema.Array(KittyPin),
});
export type KittyPinmap = typeof KittyPinmap.Type;

export const KittyComponentSource = Schema.Struct({
  supplier: Schema.String,
  part_number: Schema.String,
  url: Schema.optional(Schema.String),
});
export type KittyComponentSource = typeof KittyComponentSource.Type;

export const KittyComponentEntry = Schema.Struct({
  refs: Schema.Array(Schema.String),
  value: Schema.String,
  footprint: Schema.optional(Schema.String),
  manufacturer: Schema.optional(Schema.String),
  mpn: Schema.optional(Schema.String),
  datasheet: Schema.optional(Schema.String),
  /** Where to buy it: from the schematic's LCSC field, plus hand-added sources. */
  sources: Schema.Array(KittyComponentSource),
  /** Hand-written alternatives, e.g. other MPNs. Kept across syncs. */
  alternates: Schema.optional(Schema.Array(Schema.String)),
  dnp: Schema.Boolean,
});
export type KittyComponentEntry = typeof KittyComponentEntry.Type;

export const KittyComponents = Schema.Struct({
  schema_version: Schema.Literal(KITTY_PROJECT_SCHEMA_VERSION),
  source: Schema.Struct({ schematic: Schema.String }),
  components: Schema.Array(KittyComponentEntry),
});
export type KittyComponents = typeof KittyComponents.Type;

export const KittyBoard = Schema.Struct({
  schema_version: Schema.Literal(KITTY_PROJECT_SCHEMA_VERSION),
  board_id: Schema.String,
  name: Schema.String,
  mcu: Schema.Struct({ vendor: Schema.String, model: Schema.String }),
  interfaces: Schema.optional(
    Schema.Struct({
      i2c: Schema.optional(
        Schema.Array(Schema.Struct({ name: Schema.String, sda: Schema.Int, scl: Schema.Int })),
      ),
      uart: Schema.optional(
        Schema.Array(Schema.Struct({ name: Schema.String, tx: Schema.Int, rx: Schema.Int })),
      ),
      spi: Schema.optional(
        Schema.Array(
          Schema.Struct({
            name: Schema.String,
            sclk: Schema.Int,
            mosi: Schema.optional(Schema.Int),
            miso: Schema.optional(Schema.Int),
            cs: Schema.optional(Schema.Array(Schema.Int)),
          }),
        ),
      ),
    }),
  ),
  peripherals: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        type: Schema.String,
        interface: Schema.optional(Schema.String),
        address: Schema.optional(Schema.String),
        part: Schema.optional(Schema.String),
        test: Schema.optional(Schema.String),
      }),
    ),
  ),
});
export type KittyBoard = typeof KittyBoard.Type;

const ProjectRoot = Schema.optional(
  Schema.String.annotate({
    description:
      "Hardware project root (with hardware/ and firmware/), relative to the workspace. Default the workspace root.",
  }),
);

export const KittyFileReport = Schema.Struct({
  file: Schema.String,
  present: Schema.Boolean,
  /** Field-level problems, e.g. `pins[3].gpio: Expected an integer`. */
  errors: Schema.Array(Schema.String),
});
export type KittyFileReport = typeof KittyFileReport.Type;

export const HardwareProjectInspectInput = Schema.Struct({ path: ProjectRoot });
export type HardwareProjectInspectInput = typeof HardwareProjectInspectInput.Type;

export const HardwareProjectInspectResult = Schema.Struct({
  root: Schema.String,
  schematic: Schema.optional(Schema.String),
  board: Schema.optional(Schema.String),
  firmware: Schema.Array(Schema.String),
  files: Schema.Array(KittyFileReport),
  board_config: Schema.optional(KittyBoard),
  pinmap: Schema.optional(KittyPinmap),
  next_steps: Schema.Array(Schema.String),
});
export type HardwareProjectInspectResult = typeof HardwareProjectInspectResult.Type;

export const HardwarePinmapSyncInput = Schema.Struct({
  path: ProjectRoot,
  mcu: Schema.optional(
    Schema.String.annotate({
      description: "Reference of the MCU or module, e.g. U1. Default: the ESP32 part.",
    }),
  ),
});
export type HardwarePinmapSyncInput = typeof HardwarePinmapSyncInput.Type;

export const HardwarePinChange = Schema.Struct({
  gpio: Schema.Int,
  change: Schema.Literals(["added", "removed", "net_changed"]),
  before: Schema.optional(Schema.String),
  after: Schema.optional(Schema.String),
});
export type HardwarePinChange = typeof HardwarePinChange.Type;

export const HardwarePinmapSyncResult = Schema.Struct({
  pinmap: Schema.String,
  components: Schema.String,
  mcu: Schema.Struct({ ref: Schema.String, part: Schema.String }),
  gpios: Schema.Int,
  connected: Schema.Int,
  changes: Schema.Array(HardwarePinChange),
});
export type HardwarePinmapSyncResult = typeof HardwarePinmapSyncResult.Type;

export const HardwarePinCheckInput = Schema.Struct({ path: ProjectRoot });
export type HardwarePinCheckInput = typeof HardwarePinCheckInput.Type;

export const HardwarePinIssue = Schema.Struct({
  severity: Schema.Literals(["error", "warning"]),
  kind: Schema.Literals([
    "pinmap_stale",
    "firmware_pin_unconnected",
    "firmware_pin_unknown",
    "strapping_pin",
    "usb_pin",
    "pin_conflict",
  ]),
  gpio: Schema.optional(Schema.Int),
  message: Schema.String,
  /** Firmware location, e.g. `firmware/main/main.c:12`. */
  at: Schema.optional(Schema.String),
});
export type HardwarePinIssue = typeof HardwarePinIssue.Type;

export const HardwareFirmwarePin = Schema.Struct({
  gpio: Schema.Int,
  name: Schema.String,
  at: Schema.String,
  net: Schema.optional(Schema.String),
});
export type HardwareFirmwarePin = typeof HardwareFirmwarePin.Type;

export const HardwarePinCheckResult = Schema.Struct({
  ok: Schema.Boolean,
  issues: Schema.Array(HardwarePinIssue),
  /** GPIOs the firmware names, and the schematic net each is on. */
  firmware_pins: Schema.Array(HardwareFirmwarePin),
});
export type HardwarePinCheckResult = typeof HardwarePinCheckResult.Type;

/** A new product repository: hardware and firmware together, one Kitty project. */
export const HardwareProjectNewInput = Schema.Struct({
  name: Schema.String.annotate({ description: "Product or board name, e.g. KeyCAP." }),
  location: Schema.optional(
    Schema.String.annotate({
      description:
        "Absolute directory to create the repository in. Default: next to the current project.",
    }),
  ),
});
export type HardwareProjectNewInput = typeof HardwareProjectNewInput.Type;

export const HardwareProjectNewResult = Schema.Struct({
  /** Absolute path of the new repository. */
  root: Schema.String,
  /** The Kitty project registered for it. */
  projectId: Schema.String,
  /** Paths below are relative to the repository. */
  schematic: Schema.String,
  board: Schema.String,
  firmware: Schema.String,
  files: Schema.Array(Schema.String),
  /** False when git is missing or has no user identity; the files are there either way. */
  committed: Schema.Boolean,
  next_steps: Schema.Array(Schema.String),
});
export type HardwareProjectNewResult = typeof HardwareProjectNewResult.Type;

/** A KiCad project found in a thread's workspace. */
export const KicadDesign = Schema.Struct({
  /** The .kicad_pro, relative to the workspace. */
  project: Schema.String,
  name: Schema.String,
  schematic: Schema.optional(Schema.String),
  board: Schema.optional(Schema.String),
});
export type KicadDesign = typeof KicadDesign.Type;

export const KicadDesignsResult = Schema.Struct({ designs: Schema.Array(KicadDesign) });
export type KicadDesignsResult = typeof KicadDesignsResult.Type;
