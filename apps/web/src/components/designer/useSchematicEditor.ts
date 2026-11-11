import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectId,
  SchematicEdit,
  SchematicEditResult,
  SchematicHistoryStep,
  SchematicReviewDecision,
  ThreadId,
} from "@t3tools/contracts";
import { useState } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  hardwareSchematicEdit,
  hardwareSchematicHistory,
  hardwareSchematicReview,
} from "../../state/hardware";
import { formatEnvironmentQueryError } from "../../state/query";

interface Target {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  /** The design's .kicad_pro; undefined while no design is chosen. */
  readonly path: string | undefined;
}

const options = { reportFailure: false } as const;

/** Makes changes to a design's schematic and steps through their history. */
export function useSchematicEditor(target: Target, onChanged: () => void) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>();

  const apply = async (
    edits: ReadonlyArray<SchematicEdit>,
  ): Promise<SchematicEditResult | undefined> => {
    const { environmentId, threadId, projectId, path } = target;
    if (!path || busy) return undefined;
    setBusy(true);
    setMessage(undefined);
    const result = await runAtomCommand(
      appAtomRegistry,
      hardwareSchematicEdit,
      { environmentId, input: { threadId, projectId, path, edits } },
      options,
    );
    setBusy(false);
    if (result._tag !== "Success") {
      setMessage(formatEnvironmentQueryError(result.cause));
      return undefined;
    }
    onChanged();
    return result.value;
  };

  const step = async (direction: SchematicHistoryStep) => {
    const { environmentId, threadId, projectId, path } = target;
    if (!path || busy) return;
    setBusy(true);
    setMessage(undefined);
    const result = await runAtomCommand(
      appAtomRegistry,
      hardwareSchematicHistory,
      { environmentId, input: { threadId, projectId, path, step: direction } },
      options,
    );
    setBusy(false);
    if (result._tag !== "Success") return setMessage(formatEnvironmentQueryError(result.cause));
    if (!result.value.applied) return setMessage(`Nothing to ${direction}.`);
    onChanged();
  };

  /** Keeps or reverts the agent's changes that are shown for review. */
  const review = async (decision: SchematicReviewDecision) => {
    const { environmentId, threadId, projectId, path } = target;
    if (!path || busy) return;
    setBusy(true);
    setMessage(undefined);
    const result = await runAtomCommand(
      appAtomRegistry,
      hardwareSchematicReview,
      { environmentId, input: { threadId, projectId, path, decision } },
      options,
    );
    setBusy(false);
    if (result._tag !== "Success") return setMessage(formatEnvironmentQueryError(result.cause));
    onChanged();
  };

  return { busy, message, apply, step, review };
}
