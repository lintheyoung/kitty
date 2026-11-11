import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  KicadDrcResult,
  KicadErcResult,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { hardwareDesignStamp, hardwareDrc, hardwareErc } from "../../state/hardware";
import { formatEnvironmentQueryError } from "../../state/query";

interface Target {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  /** The design's .kicad_pro; undefined while no design is chosen. */
  readonly path: string | undefined;
}

export interface DesignChecks {
  readonly erc?: KicadErcResult;
  readonly drc?: KicadDrcResult;
  readonly running: boolean;
  readonly error?: string;
  /** The design the results belong to. */
  readonly path?: string;
}

const options = { reportFailure: false } as const;

/** Runs KiCad's ERC and DRC for a design on request. */
export function useDesignChecks(target: Target, hasSchematic: boolean, hasBoard: boolean) {
  const [checks, setChecks] = useState<DesignChecks>({ running: false });
  const run = async () => {
    const { environmentId, threadId, projectId, path } = target;
    if (!path) return;
    setChecks((previous) => ({ ...previous, running: true }));
    const input = { environmentId, input: { threadId, projectId, path } };
    const [erc, drc] = await Promise.all([
      hasSchematic ? runAtomCommand(appAtomRegistry, hardwareErc, input, options) : undefined,
      hasBoard ? runAtomCommand(appAtomRegistry, hardwareDrc, input, options) : undefined,
    ]);
    const failed = [erc, drc].find((result) => result?._tag === "Failure");
    setChecks({
      running: false,
      path,
      ...(erc?._tag === "Success" ? { erc: erc.value } : {}),
      ...(drc?._tag === "Success" ? { drc: drc.value } : {}),
      ...(failed?._tag === "Failure" ? { error: formatEnvironmentQueryError(failed.cause) } : {}),
    });
  };
  // Results of another design are not this design's problems.
  const current = checks.path === target.path ? checks : { running: checks.running };
  return { checks: current as DesignChecks, run };
}

const POLL_MS = 2500;

/** Calls `onChange` when the design's files are saved by KiCad, the agent or anyone else. */
export function useDesignWatcher(target: Target, onChange: () => void) {
  const changed = useStableCallback(onChange);
  const { environmentId, threadId, projectId, path } = target;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the server for saved design files while the designer is open
  useEffect(() => {
    if (!path) return;
    let last: string | undefined;
    let stopped = false;
    const check = async () => {
      if (document.visibilityState !== "visible") return;
      const result = await runAtomCommand(
        appAtomRegistry,
        hardwareDesignStamp,
        { environmentId, input: { threadId, projectId, path } },
        options,
      );
      if (stopped || result._tag !== "Success") return;
      const stamp = result.value.stamp;
      if (last !== undefined && last !== stamp) changed();
      last = stamp;
    };
    void check();
    const timer = window.setInterval(() => void check(), POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [environmentId, threadId, projectId, path, changed]);
}
