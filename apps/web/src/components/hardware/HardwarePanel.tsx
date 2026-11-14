import type { HardwareDoctorCheck, ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import { ChevronDownIcon, CircleAlertIcon, CircleCheckIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";

import { hardwareDoctor } from "../../state/hardware";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { HardwareApprovalRequests, HardwareBoards } from "./HardwareBoards";
import { BoardTests } from "./BoardTests";
import { HardwareDesigns } from "./HardwareDesigns";
import { HardwareProjects } from "./HardwareProjects";
import { ToolchainInstall } from "./ToolchainInstall";

const TOOL_LABELS: Record<HardwareDoctorCheck["id"], string> = {
  "esp-idf": "ESP-IDF",
  "python-env": "Python",
  esptool: "esptool",
  kicad: "KiCad",
  "jlc-parts": "JLC parts",
  serial: "Board",
};

const STATUS_DOT = {
  ok: "bg-success",
  warning: "bg-warning",
  missing: "bg-destructive",
} as const;

/** The tools Kitty needs, as one line; the details open when asked for or when one is in trouble. */
function SetupStrip(props: {
  readonly tools: ReadonlyArray<HardwareDoctorCheck>;
  readonly checking: boolean;
  readonly onRecheck: () => void;
}) {
  const [open, setOpen] = useState(false);
  const troubled = props.tools.filter((tool) => tool.status !== "ok");
  const ready = troubled.length === 0;
  const detailed = open ? props.tools : troubled;
  return (
    <section className="rounded-lg border bg-card">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          {ready ? (
            <CircleCheckIcon className="size-4 text-success" />
          ) : (
            <CircleAlertIcon className="size-4 text-warning" />
          )}
          {ready ? "Tools ready" : "Setup needs attention"}
        </div>
        <ul className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {props.tools.map((tool) => (
            <li
              key={tool.id}
              className="flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs"
            >
              <span className={cn("size-1.5 rounded-full", STATUS_DOT[tool.status])} />
              {TOOL_LABELS[tool.id]}
              {tool.version ? <span className="text-muted-foreground">{tool.version}</span> : null}
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-1">
          <Button size="xs" variant="ghost-muted" onClick={() => setOpen((shown) => !shown)}>
            Details
            <ChevronDownIcon className={cn("transition-transform", open && "rotate-180")} />
          </Button>
          <Button
            size="xs"
            variant="ghost-muted"
            aria-label="Check the tools again"
            disabled={props.checking}
            onClick={props.onRecheck}
          >
            <RefreshCwIcon className={props.checking ? "animate-spin" : undefined} />
          </Button>
        </div>
      </div>
      {detailed.length > 0 ? (
        <ul className="divide-y border-t px-3">
          {detailed.map((tool) => (
            <li key={tool.id} className="flex flex-col gap-0.5 py-2">
              <div className="flex items-center gap-1.5 text-xs font-medium">
                <span className={cn("size-1.5 rounded-full", STATUS_DOT[tool.status])} />
                {TOOL_LABELS[tool.id]}
              </div>
              <p className="text-xs text-muted-foreground">{tool.detail}</p>
              {tool.path ? (
                <p className="truncate font-mono text-2xs text-muted-foreground/80">{tool.path}</p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** Kitty's hardware page: the board, its firmware, then the design and tests. */
export function HardwarePanel(props: {
  readonly threadRef: ScopedThreadRef;
  /** Null outside a project; the project sections then stay hidden. */
  readonly projectId: ProjectId | null;
}) {
  const query = useEnvironmentQuery(
    hardwareDoctor({ environmentId: props.threadRef.environmentId, input: {} }),
  );
  const report = query.data;
  const tools = report?.checks.filter((check) => check.id !== "serial") ?? [];
  const serial = report?.checks.find((check) => check.id === "serial");
  return (
    <div className="@container flex h-full min-h-0 flex-col overflow-y-auto scrollbar-gutter-both">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 p-3">
        <HardwareApprovalRequests environmentId={props.threadRef.environmentId} />
        {query.error !== null ? (
          <p className="text-sm text-destructive-foreground">{query.error}</p>
        ) : null}
        {report === null ? (
          <p className="text-xs text-muted-foreground">
            {query.isPending ? "Checking the tools…" : "The tools have not been checked yet."}
          </p>
        ) : (
          <SetupStrip tools={tools} checking={query.isPending} onRecheck={() => query.refresh()} />
        )}
        {report?.checks.some(
          (check) =>
            (check.id === "esp-idf" || check.id === "python-env") && check.status === "missing",
        ) ? (
          <ToolchainInstall
            environmentId={props.threadRef.environmentId}
            onInstalled={() => query.refresh()}
          />
        ) : null}
        <div className="grid items-start gap-3 @4xl:grid-cols-2">
          <HardwareBoards
            environmentId={props.threadRef.environmentId}
            hint={serial && serial.status !== "ok" ? serial.detail : undefined}
          />
          {props.projectId === null ? null : (
            <HardwareProjects threadRef={props.threadRef} projectId={props.projectId} />
          )}
        </div>
        {props.projectId === null ? null : (
          <div className="grid items-start gap-3 @4xl:grid-cols-2">
            <HardwareDesigns threadRef={props.threadRef} projectId={props.projectId} />
            <BoardTests threadRef={props.threadRef} projectId={props.projectId} />
          </div>
        )}
      </div>
    </div>
  );
}
