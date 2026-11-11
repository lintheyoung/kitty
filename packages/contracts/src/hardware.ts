import * as Schema from "effect/Schema";

import { ProjectId, ThreadId } from "./baseSchemas.ts";
import { SchematicEdit, SchematicHistoryStep } from "./schematicEdit.ts";

/** Kitty hardware toolchain checks. See docs/kitty/开发计划.md. */
export const HardwareCheckId = Schema.Literals([
  "esp-idf",
  "python-env",
  "esptool",
  "kicad",
  "jlc-parts",
  "serial",
]);
export type HardwareCheckId = typeof HardwareCheckId.Type;

export const HardwareCheckStatus = Schema.Literals(["ok", "warning", "missing"]);
export type HardwareCheckStatus = typeof HardwareCheckStatus.Type;

export const HardwareDoctorCheck = Schema.Struct({
  id: HardwareCheckId,
  status: HardwareCheckStatus,
  version: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  detail: Schema.String,
});
export type HardwareDoctorCheck = typeof HardwareDoctorCheck.Type;

export const HardwareIdfInstallation = Schema.Struct({
  path: Schema.String,
  version: Schema.String,
});
export type HardwareIdfInstallation = typeof HardwareIdfInstallation.Type;

export const HardwareDoctorReport = Schema.Struct({
  ok: Schema.Boolean,
  checks: Schema.Array(HardwareDoctorCheck),
  idfInstallations: Schema.Array(HardwareIdfInstallation),
  serialPorts: Schema.Array(Schema.String),
});
export type HardwareDoctorReport = typeof HardwareDoctorReport.Type;

export const HardwareDoctorInput = Schema.Struct({
  idfPath: Schema.optional(
    Schema.String.annotate({
      description: "ESP-IDF checkout to check. Defaults to IDF_PATH, then the newest found.",
    }),
  ),
});
export type HardwareDoctorInput = typeof HardwareDoctorInput.Type;

export class HardwareToolError extends Schema.TaggedError<HardwareToolError>()(
  "HardwareToolError",
  {
    code: Schema.Literals([
      "toolchain_missing",
      "invalid_path",
      "no_board",
      "board_ambiguous",
      "already_exists",
      "invalid_argument",
      "port_busy",
      "denied",
      "command_failed",
    ]),
    message: Schema.String,
  },
) {}

/** Chips ESP-IDF v5.5 builds for. Kitty's boards are ESP32-S3. */
export const HardwareChipTarget = Schema.Literals([
  "esp32",
  "esp32s2",
  "esp32s3",
  "esp32c2",
  "esp32c3",
  "esp32c5",
  "esp32c6",
  "esp32c61",
  "esp32h2",
  "esp32p4",
]);
export type HardwareChipTarget = typeof HardwareChipTarget.Type;

export const HardwareFlashSize = Schema.Literals(["2MB", "4MB", "8MB", "16MB", "32MB"]);
export type HardwareFlashSize = typeof HardwareFlashSize.Type;

export const HardwareChipInfoInput = Schema.Struct({
  port: Schema.optional(
    Schema.String.annotate({
      description: "Serial port from hw_doctor. Defaults to the only connected board.",
    }),
  ),
});
export type HardwareChipInfoInput = typeof HardwareChipInfoInput.Type;

export const HardwareChipInfo = Schema.Struct({
  port: Schema.String,
  chip: Schema.String,
  features: Schema.optional(Schema.String),
  mac: Schema.optional(Schema.String),
  usbMode: Schema.optional(Schema.String),
  flashSize: Schema.optional(Schema.String),
});
export type HardwareChipInfo = typeof HardwareChipInfo.Type;

export const HardwareProjectTemplate = Schema.Literals(["hello_world", "blink"]);
export type HardwareProjectTemplate = typeof HardwareProjectTemplate.Type;

export const HardwareProjectCreateInput = Schema.Struct({
  path: Schema.String.annotate({
    description: "New project directory, relative to the workspace. Must not exist yet.",
  }),
  template: Schema.optional(
    HardwareProjectTemplate.annotate({
      description: "ESP-IDF example to start from. Default hello_world.",
    }),
  ),
  target: Schema.optional(
    HardwareChipTarget.annotate({ description: "Chip target. Default esp32s3." }),
  ),
  flashSize: Schema.optional(
    HardwareFlashSize.annotate({
      description: "Board flash size from hw_chip_info. Omit to keep the template default (2MB).",
    }),
  ),
});
export type HardwareProjectCreateInput = typeof HardwareProjectCreateInput.Type;

