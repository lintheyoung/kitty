import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { EnvironmentRegistry, EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import { runStream } from "@t3tools/client-runtime/rpc";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type HardwareProjectBuildInput,
  type HardwareProjectFlashInput,
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

type OutputEvent<R> =
  | { readonly type: "output"; readonly text: string }
  | { readonly type: "complete"; readonly result: R };

/** Runs a streamed hardware RPC, handing output to `onOutput` and returning the final result. */
const runWithOutput = <R, E>(
  environmentId: EnvironmentId,
  stream: Stream.Stream<OutputEvent<R>, E, EnvironmentSupervisor.EnvironmentSupervisor>,
  onOutput: (text: string) => void,
  what: string,
) =>
  Effect.flatMap(EnvironmentRegistry.EnvironmentRegistry, (registry) =>
    registry
      .runStream(
        environmentId,
        stream.pipe(
          Stream.tap((event) =>
            event.type === "output" ? Effect.sync(() => onOutput(event.text)) : Effect.void,
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
                  message: `The ${what} ended without a result.`,
                }),
              ),
        ),
      ),
  );

/** Builds a project, handing each chunk of `idf.py` output to `onOutput` as it arrives. */
export const hardwareBuild = createRuntimeCommand(connectionAtomRuntime, {
  label: "environment-data:hardware:build",
  execute: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: HardwareProjectBuildInput;
    readonly onOutput: (text: string) => void;
  }) =>
    runWithOutput(
      input.environmentId,
      runStream(WS_METHODS.hardwareBuild, input.input),
      input.onOutput,
      "build",
    ),
});

/** Flashes a project (backing the board up the first time), streaming the log. */
export const hardwareFlash = createRuntimeCommand(connectionAtomRuntime, {
  label: "environment-data:hardware:flash",
  execute: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: HardwareProjectFlashInput;
    readonly onOutput: (text: string) => void;
  }) =>
    runWithOutput(
      input.environmentId,
      runStream(WS_METHODS.hardwareFlash, input.input),
      input.onOutput,
      "flash",
    ),
});

/** Serial ports and who holds them. */
export const hardwarePorts = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:hardware:ports",
  tag: WS_METHODS.hardwarePorts,
  staleTimeMs: 3_000,
  idleTtlMs: 60_000,
});

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
/** Keeps the live log bounded in the browser. */
const MAX_MONITOR_CHARS = 64_000;

export interface HardwareMonitorView {
  readonly status: "connecting" | "open" | "preempted" | "closed";
  readonly detail?: string | undefined;
  readonly log: string;
}

/** The panel's live serial monitor; unsubscribing closes the port. */
export const hardwareMonitor = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:hardware:monitor",
  tag: WS_METHODS.hardwareMonitor,
  idleTtlMs: 0,
  completeWhen: (view: HardwareMonitorView) =>
    view.status === "closed" || view.status === "preempted",
  transform: (stream) =>
    stream.pipe(
      Stream.scan(
        (): HardwareMonitorView => ({ status: "connecting", log: "" }),
        (view, event): HardwareMonitorView =>
          event.type === "output"
            ? {
                ...view,
                log: (view.log + event.text.replace(ANSI, "").replaceAll("\r\n", "\n")).slice(
                  -MAX_MONITOR_CHARS,
                ),
              }
            : // Keep "preempted" when the stream then reports it closed.
              view.status === "preempted"
              ? view
              : { ...view, status: event.status, detail: event.detail },
      ),
    ),
});

/** Agent flashes waiting for the user. */
export const hardwareApprovals = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:hardware:approvals",
  tag: WS_METHODS.hardwareApprovals,
});

export const hardwareApprovalRespond = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:hardware:approval-respond",
  tag: WS_METHODS.hardwareApprovalRespond,
});
