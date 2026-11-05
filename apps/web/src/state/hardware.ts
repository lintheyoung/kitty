import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

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

export const hardwareBuild = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:hardware:build",
  tag: WS_METHODS.hardwareBuild,
});