export const HardwareProjectCreated = Schema.Struct({
  path: Schema.String,
  template: HardwareProjectTemplate,
  target: Schema.String,
  flashSize: Schema.optional(Schema.String),
  files: Schema.Array(Schema.String),
});
export type HardwareProjectCreated = typeof HardwareProjectCreated.Type;

export const HardwareBuildInput = Schema.Struct({
  path: Schema.String.annotate({
    description: "ESP-IDF project directory (with CMakeLists.txt), relative to the workspace.",
  }),
});
export type HardwareBuildInput = typeof HardwareBuildInput.Type;

export const HardwareBuildDiagnostic = Schema.Struct({
  severity: Schema.Literals(["error", "warning"]),
  source: Schema.Literals(["compiler", "linker", "cmake"]),
  file: Schema.optional(Schema.String),
  line: Schema.optional(Schema.Int),
  column: Schema.optional(Schema.Int),
  message: Schema.String,
});
export type HardwareBuildDiagnostic = typeof HardwareBuildDiagnostic.Type;

export const HardwareBuildResult = Schema.Struct({
  ok: Schema.Boolean,
  durationMs: Schema.Int,
  diagnostics: Schema.Array(HardwareBuildDiagnostic),
  appBinary: Schema.optional(
    Schema.Struct({
      sizeBytes: Schema.Int,
      partitionBytes: Schema.Int,
      freePercent: Schema.Int,
    }),
  ),
  logTail: Schema.String,
});
export type HardwareBuildResult = typeof HardwareBuildResult.Type;

/** An ESP-IDF project found in a thread's workspace. */
export const HardwareProject = Schema.Struct({
  path: Schema.String,
  name: Schema.String,
  target: Schema.optional(Schema.String),
});
export type HardwareProject = typeof HardwareProject.Type;

/**
 * The thread's worktree when the thread exists, else its project's root.
 * A draft thread has no server record yet, so the project is what resolves.
 */
const HardwareWorkspaceTarget = { threadId: ThreadId, projectId: ProjectId };

export const HardwareProjectsInput = Schema.Struct(HardwareWorkspaceTarget);
export type HardwareProjectsInput = typeof HardwareProjectsInput.Type;

export const HardwareProjectsResult = Schema.Struct({
  projects: Schema.Array(HardwareProject),
});
export type HardwareProjectsResult = typeof HardwareProjectsResult.Type;

export const HardwareProjectBuildInput = Schema.Struct({
  ...HardwareWorkspaceTarget,
  path: Schema.String,
});
export type HardwareProjectBuildInput = typeof HardwareProjectBuildInput.Type;

/** A streamed build: output as idf.py prints it, then the parsed result. */
export const HardwareBuildEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("output"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("complete"), result: HardwareBuildResult }),
]);
export type HardwareBuildEvent = typeof HardwareBuildEvent.Type;

const ProjectPath = Schema.String.annotate({
  description: "ESP-IDF project directory (with CMakeLists.txt), relative to the workspace.",
});

export const HardwareSetTargetInput = Schema.Struct({
  path: ProjectPath,
  target: HardwareChipTarget,
});
export type HardwareSetTargetInput = typeof HardwareSetTargetInput.Type;

export const HardwareSetTargetResult = Schema.Struct({
  path: Schema.String,
  target: HardwareChipTarget,
});
export type HardwareSetTargetResult = typeof HardwareSetTargetResult.Type;

/** `y`/`n` options are booleans, ints are numbers, strings and hex are strings. */
export const HardwareSdkconfigValue = Schema.Union([Schema.Boolean, Schema.Number, Schema.String]);
export type HardwareSdkconfigValue = typeof HardwareSdkconfigValue.Type;

export const HardwareSdkconfigEntry = Schema.Struct({
  key: Schema.String,
  value: HardwareSdkconfigValue,
});
export type HardwareSdkconfigEntry = typeof HardwareSdkconfigEntry.Type;

