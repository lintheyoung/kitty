import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { ArrowUpCircleIcon } from "lucide-react";
import { useState } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { hardwareEngineNews, hardwareEngineUpdate } from "../../state/hardware";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";

/**
 * Tells of a newer Copper, the engine that draws and routes, and moves to it when asked.
 * Shows nothing while Copper is the tested one and nothing newer is out.
 */
export function EngineUpdate(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
}) {
  const { environmentId, threadId, projectId } = props;
  const news = useEnvironmentQuery(
    hardwareEngineNews({ environmentId, input: { threadId, projectId, action: "check" } }),
  );
  const [open, setOpen] = useState(false);
  const [work, setWork] = useState<{ busy: boolean; note?: string; failed?: boolean }>({
    busy: false,
  });
  const state = news.data;
  if (!state || (state.behind === 0 && state.tested)) return null;

  const run = async (action: "update" | "reset", working: string, done: string) => {
    setWork({ busy: true, note: working });
    const result = await runAtomCommand(
      appAtomRegistry,
      hardwareEngineUpdate,
      { environmentId, input: { threadId, projectId, action } },
      { reportFailure: false },
    );
    setWork(
      result._tag === "Success"
        ? { busy: false, note: done }
        : { busy: false, note: formatEnvironmentQueryError(result.cause), failed: true },
    );
    news.refresh();
  };

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        aria-expanded={open}
        className="flex items-center gap-1 rounded px-1 text-foreground hover:bg-accent"
        onClick={() => setOpen((shown) => !shown)}
      >
        <ArrowUpCircleIcon className="size-3" />
        {state.behind > 0 ? "Copper update" : "Copper: newer than tested"}
      </button>
      {open ? (
        <div className="absolute right-0 bottom-full z-10 mb-1 flex w-96 flex-col gap-2 rounded-md border bg-background p-3 text-xs shadow-md">
          <div className="font-medium text-foreground">
            {state.behind > 0
              ? `Copper has ${state.behind} new change${state.behind === 1 ? "" : "s"}`
              : "You are on a newer Copper than Kitty was tested with"}
          </div>
          <p className="text-muted-foreground">
            Copper is the engine that draws the schematic and routes the board.
            {state.behind > 0
              ? " Kitty checks that the new version starts before it switches, and you can go back."
              : ""}
          </p>
          {state.notes.length > 0 ? (
            <ul className="max-h-40 list-disc overflow-y-auto pl-4 text-muted-foreground">
              {state.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          ) : null}
          <a
            className="text-foreground underline"
            href={state.url}
            target="_blank"
            rel="noreferrer"
          >
            See the changes on GitHub
          </a>
          <div className="flex items-center gap-2">
            {state.behind > 0 ? (
              <Button
                size="xs"
                disabled={work.busy}
                onClick={() =>
                  void run("update", "Getting the new Copper…", "Copper is up to date.")
                }
              >
                Update Copper
              </Button>
            ) : null}
            {state.tested ? null : (
              <Button
                size="xs"
                variant="outline"
                disabled={work.busy}
                onClick={() =>
                  void run("reset", "Going back…", "Back on the Copper Kitty was tested with.")
                }
              >
                Back to the tested version
              </Button>
            )}
          </div>
          {work.note ? (
            <p className={work.failed ? "text-destructive-foreground" : "text-muted-foreground"}>
              {work.note}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
