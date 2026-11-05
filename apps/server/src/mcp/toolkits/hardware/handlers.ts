import { HardwareToolError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as HardwareService from "../../../hardware/HardwareService.ts";
import * as KicadService from "../../../hardware/KicadService.ts";
import { resolveInWorkspace } from "../../../hardware/workspacePath.ts";
import { threadWorkspaceRoot } from "../../../project/threadWorkspaceRoot.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { HardwareToolkit } from "./tools.ts";

const callerWorkspaceRoot = Effect.fn("hardware.callerWorkspaceRoot")(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const workspaceRoot = scope.thread
    ? yield* threadWorkspaceRoot(scope.thread.threadId)
    : undefined;
  if (!workspaceRoot) {
    return yield* new HardwareToolError({
      code: "invalid_path",
      message: "This thread has no workspace.",
    });
  }
  return workspaceRoot;
});

const workspaceDirectory = Effect.fn("hardware.workspaceDirectory")(function* (requested: string) {
  return yield* resolveInWorkspace(yield* callerWorkspaceRoot(), requested);
});

export const layer = McpToolAccess.toLayer(HardwareToolkit, {
  hw_doctor: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const hardware = yield* HardwareService.HardwareService;
      return yield* hardware.doctor(input);
    }),
  ),
  hw_chip_info: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const hardware = yield* HardwareService.HardwareService;
      return yield* hardware.chipInfo(input);
    }),
  ),
  hw_project_create: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const hardware = yield* HardwareService.HardwareService;
      const directory = yield* workspaceDirectory(input.path);
      return yield* hardware.createProject({ ...input, directory });
    }),
  ),
  hw_build: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const hardware = yield* HardwareService.HardwareService;
      const directory = yield* workspaceDirectory(input.path);
      return yield* hardware.build({ ...input, directory });
    }),
  ),
  hw_set_target: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const hardware = yield* HardwareService.HardwareService;
      const directory = yield* workspaceDirectory(input.path);
      return yield* hardware.setTarget({ ...input, directory });
    }),
  ),
  hw_sdkconfig_get: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const hardware = yield* HardwareService.HardwareService;
      const directory = yield* workspaceDirectory(input.path);
      return yield* hardware.sdkconfigGet({ ...input, directory });
    }),
  ),
  hw_sdkconfig_set: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const hardware = yield* HardwareService.HardwareService;
      const directory = yield* workspaceDirectory(input.path);
      return yield* hardware.sdkconfigSet({ ...input, directory });
    }),
  ),
  kicad_erc: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const kicad = yield* KicadService.KicadService;
      return yield* kicad.erc({ ...input, workspaceRoot: yield* callerWorkspaceRoot() });
    }),
  ),
  kicad_drc: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const kicad = yield* KicadService.KicadService;
      return yield* kicad.drc({ ...input, workspaceRoot: yield* callerWorkspaceRoot() });
    }),
  ),
  kicad_netlist: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const kicad = yield* KicadService.KicadService;
      return yield* kicad.netlist({ ...input, workspaceRoot: yield* callerWorkspaceRoot() });
    }),
  ),
  kicad_bom: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const kicad = yield* KicadService.KicadService;
      return yield* kicad.bom({ ...input, workspaceRoot: yield* callerWorkspaceRoot() });
    }),
  ),
  kicad_fab_export: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const kicad = yield* KicadService.KicadService;
      return yield* kicad.fabExport({ ...input, workspaceRoot: yield* callerWorkspaceRoot() });
    }),
  ),
});