export const HardwareSdkconfigGetInput = Schema.Struct({
  path: ProjectPath,
  keys: Schema.optional(
    Schema.Array(Schema.String).annotate({
      description: "Options to read, with or without the CONFIG_ prefix, e.g. FREERTOS_HZ.",
    }),
  ),
  search: Schema.optional(
    Schema.String.annotate({
      description: "Case-insensitive text to find in option names or values, e.g. flashsize.",
    }),
  ),
});
export type HardwareSdkconfigGetInput = typeof HardwareSdkconfigGetInput.Type;

export const HardwareSdkconfigGetResult = Schema.Struct({
  target: Schema.optional(Schema.String),
  entries: Schema.Array(HardwareSdkconfigEntry),
  /** Requested keys that are not options of this project's configuration. */
  missing: Schema.Array(Schema.String),
  /** More options matched than were returned; narrow the search. */
  truncated: Schema.Boolean,
});
export type HardwareSdkconfigGetResult = typeof HardwareSdkconfigGetResult.Type;

export const HardwareSdkconfigSetInput = Schema.Struct({
  path: ProjectPath,
  values: Schema.Record(Schema.String, HardwareSdkconfigValue).annotate({
    description:
      'Options to set, e.g. {"FREERTOS_HZ": 1000, "ESP_CONSOLE_USB_SERIAL_JTAG": true}. false unsets a bool; hex goes as a string ("0x9000").',
  }),
  persist: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Also record accepted values in sdkconfig.defaults so they survive set-target and a clean checkout. Default true.",
    }),
  ),
});
export type HardwareSdkconfigSetInput = typeof HardwareSdkconfigSetInput.Type;

export const HardwareSdkconfigSetResult = Schema.Struct({
  applied: Schema.Array(HardwareSdkconfigEntry),
  /** Values Kconfig did not keep: unknown option, unmet dependency, or out of range. */
  rejected: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      requested: HardwareSdkconfigValue,
      actual: Schema.optional(HardwareSdkconfigValue),
      reason: Schema.String,
    }),
  ),
  persisted: Schema.Boolean,
});
export type HardwareSdkconfigSetResult = typeof HardwareSdkconfigSetResult.Type;

/** USB serial bridges Kitty recognises by VID:PID. */
export const HardwareSerialPortKind = Schema.Literals([
  "esp-usb-jtag",
  "cp210x",
  "ch34x",
  "ftdi",
  "other",
]);
export type HardwareSerialPortKind = typeof HardwareSerialPortKind.Type;

export const HardwareSerialPort = Schema.Struct({
  device: Schema.String,
  kind: HardwareSerialPortKind,
  /** e.g. "ESP32-S3 native USB (USB-Serial/JTAG)". */
  label: Schema.String,
  vid: Schema.optional(Schema.Int),
  pid: Schema.optional(Schema.Int),
  /** Stays the same when the board re-enumerates; the chip MAC on native USB. */
  serialNumber: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  /** Who holds the port right now: a flash, an agent read, or the panel monitor. */
  heldBy: Schema.optional(Schema.String),
});
export type HardwareSerialPort = typeof HardwareSerialPort.Type;

export const HardwarePortsInput = Schema.Struct({});
export type HardwarePortsInput = typeof HardwarePortsInput.Type;

export const HardwarePortsResult = Schema.Struct({
  ports: Schema.Array(HardwareSerialPort),
});
export type HardwarePortsResult = typeof HardwarePortsResult.Type;

const PortOption = Schema.optional(
  Schema.String.annotate({
    description: "Serial port from hw_ports. Defaults to the only connected board.",
  }),
);

export const HardwareMonitorReadInput = Schema.Struct({
  port: PortOption,
  seconds: Schema.optional(
    Schema.Number.annotate({ description: "How long to listen, 1-60 s. Default 5." }),
  ),
  reset: Schema.optional(
    Schema.Boolean.annotate({
      description: "Reset the board first so the log starts at boot. Default true.",
    }),
  ),
  until: Schema.optional(
    Schema.String.annotate({
      description:
        "Stop as soon as the output matches this regular expression, e.g. 'Hello world'.",
    }),
  ),
  baud: Schema.optional(Schema.Int.annotate({ description: "Default 115200." })),
});
export type HardwareMonitorReadInput = typeof HardwareMonitorReadInput.Type;

