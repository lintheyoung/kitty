import type { HardwareDoctorCheck, ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";

import { hardwareDoctor } from "../../state/hardware";
import { useEnvironmentQuery } from "../../state/query";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { HardwareApprovalRequests, HardwareBoards } from "./HardwareBoards";
import { HardwareProjects } from "./HardwareProjects";
import { ToolchainInstall } from "./ToolchainInstall";

const CHECK_LABELS: Record<HardwareDoctorCheck["id"], string> = {
  "esp-idf": "ESP-IDF",
  "python-env": "Python environment",
  esptool: "esptool",
  kicad: "KiCad",
  serial: "Board",
};

const STATUS_BADGES = {
  ok: { variant: "success", label: "OK" },
  warning: { variant: "warning", label: "Check" },
  missing: { variant: "error", label: "Missing" },
} as const;

/** Kitty's hardware surface. The report comes from the environment that owns the board. */
export function HardwarePanel(props: {
  readonly threadRef: ScopedThreadRef;
  /** Null outside a project; the projects section then stays hidden. */
  readonly projectId: ProjectId | null;
}) {
  const query = useEnvironmentQuery(
    hardwareDoctor({ environmentId: props.threadRef.environmentId, input: {} }),
  );
  const report = query.data;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <div className="min-w-0">
          <div className="text-sm font-medium">Hardware</div>
          <div className="truncate text-xs text-muted-foreground">
            {report === null
              ? query.isPending
                ? "Checking toolchain…"
                : "Not checked yet"
              : report.ok
                ? "Toolchain ready"
                : "Toolchain needs attention"}
          </div>
        </div>
        <Button
          size="xs"
          variant="outline"
          disabled={query.isPending}
          onClick={() => query.refresh()}
        >
          <RefreshCwIcon className={query.isPending ? "animate-spin" : undefined} />
          Re-check
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        <HardwareApprovalRequests environmentId={props.threadRef.environmentId} />
        {query.error !== null ? (
          <p className="text-sm text-destructive-foreground">{query.error}</p>
        ) : null}
        {report === null ? null : (
          <>
            <ul className="divide-y">
              {report.checks.map((check) => {
                const badge = STATUS_BADGES[check.status];
                return (
                  <li key={check.id} className="flex flex-col gap-1 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium">
                        {CHECK_LABELS[check.id]}
                        {check.version ? (
                          <span className="ml-1.5 font-normal text-muted-foreground">
                            {check.version}
                          </span>
                        ) : null}
                      </span>
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">{check.detail}</p>
                    {check.path ? (
                      <p className="truncate font-mono text-2xs text-muted-foreground/80">
                        {check.path}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </>
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
        <HardwareBoards environmentId={props.threadRef.environmentId} />
        {props.projectId === null ? null : (
          <HardwareProjects threadRef={props.threadRef} projectId={props.projectId} />
        )}
      </div>
    </div>
  );
}
