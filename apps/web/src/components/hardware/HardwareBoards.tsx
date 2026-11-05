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
      <div className="flex max-h-64 flex-col-reverse overflow-auto rounded bg-muted p-2">
        <pre className="font-mono text-2xs whitespace-pre-wrap">
          {view && view.log.length > 0 ? view.log : "Waiting for output…"}
        </pre>
      </div>
    </div>
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
    <li className="flex flex-col gap-2 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            {board ? <PlugZapIcon className="size-3.5 text-success" /> : null}
            <span className="truncate">{port.label}</span>
            {port.heldBy ? <Badge variant="warning">{port.heldBy}</Badge> : null}
          </div>
          <div className="truncate font-mono text-2xs text-muted-foreground">
            {port.device}
            {port.serialNumber ? ` · ${port.serialNumber}` : ""}
          </div>
        </div>
        <Button
          size="xs"
          variant="outline"
          onClick={() =>
            setMonitor((current) => (current ? null : { session: Date.now(), reset: false }))
          }
        >
          {monitor ? <SquareIcon /> : <TerminalIcon />}
          {monitor ? "Stop" : "Monitor"}
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

/** Connected boards, each with a serial monitor. */
export function HardwareBoards(props: { readonly environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(
    hardwarePorts({ environmentId: props.environmentId, input: {} }),
  );
  const ports = query.data?.ports ?? [];
  return (
    <section className="mt-4">
      <div className="mb-1 flex items-center justify-between">
        <div className="text-xs font-medium text-muted-foreground">Boards</div>
        <Button size="xs" variant="ghost" disabled={query.isPending} onClick={query.refresh}>
          <RefreshCwIcon className={query.isPending ? "animate-spin" : undefined} />
        </Button>
      </div>
      {query.error !== null ? (
        <p className="text-xs text-destructive-foreground">{query.error}</p>
      ) : ports.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {query.isPending ? "Looking for boards…" : "No board connected."}
        </p>
      ) : (
        <ul className="divide-y">
          {ports.map((port) => (
            <PortRow key={port.device} environmentId={props.environmentId} port={port} />
          ))}
        </ul>
      )}
    </section>
  );
}
