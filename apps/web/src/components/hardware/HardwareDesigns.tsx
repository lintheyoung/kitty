import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type {
  HardwarePinmapSyncResult,
  KicadBomResult,
  KicadCheckSummary,
  KicadDesign,
  KicadFabExportResult,
  KicadViolation,
  ProjectId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  CpuIcon,
  ExternalLinkIcon,
  FileArchiveIcon,
  ListChecksIcon,
  LoaderCircleIcon,
  PlusIcon,
  ShieldCheckIcon,
  TableIcon,
} from "lucide-react";
import type * as Cause from "effect/Cause";
import { useState } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  hardwareBom,
  hardwareDesigns,
  hardwareDrc,
  hardwareErc,
  hardwareFabExport,
  hardwareNewProject,
  hardwareOpenInKicad,
  hardwarePinmapSync,
  hardwareProjects,
} from "../../state/hardware";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

type Action = "erc" | "drc" | "bom" | "fab" | "pinmap";

type Outcome =
  | { readonly action: Action; readonly status: "running" }
  | { readonly action: Action; readonly status: "failed"; readonly message: string }
  | { readonly action: "erc" | "drc"; readonly status: "done"; readonly check: CheckView }
  | { readonly action: "bom"; readonly status: "done"; readonly bom: KicadBomResult }
  | { readonly action: "fab"; readonly status: "done"; readonly fab: KicadFabExportResult }
  | {
      readonly action: "pinmap";
      readonly status: "done";
      readonly pinmap: HardwarePinmapSyncResult;
    };

interface CheckView {
  readonly summary: KicadCheckSummary;
  readonly violations: ReadonlyArray<KicadViolation>;
  readonly truncated: boolean;
}

const ACTIONS: ReadonlyArray<{
  readonly id: Action;
  readonly label: string;
  readonly needs: "schematic" | "board";
  readonly icon: typeof ShieldCheckIcon;
}> = [
  { id: "erc", label: "ERC", needs: "schematic", icon: ShieldCheckIcon },
  { id: "drc", label: "DRC", needs: "board", icon: ShieldCheckIcon },
  { id: "bom", label: "BOM", needs: "schematic", icon: TableIcon },
  { id: "pinmap", label: "Pinmap", needs: "schematic", icon: CpuIcon },
  { id: "fab", label: "Fab files", needs: "board", icon: FileArchiveIcon },
];

