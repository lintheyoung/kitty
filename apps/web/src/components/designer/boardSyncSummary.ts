import type { BoardSyncResult } from "@t3tools/contracts";

const parts = (count: number) => `${count} part${count === 1 ? "" : "s"}`;

/** What an update from the schematic did, in a line for the status bar. */
export function boardSyncSummary(result: BoardSyncResult): string {
  const done = [
    result.added.length > 0 ? `added ${parts(result.added.length)}` : "",
    result.updated.length > 0 ? `updated ${parts(result.updated.length)}` : "",
    result.removed.length > 0 ? `removed ${parts(result.removed.length)}` : "",
  ].filter(Boolean);
  const problems = [
    result.missing.length > 0
      ? `No footprint found for ${result.missing.map((part) => part.ref).join(", ")}.`
      : "",
    result.withoutFootprint.length > 0
      ? `No footprint chosen for ${result.withoutFootprint.join(", ")}.`
      : "",
  ].filter(Boolean);
  const head =
    done.length === 0
      ? "The board already matches the schematic."
      : `Board updated: ${done.join(", ")}.`;
  return [head, ...problems].join(" ");
}