export const HardwareMonitorReadResult = Schema.Struct({
  port: Schema.String,
  /** What the board printed, without ANSI colours; the last 16 KB. */
  text: Schema.String,
  bytes: Schema.Int,
  truncated: Schema.Boolean,
  /** Set when `until` was given. */
  matched: Schema.optional(Schema.Boolean),
  durationMs: Schema.Int,
});
export type HardwareMonitorReadResult = typeof HardwareMonitorReadResult.Type;

export const HardwareResetInput = Schema.Struct({ port: PortOption });
export type HardwareResetInput = typeof HardwareResetInput.Type;

export const HardwareResetResult = Schema.Struct({ port: Schema.String });
export type HardwareResetResult = typeof HardwareResetResult.Type;

export const HardwareFlashBackupMode = Schema.Literals(["auto", "always", "skip"]);
export type HardwareFlashBackupMode = typeof HardwareFlashBackupMode.Type;

export const HardwareFlashInput = Schema.Struct({
  path: Schema.String.annotate({
    description: "ESP-IDF project directory, relative to the workspace. Built first if needed.",
  }),
  port: PortOption,
  backup: Schema.optional(
    HardwareFlashBackupMode.annotate({
      description:
        "Save the whole flash before writing: auto = only the first time Kitty flashes this board (default), always, or skip.",
    }),
  ),
});
export type HardwareFlashInput = typeof HardwareFlashInput.Type;

export const HardwareFlashBackup = Schema.Struct({
  /** Absolute path of the image; restore with esptool write_flash 0 <file>. */
  file: Schema.String,
  /** False when an earlier backup of this board was kept instead. */
  created: Schema.Boolean,
});
export type HardwareFlashBackup = typeof HardwareFlashBackup.Type;

export const HardwareFlashResult = Schema.Struct({
  ok: Schema.Boolean,
  port: Schema.String,
  durationMs: Schema.Int,
  backup: Schema.optional(HardwareFlashBackup),
  /** Build diagnostics when the project did not compile. */
  diagnostics: Schema.Array(HardwareBuildDiagnostic),
  logTail: Schema.String,
});
export type HardwareFlashResult = typeof HardwareFlashResult.Type;

export const HardwareProjectFlashInput = Schema.Struct({
  ...HardwareWorkspaceTarget,
  path: Schema.String,
  port: Schema.optional(Schema.String),
});
export type HardwareProjectFlashInput = typeof HardwareProjectFlashInput.Type;

/** A streamed flash from the panel: idf.py / esptool output, then the result. */
export const HardwareFlashEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("output"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("complete"), result: HardwareFlashResult }),
]);
export type HardwareFlashEvent = typeof HardwareFlashEvent.Type;

export const HardwareMonitorInput = Schema.Struct({
  port: Schema.String,
  baud: Schema.optional(Schema.Int),
  reset: Schema.optional(Schema.Boolean),
  /** Changes to start a new monitor session with otherwise equal input. */
  session: Schema.optional(Schema.Int),
});
export type HardwareMonitorInput = typeof HardwareMonitorInput.Type;

/** The panel's serial monitor. It yields the port to a flash or an agent read. */
export const HardwareMonitorEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("output"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("status"),
    status: Schema.Literals(["open", "preempted", "closed"]),
    detail: Schema.optional(Schema.String),
  }),
]);
export type HardwareMonitorEvent = typeof HardwareMonitorEvent.Type;

/** An agent asking to write to a board; the user answers in the Hardware panel. */
export const HardwareApproval = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["flash"]),
  threadId: Schema.optional(ThreadId),
  project: Schema.String,
  port: Schema.String,
  requestedAt: Schema.String,
});
export type HardwareApproval = typeof HardwareApproval.Type;

export const HardwareApprovalsInput = Schema.Struct({});
export type HardwareApprovalsInput = typeof HardwareApprovalsInput.Type;

export const HardwareApprovalsEvent = Schema.Struct({
  pending: Schema.Array(HardwareApproval),
});
export type HardwareApprovalsEvent = typeof HardwareApprovalsEvent.Type;

