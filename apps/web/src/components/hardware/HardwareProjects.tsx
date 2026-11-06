import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type {
  HardwareBuildDiagnostic,
  HardwareBuildResult,
  HardwareFlashResult,
  HardwareProject,
  ProjectId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { HammerIcon, LoaderCircleIcon, ZapIcon } from "lucide-react";
import { useState } from "react";

import { useRightPanelStore } from "../../rightPanelStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { hardwareBuild, hardwareFlash, hardwareProjects } from "../../state/hardware";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

type Action = "build" | "flash";

type RunState =
  | { readonly status: "running"; readonly action: Action; readonly log: string }
  | { readonly status: "built"; readonly result: HardwareBuildResult }
  | { readonly status: "flashed"; readonly result: HardwareFlashResult }
  | { readonly status: "failed"; readonly action: Action; readonly message: string };

const kib = (bytes: number) => `${Math.round(bytes / 1024)} KB`;
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
/** Keeps the live log bounded; the full log stays on the server side. */
const MAX_LIVE_LOG_CHARS = 64_000;

/** Tool output as it streams in; the reversed column keeps the newest line in view. */
function LiveLog(props: { readonly log: string; readonly action: Action }) {
  return (
    <div className="flex max-h-48 flex-col-reverse overflow-auto rounded bg-muted p-2">
      <pre className="font-mono text-2xs whitespace-pre-wrap text-muted-foreground">
        {props.log.length > 0
          ? props.log
          : props.action === "build"
            ? "Starting idf.py build…"
            : "Connecting to the board…"}
      </pre>
    </div>
  );
}

/**
 * Projects copied from the same ESP-IDF example share a CMake name, so the
 * directory names them; the CMake name follows in the details when it differs.
 */
function projectTitle(project: HardwareProject) {
  return project.path === "." ? project.name : (project.path.split("/").at(-1) ?? project.path);
}

function projectDetails(project: HardwareProject) {
  const title = projectTitle(project);
  return [
    project.path !== "." && project.path !== title ? project.path : null,
    project.name !== title ? project.name : null,
    project.target ?? null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

/** Workspace path of a diagnostic's file, or null for files outside the project. */
function workspacePath(project: HardwareProject, diagnostic: HardwareBuildDiagnostic) {
  if (!diagnostic.file || diagnostic.file.startsWith("/")) return null;
  return project.path === "." ? diagnostic.file : `${project.path}/${diagnostic.file}`;
}

function Diagnostics(props: {
  readonly threadRef: ScopedThreadRef;
  readonly project: HardwareProject;
  readonly diagnostics: ReadonlyArray<HardwareBuildDiagnostic>;
}) {
  if (props.diagnostics.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1">
      {props.diagnostics.map((diagnostic) => {
        const file = workspacePath(props.project, diagnostic);
        const location = diagnostic.file
          ? `${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}` : ""}`
          : diagnostic.source;
        return (
          <li
            key={`${diagnostic.source}:${diagnostic.file ?? ""}:${diagnostic.line ?? ""}:${diagnostic.column ?? ""}:${diagnostic.message}`}
            className="text-xs"
          >
            <button
              type="button"
              disabled={file === null}
              className="text-left font-mono text-2xs text-muted-foreground enabled:hover:text-foreground enabled:hover:underline"
              onClick={() => {
                if (file === null) return;
                useRightPanelStore.getState().openFile(props.threadRef, file, diagnostic.line);
              }}
            >
              {location}
            </button>
            <div
              className={
                diagnostic.severity === "error"
                  ? "text-destructive-foreground"
                  : "text-warning-foreground"
              }
            >
              {diagnostic.message}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Outcome(props: {
  readonly threadRef: ScopedThreadRef;
  readonly project: HardwareProject;
  readonly state: RunState;
}) {
  const { state } = props;
  if (state.status === "running") return <LiveLog log={state.log} action={state.action} />;
  if (state.status === "failed") {
    return <p className="text-xs text-destructive-foreground">{state.message}</p>;
  }
  const { result } = state;
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  const warnings = result.diagnostics.length - errors.length;
  const flashed = state.status === "flashed" ? state.result : null;
  const built = state.status === "built" ? state.result : null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <Badge variant={result.ok ? "success" : "error"}>
          {flashed ? (result.ok ? "Flashed" : "Flash failed") : result.ok ? "Built" : "Failed"}
        </Badge>
        <span>{(result.durationMs / 1000).toFixed(1)} s</span>
        {flashed ? <span className="font-mono">· {flashed.port}</span> : null}
        {built?.appBinary ? (
          <span>
            · app {kib(built.appBinary.sizeBytes)} of {kib(built.appBinary.partitionBytes)} (
            {built.appBinary.freePercent}% free)
          </span>
        ) : null}
        {errors.length > 0 ? <span>· {errors.length} error(s)</span> : null}
        {warnings > 0 ? <span>· {warnings} warning(s)</span> : null}
      </div>
      {flashed?.backup ? (
        <p className="text-2xs break-all text-muted-foreground">
          {flashed.backup.created ? "Backed up the board first: " : "Board backup: "}
          <span className="font-mono">{flashed.backup.file}</span>
        </p>
      ) : null}
      <Diagnostics
        threadRef={props.threadRef}
        project={props.project}
        diagnostics={result.diagnostics}
      />
      {!result.ok && result.diagnostics.length === 0 ? (
        <pre className="max-h-48 overflow-auto rounded bg-muted p-2 text-2xs whitespace-pre-wrap">
          {result.logTail}
        </pre>
      ) : null}
    </div>
  );
}

/** ESP-IDF projects in the thread's workspace, each with build and flash buttons. */
export function HardwareProjects(props: {
  readonly threadRef: ScopedThreadRef;
  readonly projectId: ProjectId;
}) {
  const { environmentId, threadId } = props.threadRef;
  const { projectId } = props;
  const query = useEnvironmentQuery(
    hardwareProjects({ environmentId, input: { threadId, projectId } }),
  );
  const [runs, setRuns] = useState<Readonly<Record<string, RunState>>>({});

  const run = async (project: HardwareProject, action: Action) => {
    setRuns((current) => ({ ...current, [project.path]: { status: "running", action, log: "" } }));
    const onOutput = (text: string) => {
      const clean = text.replace(ANSI, "").replaceAll("\r\n", "\n");
      setRuns((current) => {
        const previous = current[project.path];
        if (previous?.status !== "running") return current;
        const log = (previous.log + clean).slice(-MAX_LIVE_LOG_CHARS);
        return { ...current, [project.path]: { ...previous, log } };
      });
    };
    const input = { threadId, projectId, path: project.path };
    const next: RunState =
      action === "build"
        ? await runAtomCommand(
            appAtomRegistry,
            hardwareBuild,
            { environmentId, input, onOutput },
            { reportFailure: false },
          ).then((result) =>
            result._tag === "Success"
              ? { status: "built", result: result.value }
              : { status: "failed", action, message: formatEnvironmentQueryError(result.cause) },
          )
        : await runAtomCommand(
            appAtomRegistry,
            hardwareFlash,
            { environmentId, input, onOutput },
            { reportFailure: false },
          ).then((result) =>
            result._tag === "Success"
              ? { status: "flashed", result: result.value }
              : { status: "failed", action, message: formatEnvironmentQueryError(result.cause) },
          );
    setRuns((current) => ({ ...current, [project.path]: next }));
  };

  const projects = query.data?.projects ?? [];
  return (
    <section className="mt-4">
      <div className="mb-1 text-xs font-medium text-muted-foreground">ESP-IDF projects</div>
      {query.error !== null ? (
        <p className="text-xs text-destructive-foreground">{query.error}</p>
      ) : projects.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {query.isPending
            ? "Looking for projects…"
            : "No ESP-IDF project in this workspace yet. Ask the agent to create one."}
        </p>
      ) : (
        <ul className="divide-y">
          {projects.map((project) => {
            const state = runs[project.path];
            const running = state?.status === "running" ? state.action : null;
            return (
              <li key={project.path} className="flex flex-col gap-2 py-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{projectTitle(project)}</div>
                    <div className="truncate font-mono text-2xs text-muted-foreground">
                      {projectDetails(project)}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={running !== null}
                      onClick={() => void run(project, "build")}
                    >
                      {running === "build" ? (
                        <LoaderCircleIcon className="animate-spin" />
                      ) : (
                        <HammerIcon />
                      )}
                      {running === "build" ? "Building…" : "Build"}
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={running !== null}
                      onClick={() => void run(project, "flash")}
                    >
                      {running === "flash" ? (
                        <LoaderCircleIcon className="animate-spin" />
                      ) : (
                        <ZapIcon />
                      )}
                      {running === "flash" ? "Flashing…" : "Flash"}
                    </Button>
                  </div>
                </div>
                {state ? (
                  <Outcome threadRef={props.threadRef} project={project} state={state} />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
