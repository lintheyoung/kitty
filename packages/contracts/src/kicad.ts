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

/** The text of one design file, for the client to draw. */
export const KicadDesignFile = Schema.Struct({
  /** Sheet name, or "Board". */
  name: Schema.String,
  /** The file, relative to the workspace. */
  file: Schema.String,
  source: Schema.String,
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