export const HardwareApprovalRespondInput = Schema.Struct({
  id: Schema.String,
  allow: Schema.Boolean,
});
export type HardwareApprovalRespondInput = typeof HardwareApprovalRespondInput.Type;

export const HardwareToolchainMirror = Schema.Literals(["global", "china"]);
export type HardwareToolchainMirror = typeof HardwareToolchainMirror.Type;

/** Installs Kitty's ESP-IDF through Espressif's installer (EIM). */
export const HardwareToolchainInstallInput = Schema.Struct({
  /** `china` uses Espressif's China mirrors (dl.espressif.cn, Gitee, Aliyun PyPI). */
  mirror: Schema.optional(HardwareToolchainMirror),
});
export type HardwareToolchainInstallInput = typeof HardwareToolchainInstallInput.Type;

export const HardwareToolchainInstallResult = Schema.Struct({
  ok: Schema.Boolean,
  idfVersion: Schema.String,
  durationMs: Schema.Int,
  logTail: Schema.String,
});
export type HardwareToolchainInstallResult = typeof HardwareToolchainInstallResult.Type;

export const HardwareToolchainInstallEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("output"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("complete"), result: HardwareToolchainInstallResult }),
]);
export type HardwareToolchainInstallEvent = typeof HardwareToolchainInstallEvent.Type;

/** Panel actions on a KiCad project; `path` is its .kicad_pro, relative to the workspace. */
export const HardwareDesignInput = Schema.Struct({
  ...HardwareWorkspaceTarget,
  path: Schema.String,
});
export type HardwareDesignInput = typeof HardwareDesignInput.Type;

/** Change a design's schematic from the designer. */
export const HardwareSchematicEditInput = Schema.Struct({
  ...HardwareWorkspaceTarget,
  path: Schema.String,
  edits: Schema.Array(SchematicEdit),
});
export type HardwareSchematicEditInput = typeof HardwareSchematicEditInput.Type;

export const HardwareSchematicHistoryInput = Schema.Struct({
  ...HardwareWorkspaceTarget,
  path: Schema.String,
  step: SchematicHistoryStep,
});
export type HardwareSchematicHistoryInput = typeof HardwareSchematicHistoryInput.Type;

/** Import one JLC part into a design's library. */
export const HardwareJlcImportInput = Schema.Struct({
  ...HardwareWorkspaceTarget,
  path: Schema.String,
  lcsc: Schema.String,
});
export type HardwareJlcImportInput = typeof HardwareJlcImportInput.Type;

export const HardwareTestPlansResult = Schema.Struct({
  plans: Schema.Array(
    Schema.Struct({
      /** The plan file, relative to the workspace. */
      path: Schema.String,
      name: Schema.optional(Schema.String),
      cases: Schema.Int,
      firmware: Schema.optional(Schema.String),
      /** Field-level problems; the plan cannot run until they are fixed. */
      errors: Schema.Array(Schema.String),
      /** The newest Markdown report, relative to the workspace. */
      lastReport: Schema.optional(Schema.String),
    }),
  ),
});
export type HardwareTestPlansResult = typeof HardwareTestPlansResult.Type;

export const HardwareProjectTestRunInput = Schema.Struct({
  ...HardwareWorkspaceTarget,
  plan: Schema.String,
  flash: Schema.optional(Schema.Boolean),
  port: Schema.optional(Schema.String),
});
export type HardwareProjectTestRunInput = typeof HardwareProjectTestRunInput.Type;

export const HardwareProjectTestCreateInput = Schema.Struct({
  ...HardwareWorkspaceTarget,
  root: Schema.optional(Schema.String),
});
export type HardwareProjectTestCreateInput = typeof HardwareProjectTestCreateInput.Type;

export const HardwarePreviewInput = Schema.Struct({
  ...HardwareWorkspaceTarget,
  path: Schema.String,
  kind: Schema.Literals(["schematic", "board"]),
});
export type HardwarePreviewInput = typeof HardwarePreviewInput.Type;

export const HardwareNewProjectInput = Schema.Struct({
  ...HardwareWorkspaceTarget,
  name: Schema.String,
  /** Absolute parent directory; default next to the current project. */
  location: Schema.optional(Schema.String),
});
export type HardwareNewProjectInput = typeof HardwareNewProjectInput.Type;
