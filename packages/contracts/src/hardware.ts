import * as Schema from "effect/Schema";

import { ProjectId, ThreadId } from "./baseSchemas.ts";

/** Kitty hardware toolchain checks. See docs/kitty/开发计划.md. */
export const HardwareCheckId = Schema.Literals([
  "esp-idf",
  "python-env",
  "esptool",
  "kicad",
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
      "command_failed",
    ]),
    message: Schema.String,
  },
) {}

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
    Schema.Literals(["esp32s3"]).annotate({ description: "Chip target. Default esp32s3." }),
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
