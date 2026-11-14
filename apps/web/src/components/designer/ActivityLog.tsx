import type { SchematicChange } from "@t3tools/contracts";
import { HistoryIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";

const WHO = { user: "You", agent: "Kitty" } as const;

const clock = (at: string) => {
  const time = new Date(at);
  return Number.isNaN(time.getTime())
    ? ""
    : time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

/**
 * What has been done to the design, newest first: every change by hand, in KiCad or by
 * the agent. The same log the agent reads, so both sides see one history.
 */
export function ActivityLog(props: { readonly changes: ReadonlyArray<SchematicChange> }) {
  const [open, setOpen] = useState(false);
  const newest = props.changes.at(-1);
  if (!newest) return null;
  return (
    <div className="relative min-w-0 shrink">
      <button
        type="button"
        aria-expanded={open}
        className="flex max-w-96 min-w-0 items-center gap-1.5 rounded px-1 hover:bg-accent hover:text-foreground"
        onClick={() => setOpen((shown) => !shown)}
      >
        <HistoryIcon className="size-3 shrink-0" />
        <span
          className={cn(
            "shrink-0 font-medium",
            newest.by === "agent" ? "text-foreground" : "text-success",
          )}
        >
          {WHO[newest.by]}
        </span>
        <span className="truncate">{newest.summary[0]}</span>
      </button>
      {open ? (
        <div className="absolute bottom-full left-0 z-10 mb-1 flex max-h-80 w-[28rem] flex-col rounded-md border bg-background text-xs shadow-md">
          <div className="border-b px-2 py-1.5 font-medium text-foreground">
            Activity
            <span className="font-normal text-muted-foreground">
              {" "}
              · what you and Kitty changed; Kitty reads this too
            </span>
          </div>
          <ol className="min-h-0 overflow-y-auto p-1">
            {props.changes.toReversed().map((change) => (
              <li key={`${change.at}:${change.summary[0]}`} className="flex gap-2 px-1.5 py-1">
                <span className="w-10 shrink-0 text-muted-foreground tabular-nums">
                  {clock(change.at)}
                </span>
                <span
                  className={cn(
                    "w-8 shrink-0 font-medium",
                    change.by === "agent" ? "text-foreground" : "text-success",
                  )}
                >
                  {WHO[change.by]}
                </span>
                <span className="min-w-0 break-words text-muted-foreground">
                  {change.summary.join("; ")}
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}
