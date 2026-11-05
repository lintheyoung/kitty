import { HardwareToolError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as HardwareService from "../../../hardware/HardwareService.ts";
import { resolveInWorkspace } from "../../../hardware/workspacePath.ts";
import { threadWorkspaceRoot } from "../../../project/threadWorkspaceRoot.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { HardwareToolkit } from "./tools.ts";

const workspaceDirectory = Effect.fn("hardware.workspaceDirectory")(function* (requested: string) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const workspaceRoot = scope.thread
    ? yield* threadWorkspaceRoot(scope.thread.threadId)
    : undefined;
  if (!workspaceRoot) {
    return yield* new HardwareToolError({
      code: "invalid_path",
      message: "This thread has no workspace to put a project in.",
    });
  }
  return yield* resolveInWorkspace(workspaceRoot, requested);
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
});
