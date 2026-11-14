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
  type HardwareProjectTestRunInput,
  type HardwareToolchainInstallInput,
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

/** Installs Kitty's ESP-IDF with Espressif's installer, streaming its log. */
export const hardwareToolchainInstall = createRuntimeCommand(connectionAtomRuntime, {
  label: "environment-data:hardware:toolchain-install",
  execute: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: HardwareToolchainInstallInput;
    readonly onOutput: (text: string) => void;
  }) =>
    runWithOutput(
      input.environmentId,
      runStream(WS_METHODS.hardwareToolchainInstall, input.input),
      input.onOutput,
      "install",
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

/** KiCad projects in a thread's workspace. */
export const hardwareDesigns = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:hardware:designs",
  tag: WS_METHODS.hardwareDesigns,
  staleTimeMs: 10_000,
  idleTtlMs: 5 * 60_000,
});

export const hardwareNewProject = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:hardware:new-project",
  tag: WS_METHODS.hardwareNewProject,
});
export const hardwareErc = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:hardware:erc",
  tag: WS_METHODS.hardwareErc,
});
export const hardwareDrc = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:hardware:drc",
  tag: WS_METHODS.hardwareDrc,
});
export const hardwareBom = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:hardware:bom",
  tag: WS_METHODS.hardwareBom,
});
export const hardwarePreview = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:hardware:preview",
  tag: WS_METHODS.hardwarePreview,
});
/** A design's schematic sheets and board as text, drawn by the designer. */
export const hardwareDesignSource = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:hardware:design-source",
  tag: WS_METHODS.hardwareDesignSource,
  staleTimeMs: 5_000,
  idleTtlMs: 5 * 60_000,
});
/** The board as a glTF model. Exporting takes a few seconds, so it is cached longer. */
export const hardwareBoardModel = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:hardware:board-model",
  tag: WS_METHODS.hardwareBoardModel,
  staleTimeMs: 60_000,
  idleTtlMs: 5 * 60_000,
});
/** Polled by the designer to notice saves from KiCad or the agent. */
export const hardwareDesignStamp = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:hardware:design-stamp",
  tag: WS_METHODS.hardwareDesignStamp,
});
/** JLC's assembly catalogue; every part in a design comes from here. */
export const hardwareJlcSearch = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:hardware:jlc-search",
  tag: WS_METHODS.hardwareJlcSearch,
});
export const hardwareJlcImport = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:hardware:jlc-import",
  tag: WS_METHODS.hardwareJlcImport,
});
/** Changes a design's schematic; the same edits the agent's sch_edit tool makes. */
export const hardwareSchematicEdit = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:hardware:schematic-edit",
  tag: WS_METHODS.hardwareSchematicEdit,
});
export const hardwareSchematicHistory = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:hardware:schematic-history",
  tag: WS_METHODS.hardwareSchematicHistory,
});
/** Keeps or reverts the agent's changes the designer is showing for review. */
export const hardwareSchematicReview = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:hardware:schematic-review",
  tag: WS_METHODS.hardwareSchematicReview,
});
/** Routes the whole board with the auto-router. */
export const hardwareBoardAutoroute = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:hardware:board-autoroute",
  tag: WS_METHODS.hardwareBoardAutoroute,
});
/** One of the designer's buttons that Copper carries out: tidy, sync, pour, order. */
export const hardwareDesignAction = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:hardware:design-action",
  tag: WS_METHODS.hardwareDesignAction,
});
/** Moves parts on the board and sets its outline; the same edits the agent's pcb_edit makes. */
export const hardwareBoardEdit = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:hardware:board-edit",
  tag: WS_METHODS.hardwareBoardEdit,
});
export const hardwareFabExport = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:hardware:fab-export",
  tag: WS_METHODS.hardwareFabExport,
});
export const hardwarePinmapSync = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:hardware:pinmap-sync",
  tag: WS_METHODS.hardwarePinmapSync,
});
export const hardwareOpenInKicad = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:hardware:open-in-kicad",
  tag: WS_METHODS.hardwareOpenInKicad,
});

/** Test plans (tests/test-plan.yaml) in a thread's workspace, with their newest report. */
export const hardwareTestPlans = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:hardware:test-plans",
  tag: WS_METHODS.hardwareTestPlans,
  staleTimeMs: 10_000,
  idleTtlMs: 5 * 60_000,
});

export const hardwareTestCreate = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:hardware:test-create",
  tag: WS_METHODS.hardwareTestCreate,
});

/** Builds and flashes a plan's test firmware, reads the board and judges the cases, streaming the log. */
export const hardwareTestRun = createRuntimeCommand(connectionAtomRuntime, {
  label: "environment-data:hardware:test-run",
  execute: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: HardwareProjectTestRunInput;
    readonly onOutput: (text: string) => void;
  }) =>
    runWithOutput(
      input.environmentId,
      runStream(WS_METHODS.hardwareTestRun, input.input),
      input.onOutput,
      "test run",
    ),
});
