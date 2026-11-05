import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { runStream } from "@t3tools/client-runtime/rpc";
import {
  createEnvironmentRpcQueryAtomFamily,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type HardwareProjectBuildInput,
  HardwareToolError,
  WS_METHODS,
} from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

/** Kitty toolchain report from the environment that owns the board. */
export const hardwareDoctor = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:hardware:doctor",
  tag: WS_METHODS.hardwareDoctor,
  staleTimeMs: 10_000,
  idleTtlMs: 5 * 60_000,
});

/** ESP-IDF projects in a thread's workspace. */
export const hardwareProjects = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:hardware:projects",
  tag: WS_METHODS.hardwareProjects,
  staleTimeMs: 10_000,
  idleTtlMs: 5 * 60_000,
});

/** Builds a project, handing each chunk of `idf.py` output to `onOutput` as it arrives. */
export const hardwareBuild = createRuntimeCommand(connectionAtomRuntime, {
  label: "environment-data:hardware:build",
  execute: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: HardwareProjectBuildInput;
    readonly onOutput: (text: string) => void;
  }) =>
    Effect.flatMap(EnvironmentRegistry.EnvironmentRegistry, (registry) =>
      registry
        .runStream(
          input.environmentId,
          runStream(WS_METHODS.hardwareBuild, input.input).pipe(
            Stream.tap((event) =>
              event.type === "output" ? Effect.sync(() => input.onOutput(event.text)) : Effect.void,
            ),
          ),
        )
        .pipe(
          Stream.runLast,
          Effect.flatMap((last) =>
            Option.isSome(last) && last.value.type === "complete"
              ? Effect.succeed(last.value.result)
              : Effect.fail(
                  new HardwareToolError({
                    code: "command_failed",
                    message: "The build ended without a result.",
                  }),
                ),
          ),
        ),
    ),
});