function CheckResult(props: { readonly check: CheckView }) {
  const { summary, violations, truncated } = props.check;
  const [open, setOpen] = useState(false);
  const clean = summary.errors === 0 && summary.warnings === 0;
  return (
    <div className="flex flex-col gap-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
        <Badge variant={summary.errors > 0 ? "error" : clean ? "success" : "warning"}>
          {clean ? "Clean" : `${summary.errors} error(s), ${summary.warnings} warning(s)`}
        </Badge>
        {summary.byType.slice(0, 6).map((entry) => (
          <span key={entry.type} className="font-mono text-2xs">
            {entry.type} ×{entry.count}
          </span>
        ))}
      </div>
      {violations.length > 0 ? (
        <Button size="xs" variant="ghost" className="self-start" onClick={() => setOpen(!open)}>
          <ListChecksIcon />
          {open ? "Hide details" : `Show ${violations.length}${truncated ? "+" : ""} details`}
        </Button>
      ) : null}
      {open ? (
        <ul className="flex max-h-64 flex-col gap-1 overflow-auto">
          {violations.map((violation, index) => (
            // Violations repeat (same check, same text) at different places; order is stable.
            // oxlint-disable-next-line react/no-array-index-key -- a report's violations have no ids
            <li key={index}>
              <span
                className={
                  violation.severity === "error"
                    ? "text-destructive-foreground"
                    : "text-warning-foreground"
                }
              >
                {violation.description}
              </span>
              {violation.items.length > 0 ? (
                <div className="font-mono text-2xs text-muted-foreground">
                  {violation.items.map((item) => item.description).join(" · ")}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function BomResult(props: { readonly bom: KicadBomResult }) {
  const { bom } = props;
  if (bom.lines.length === 0) {
    return <p className="text-xs text-muted-foreground">The schematic has no parts yet.</p>;
  }
  const unsourced = new Set(bom.unsourced);
  return (
    <div className="flex flex-col gap-1 text-xs">
      <div className="text-muted-foreground">
        {bom.lines.length} line(s), {bom.totalParts} part(s)
        {bom.unsourced.length > 0 ? ` · ${bom.unsourced.length} without LCSC/MPN` : ""}
      </div>
      <div className="max-h-64 overflow-auto">
        <table className="w-full text-left text-2xs">
          <thead className="text-muted-foreground">
            <tr>
              <th className="pr-2 font-medium">Refs</th>
              <th className="pr-2 font-medium">Qty</th>
              <th className="pr-2 font-medium">Value</th>
              <th className="font-medium">LCSC / MPN</th>
            </tr>
          </thead>
          <tbody>
            {bom.lines.map((line) => (
              <tr key={line.refs.join(",")}>
                <td className="pr-2 font-mono">{line.refs.join(", ")}</td>
                <td className="pr-2">{line.quantity}</td>
                <td className="pr-2">{line.value}</td>
                <td
                  className={
                    line.refs.some((ref) => unsourced.has(ref))
                      ? "font-mono text-warning-foreground"
                      : "font-mono"
                  }
                >
                  {line.lcsc ?? line.mpn ?? "missing"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function OutcomeView(props: { readonly outcome: Outcome }) {
  const { outcome } = props;
  if (outcome.status === "running") return null;
  if (outcome.status === "failed") {
    return <p className="text-xs text-destructive-foreground">{outcome.message}</p>;
  }
  switch (outcome.action) {
    case "erc":
    case "drc":
      return <CheckResult check={outcome.check} />;
    case "bom":
      return <BomResult bom={outcome.bom} />;
    case "fab":
      return (
        <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          <span>
            {outcome.fab.gerbers.length} Gerber file(s), {outcome.fab.drill.length} drill file(s)
          </span>
          {outcome.fab.zip ? (
            <span className="font-mono text-2xs break-all">Upload: {outcome.fab.zip}</span>
          ) : null}
          {outcome.fab.positions ? (
            <span className="font-mono text-2xs break-all">Positions: {outcome.fab.positions}</span>
          ) : null}
        </div>
      );
    case "pinmap":
      return (
        <div className="text-xs text-muted-foreground">
          {outcome.pinmap.mcu.ref} ({outcome.pinmap.mcu.part}): {outcome.pinmap.connected} of{" "}
          {outcome.pinmap.gpios} GPIOs connected
          {outcome.pinmap.changes.length > 0 ? ` · ${outcome.pinmap.changes.length} change(s)` : ""}
          <div className="font-mono text-2xs break-all">{outcome.pinmap.pinmap}</div>
        </div>
      );
  }
}

function DesignRow(props: {
  readonly threadRef: ScopedThreadRef;
  readonly projectId: ProjectId;
  readonly design: KicadDesign;
}) {
  const { design } = props;
  const { environmentId, threadId } = props.threadRef;
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const input = { threadId, projectId: props.projectId, path: design.project };
  const running = outcome?.status === "running" ? outcome.action : null;

  const run = async (action: Action) => {
    setOutcome({ action, status: "running" });
    const options = { reportFailure: false } as const;
    const target = { environmentId, input };
    const fail = (cause: Cause.Cause<unknown>): Outcome => ({
      action,
      status: "failed",
      message: formatEnvironmentQueryError(cause),
    });
    let next: Outcome;
    if (action === "erc") {
      const result = await runAtomCommand(appAtomRegistry, hardwareErc, target, options);
      next =
        result._tag === "Success"
          ? { action, status: "done", check: result.value }
          : fail(result.cause);
    } else if (action === "drc") {
      const result = await runAtomCommand(appAtomRegistry, hardwareDrc, target, options);
      next =
        result._tag === "Success"
          ? { action, status: "done", check: result.value }
          : fail(result.cause);
    } else if (action === "bom") {
      const result = await runAtomCommand(appAtomRegistry, hardwareBom, target, options);
      next =
        result._tag === "Success"
          ? { action, status: "done", bom: result.value }
          : fail(result.cause);
    } else if (action === "fab") {
      const result = await runAtomCommand(appAtomRegistry, hardwareFabExport, target, options);
      next =
        result._tag === "Success"
          ? { action, status: "done", fab: result.value }
          : fail(result.cause);
    } else {
      const result = await runAtomCommand(appAtomRegistry, hardwarePinmapSync, target, options);
      next =
        result._tag === "Success"
          ? { action, status: "done", pinmap: result.value }
          : fail(result.cause);
    }
    setOutcome(next);
  };

  return (
    <li className="flex flex-col gap-2 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{design.name}</div>
          <div className="truncate font-mono text-2xs text-muted-foreground">{design.project}</div>
        </div>
        <Button
          size="xs"
          variant="outline"
          onClick={() =>
            void runAtomCommand(appAtomRegistry, hardwareOpenInKicad, { environmentId, input })
          }
        >
          <ExternalLinkIcon />
          Open in KiCad
        </Button>
      </div>
      <div className="flex flex-wrap gap-1">
        {ACTIONS.map((action) => {
          const available = action.needs === "schematic" ? design.schematic : design.board;
          const Icon = action.icon;
          return (
            <Button
              key={action.id}
              size="xs"
              variant="outline"
              disabled={!available || running !== null}
              onClick={() => void run(action.id)}
            >
              {running === action.id ? <LoaderCircleIcon className="animate-spin" /> : <Icon />}
              {action.label}
            </Button>
          );
        })}
      </div>
      {outcome ? <OutcomeView outcome={outcome} /> : null}
    </li>
  );
}

/** Starts an empty ESP32-S3 hardware project: blank KiCad design plus ESP-IDF firmware. */
function NewHardwareProject(props: {
  readonly threadRef: ScopedThreadRef;
  readonly projectId: ProjectId;
  readonly onCreated: () => void;
  readonly onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [state, setState] = useState<{ running: boolean; error: string | null }>({
    running: false,
    error: null,
  });
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  const create = async () => {
    setState({ running: true, error: null });
    const result = await runAtomCommand(
      appAtomRegistry,
      hardwareNewProject,
      {
        environmentId: props.threadRef.environmentId,
        input: {
          threadId: props.threadRef.threadId,
          projectId: props.projectId,
          path: slug,
          name: name.trim(),
        },
      },
      { reportFailure: false },
    );
    if (result._tag === "Success") {
      setState({ running: false, error: null });
      props.onCreated();
    } else {
      setState({ running: false, error: formatEnvironmentQueryError(result.cause) });
    }
  };

  return (
    <div className="mb-2 flex flex-col gap-2 rounded-md border p-2">
      <div className="text-xs text-muted-foreground">
        Creates a blank KiCad 10 project and an ESP-IDF firmware for the ESP32-S3, in a new folder.
      </div>
      <Input
        size="sm"
        placeholder="Board name, e.g. KeyCAP"
        value={name}
        disabled={state.running}
        onChange={(event) => setName(event.target.value)}
      />
      {slug ? (
        <div className="font-mono text-2xs text-muted-foreground">Folder: {slug}/</div>
      ) : null}
      <div className="flex gap-1">
        <Button size="xs" disabled={!slug || state.running} onClick={() => void create()}>
          {state.running ? <LoaderCircleIcon className="animate-spin" /> : <PlusIcon />}
          {state.running ? "Creating…" : "Create"}
        </Button>
        <Button size="xs" variant="ghost" disabled={state.running} onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
      {state.error ? <p className="text-xs text-destructive-foreground">{state.error}</p> : null}
    </div>
  );
}

/** KiCad projects in the workspace, with checks, BOM, pinmap and fab outputs. */
export function HardwareDesigns(props: {
  readonly threadRef: ScopedThreadRef;
  readonly projectId: ProjectId;
}) {
  const { environmentId, threadId } = props.threadRef;
  const input = { threadId, projectId: props.projectId };
  const designs = useEnvironmentQuery(hardwareDesigns({ environmentId, input }));
  const firmware = useEnvironmentQuery(hardwareProjects({ environmentId, input }));
  const [creating, setCreating] = useState(false);
  const list = designs.data?.designs ?? [];
  return (
    <section className="mt-4">
      <div className="mb-1 flex items-center justify-between">
        <div className="text-xs font-medium text-muted-foreground">Board design (KiCad)</div>
        {creating ? null : (
          <Button size="xs" variant="ghost" onClick={() => setCreating(true)}>
            <PlusIcon />
            New hardware project
          </Button>
        )}
      </div>
      {creating ? (
        <NewHardwareProject
          threadRef={props.threadRef}
          projectId={props.projectId}
          onCancel={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            designs.refresh();
            firmware.refresh();
          }}
        />
      ) : null}
      {designs.error !== null ? (
        <p className="text-xs text-destructive-foreground">{designs.error}</p>
      ) : list.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {designs.isPending
            ? "Looking for KiCad projects…"
            : "No KiCad project in this workspace yet."}
        </p>
      ) : (
        <ul className="divide-y">
          {list.map((design) => (
            <DesignRow
              key={design.project}
              threadRef={props.threadRef}
              projectId={props.projectId}
              design={design}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
