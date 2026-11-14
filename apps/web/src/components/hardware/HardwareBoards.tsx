import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, HardwareSerialPort } from "@t3tools/contracts";
import {
  CheckIcon,
  PlugZapIcon,
  RefreshCwIcon,
  SquareIcon,
  TerminalIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  hardwareApprovalRespond,
  hardwareApprovals,
  hardwareMonitor,
  hardwarePorts,
} from "../../state/hardware";
import { useEnvironmentQuery } from "../../state/query";
import { cn } from "~/lib/utils";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

/** Agent flashes waiting for the user's yes or no. */
export function HardwareApprovalRequests(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const query = useEnvironmentQuery(hardwareApprovals({ environmentId, input: {} }));
  const pending = query.data?.pending ?? [];
  if (pending.length === 0) return null;
  const answer = (id: string, allow: boolean) =>
    void runAtomCommand(appAtomRegistry, hardwareApprovalRespond, {
      environmentId,
      input: { id, allow },
    });
  return (
    <ul className="mb-2 flex flex-col gap-2">
      {pending.map((request) => (
        <li
          key={request.id}
          className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/10 p-2"
        >
          <div className="text-sm">
            <span className="font-medium">The agent wants to flash </span>
            <span className="font-mono">{request.project}</span>
            <span className="font-medium"> to </span>
            <span className="font-mono">{request.port}</span>
          </div>
          <p className="text-xs text-muted-foreground">
            This overwrites the firmware on the board. Kitty saves a full backup the first time it
            flashes a board.
          </p>
          <div className="flex gap-2">
            <Button size="xs" onClick={() => answer(request.id, true)}>
              <CheckIcon />
              Allow
            </Button>
            <Button size="xs" variant="outline" onClick={() => answer(request.id, false)}>
              <XIcon />
              Deny
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}

const STATUS_TEXT = {
  connecting: "Opening…",
  open: "Listening",
  preempted: "Paused",
  closed: "Closed",
} as const;

/** Live serial output; unmounting closes the port. */
function MonitorLog(props: {
  readonly environmentId: EnvironmentId;
  readonly port: string;
  readonly session: number;
  readonly reset: boolean;
  readonly onRestart: (reset: boolean) => void;
}) {
  const query = useEnvironmentQuery(
    hardwareMonitor({
      environmentId: props.environmentId,
      input: { port: props.port, session: props.session, reset: props.reset },
    }),
  );
  const view = query.data;
  const status = view?.status ?? "connecting";
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {STATUS_TEXT[status]}
          {status === "preempted" && view?.detail ? ` (the port went to ${view.detail})` : ""}
        </span>
        <div className="flex gap-1">
          <Button size="xs" variant="ghost" onClick={() => props.onRestart(true)}>
            <RefreshCwIcon />
            Reset board
          </Button>
          {status === "preempted" || status === "closed" ? (
            <Button size="xs" variant="ghost" onClick={() => props.onRestart(false)}>
              <TerminalIcon />
              Resume
            </Button>
          ) : null}
        </div>
      </div>
      {query.error !== null ? (
        <p className="text-xs text-destructive-foreground">{query.error}</p>
      ) : null}
      <div className="flex h-64 flex-col-reverse overflow-auto rounded-md border bg-background p-2">
        <pre className="font-mono text-2xs whitespace-pre-wrap">
          {view && view.log.length > 0 ? view.log : "Waiting for output…"}
        </pre>
      </div>
    </div>
  );
}

/** A development board with its USB cable; the cable and status lamp show whether it is in. */
function BoardArt(props: { readonly connected: boolean }) {
  return (
    <svg
      viewBox="0 0 160 84"
      aria-hidden
      className={cn("h-20 w-auto", props.connected ? "text-success" : "text-muted-foreground/60")}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 42h26" strokeDasharray={props.connected ? undefined : "4 5"} />
      <rect x="28" y="33" width="16" height="18" rx="3" />
      <rect x="44" y="12" width="110" height="60" rx="7" />
      <rect x="78" y="27" width="34" height="30" rx="3" />
      <path d="M124 26v32M132 26v32M140 26v32" strokeWidth="1.5" />
      <path d="M56 12V5M68 12V5M80 12V5M92 12V5M104 12V5M116 12V5M128 12V5M140 12V5" />
      <path d="M56 72v7M68 72v7M80 72v7M92 72v7M104 72v7M116 72v7M128 72v7M140 72v7" />
      <circle
        cx="60"
        cy="42"
        r="4"
        fill={props.connected ? "currentColor" : "none"}
        className={props.connected ? "animate-pulse" : undefined}
      />
    </svg>
  );
}

function PortRow(props: {
  readonly environmentId: EnvironmentId;
  readonly port: HardwareSerialPort;
}) {
  const { port } = props;
  const [monitor, setMonitor] = useState<{ session: number; reset: boolean } | null>(null);
  const board = port.kind !== "other";
  return (
    <li className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        {board ? <BoardArt connected /> : <PlugZapIcon className="size-4 text-muted-foreground" />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            {board ? <Badge variant="success">Connected</Badge> : null}
            {port.heldBy ? <Badge variant="warning">In use: {port.heldBy}</Badge> : null}
          </div>
          <div className={cn("truncate font-medium", board ? "mt-1 text-base" : "text-sm")}>
            {port.label}
          </div>
          <div className="truncate font-mono text-2xs text-muted-foreground">
            {port.device}
            {port.serialNumber ? ` · ${port.serialNumber}` : ""}
          </div>
        </div>
        <Button
          size="sm"
          variant={monitor ? "outline" : board ? "default" : "outline"}
          onClick={() =>
            setMonitor((current) => (current ? null : { session: Date.now(), reset: false }))
          }
        >
          {monitor ? <SquareIcon /> : <TerminalIcon />}
          {monitor ? "Stop" : "Serial monitor"}
        </Button>
      </div>
      {monitor ? (
        <MonitorLog
          key={monitor.session}
          environmentId={props.environmentId}
          port={port.device}
          session={monitor.session}
          reset={monitor.reset}
          onRestart={(reset) => setMonitor({ session: Date.now(), reset })}
        />
      ) : null}
    </li>
  );
}

const CONNECT_STEPS = [
  "Use a USB data cable, not a charge-only one",
  "Plug it straight into this computer, not through a hub",
  "Allow the accessory when macOS asks",
];

/** The board on the desk: whether it is plugged in, and what it is saying. */
export function HardwareBoards(props: {
  readonly environmentId: EnvironmentId;
  /** Why no board was found, from the toolchain check. */
  readonly hint?: string | undefined;
}) {
  const query = useEnvironmentQuery(
    hardwarePorts({ environmentId: props.environmentId, input: {} }),
  );
  const ports = query.data?.ports ?? [];
  const boards = ports.filter((port) => port.kind !== "other");
  const others = ports.filter((port) => port.kind === "other");
  return (
    <section className="rounded-lg border bg-card p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs font-medium text-muted-foreground">Board</div>
        <Button
          size="xs"
          variant="ghost-muted"
          aria-label="Look for boards again"
          disabled={query.isPending}
          onClick={query.refresh}
        >
          <RefreshCwIcon className={query.isPending ? "animate-spin" : undefined} />
        </Button>
      </div>
      {query.error !== null ? (
        <p className="text-xs text-destructive-foreground">{query.error}</p>
      ) : boards.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-md border border-dashed px-4 py-6 text-center">
          <BoardArt connected={false} />
          <div className="text-sm font-medium">
            {query.isPending ? "Looking for a board…" : "No board connected"}
          </div>
          <ol className="flex flex-col gap-1 text-left text-xs text-muted-foreground">
            {CONNECT_STEPS.map((step, index) => (
              <li key={step} className="flex gap-2">
                <span className="flex size-4 shrink-0 items-center justify-center rounded-full border text-2xs">
                  {index + 1}
                </span>
                {step}
              </li>
            ))}
          </ol>
          {props.hint ? <p className="text-2xs text-muted-foreground/80">{props.hint}</p> : null}
        </div>
      ) : (
        <ul className="flex flex-col gap-4">
          {boards.map((port) => (
            <PortRow key={port.device} environmentId={props.environmentId} port={port} />
          ))}
        </ul>
      )}
      {others.length > 0 ? (
        <details className="mt-3 text-xs text-muted-foreground">
          <summary className="cursor-pointer">Other serial ports ({others.length})</summary>
          <ul className="mt-2 flex flex-col gap-3">
            {others.map((port) => (
              <PortRow key={port.device} environmentId={props.environmentId} port={port} />
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
