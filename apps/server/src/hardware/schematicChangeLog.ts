/** A design's change log: who changed the schematic, when, and what they did. */
import type { SchematicChange } from "@t3tools/contracts";

/** The log sits beside the design, one JSON object per line. */
export const CHANGE_LOG_FILE = ".kitty/changes.jsonl";
const KEEP = 500;

const isChange = (value: unknown): value is SchematicChange => {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.at === "string" &&
    (entry.by === "user" || entry.by === "agent") &&
    Array.isArray(entry.summary) &&
    entry.summary.every((line) => typeof line === "string")
  );
};

/** The entries of a log file, oldest first; lines that are not entries are skipped. */
export function parseChangeLog(text: string): ReadonlyArray<SchematicChange> {
  const changes: Array<SchematicChange> = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const entry: unknown = JSON.parse(line);
      if (isChange(entry)) changes.push({ at: entry.at, by: entry.by, summary: entry.summary });
    } catch {
      // A damaged line loses one entry, not the log.
    }
  }
  return changes;
}

/** The log with `change` added, trimmed to the newest entries. */
export function appendChange(text: string, change: SchematicChange): string {
  const changes = [...parseChangeLog(text), change].slice(-KEEP);
  return `${changes.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

/** What the user did by hand after the agent's last edit, one line per edit. */
export function userChangesSinceAgent(
  changes: ReadonlyArray<SchematicChange>,
): ReadonlyArray<string> {
  const lastAgent = changes.findLastIndex((change) => change.by === "agent");
  return changes
    .slice(lastAgent + 1)
    .filter((change) => change.by === "user")
    .flatMap((change) => change.summary);
}
