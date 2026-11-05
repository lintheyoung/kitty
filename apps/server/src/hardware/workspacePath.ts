import { HardwareToolError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

/** Resolves a tool's project path inside the caller thread's workspace, never outside it. */
export const resolveInWorkspace = Effect.fn("hardware.resolveInWorkspace")(function* (
  workspaceRoot: string,
  requested: string,
) {
  const path = yield* Path.Path;
  const root = path.resolve(workspaceRoot);
  const directory = path.resolve(root, requested.trim());
  if (directory !== root && !directory.startsWith(`${root}${path.sep}`)) {
    return yield* new HardwareToolError({
      code: "invalid_path",
      message: `${requested} is outside this thread's workspace.`,
    });
  }
  return directory;
});
