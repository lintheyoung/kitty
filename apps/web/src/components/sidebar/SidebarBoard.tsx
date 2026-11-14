import type { ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import { ChevronRightIcon, CircuitBoardIcon, CpuIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

import { useRightPanelStore } from "../../rightPanelStore";
import { hardwareDesigns, hardwarePorts } from "../../state/hardware";
import { useEnvironmentQuery } from "../../state/query";

function Row(props: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly status: string;
  /** A lamp before the status: lit when the thing is there. */
  readonly lit?: boolean | undefined;
  readonly onOpen: () => void;
}) {
  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
      onClick={props.onOpen}
    >
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">
        {props.icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm">{props.label}</span>
        <span className="flex items-center gap-1.5 text-2xs text-muted-foreground">
          {props.lit === undefined ? null : (
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                props.lit ? "bg-success" : "bg-muted-foreground/40",
              )}
            />
          )}
          <span className="truncate">{props.status}</span>
        </span>
      </span>
      <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
    </button>
  );
}

/** The board being worked on: its design and the device on the desk, one click from each. */
export function SidebarBoard(props: {
  readonly threadRef: ScopedThreadRef;
  readonly projectId: ProjectId;
  readonly title: string;
}) {
  const { environmentId, threadId } = props.threadRef;
  const designs = useEnvironmentQuery(
    hardwareDesigns({ environmentId, input: { threadId, projectId: props.projectId } }),
  );
  const ports = useEnvironmentQuery(hardwarePorts({ environmentId, input: {} }));
  const design = designs.data?.designs[0];
  const board = ports.data?.ports.find((port) => port.kind !== "other");
  // Both pages belong to one workbench, so both tabs come up and the asked one is in front.
  const open = (page: "designer" | "hardware") => {
    const store = useRightPanelStore.getState();
    store.open(props.threadRef, "designer");
    store.open(props.threadRef, "hardware");
    if (page === "designer") store.open(props.threadRef, "designer");
  };
  return (
    <section className="mb-2 rounded-lg border bg-card/60 p-1">
      <div className="px-2 pt-1.5 pb-1">
        <div className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
          Board
        </div>
        <div className="truncate text-sm font-medium">{props.title}</div>
      </div>
      <Row
        icon={<CircuitBoardIcon />}
        label="Design"
        status={design ? design.name : designs.isPending ? "Looking…" : "No schematic or PCB yet"}
        onOpen={() => open("designer")}
      />
      <Row
        icon={<CpuIcon />}
        label="Device"
        lit={board !== undefined}
        status={board ? board.label : ports.isPending ? "Looking…" : "Not connected"}
        onOpen={() => open("hardware")}
      />
    </section>
  );
}
