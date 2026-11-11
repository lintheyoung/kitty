import { HardwareToolError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as HardwareService from "../../../hardware/HardwareService.ts";
import * as JlcPartsService from "../../../hardware/JlcPartsService.ts";
import * as KicadService from "../../../hardware/KicadService.ts";
import { createBoardTest, runBoardTests } from "../../../hardware/boardTestRunner.ts";
import { createHardwareRepo } from "../../../hardware/newHardwareProject.ts";
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
  hw_ports: McpToolAccess.actsAsCaller(() =>
    Effect.gen(function* () {
      const hardware = yield* HardwareService.HardwareService;
      return yield* hardware.ports;
    }),
  ),
  hw_monitor_read: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const hardware = yield* HardwareService.HardwareService;
      return yield* hardware.monitorRead(input);
    }),
  ),
  hw_reset: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const hardware = yield* HardwareService.HardwareService;
      return yield* hardware.reset(input);
    }),
  ),
  hw_flash: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const hardware = yield* HardwareService.HardwareService;
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const directory = yield* workspaceDirectory(input.path);
      return yield* hardware.flash(
        { ...input, directory },
        { approvalFor: { threadId: scope.thread?.threadId } },
      );
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
  jlc_part_search: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const jlc = yield* JlcPartsService.JlcPartsService;
      return yield* jlc.search(input);
    }),
  ),
  jlc_part_import: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const jlc = yield* JlcPartsService.JlcPartsService;
      return yield* jlc.importPart({ ...input, workspaceRoot: yield* callerWorkspaceRoot() });
    }),
  ),
  sch_edit: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const kicad = yield* KicadService.KicadService;
      return yield* kicad.schematicEdit({ ...input, workspaceRoot: yield* callerWorkspaceRoot() });
    }),
  ),
  hw_project_inspect: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const kicad = yield* KicadService.KicadService;
      return yield* kicad.projectInspect({ ...input, workspaceRoot: yield* callerWorkspaceRoot() });
    }),
  ),
  hw_pinmap_sync: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const kicad = yield* KicadService.KicadService;
      return yield* kicad.pinmapSync({ ...input, workspaceRoot: yield* callerWorkspaceRoot() });
    }),
  ),
  hw_pin_check: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const kicad = yield* KicadService.KicadService;
      return yield* kicad.pinCheck({ ...input, workspaceRoot: yield* callerWorkspaceRoot() });
    }),
  ),
  hw_test_firmware_create: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      return yield* createBoardTest({ ...input, workspaceRoot: yield* callerWorkspaceRoot() });
    }),
  ),
  hw_test_run: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      return yield* runBoardTests(
        { ...input, workspaceRoot: yield* callerWorkspaceRoot() },
        { approvalFor: { threadId: scope.thread?.threadId } },
      );
    }),
  ),
  hw_hardware_project_new: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      return yield* createHardwareRepo({ ...input, nextTo: yield* callerWorkspaceRoot() });
    }),
  ),
});
