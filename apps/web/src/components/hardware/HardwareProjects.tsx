import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type {
  HardwareBuildDiagnostic,
  ProjectId,
  HardwareBuildResult,
  HardwareProject,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { HammerIcon, LoaderCircleIcon } from "lucide-react";
import { useState } from "react";

import { useRightPanelStore } from "../../rightPanelStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { hardwareBuild, hardwareProjects } from "../../state/hardware";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

type BuildState =
  | { readonly status: "running"; readonly log: string }
  | { readonly status: "done"; readonly result: HardwareBuildResult }
  | { readonly status: "failed"; readonly message: string };

const kib = (bytes: number) => `${Math.round(bytes / 1024)} KB`;
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
/** Keeps the live log bounded; the full log stays on the server side. */
const MAX_LIVE_LOG_CHARS = 64_000;

/** `idf.py` output as it streams in; the reversed column keeps the newest line in view. */
function LiveBuildLog(props: { readonly log: string }) {
  return (
    <div className="flex max-h-48 flex-col-reverse overflow-auto rounded bg-muted p-2">
      <pre className="font-mono text-2xs whitespace-pre-wrap text-muted-foreground">
        {props.log.length > 0 ? props.log : "Starting idf.py build…"}
      </pre>
    </div>
  );
}

/** Workspace path of a diagnostic's file, or null for files outside the project. */
function workspacePath(project: HardwareProject, diagnostic: HardwareBuildDiagnostic) {
  if (!diagnostic.file || diagnostic.file.startsWith("/")) return null;
  return project.path === "." ? diagnostic.file : `${project.path}/${diagnostic.file}`;
}

function BuildOutcome(props: {
  readonly threadRef: ScopedThreadRef;
  readonly project: HardwareProject;
  readonly state: BuildState;
}) {
  const { state } = props;
  if (state.status === "running") return <LiveBuildLog log={state.log} />;
  if (state.status === "failed") {
    return <p className="text-xs text-destructive-foreground">{state.message}</p>;
  }
  const { result } = state;
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  const warnings = result.diagnostics.length - errors.length;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <Badge variant={result.ok ? "success" : "error"}>{result.ok ? "Built" : "Failed"}</Badge>
        <span>{(result.durationMs / 1000).toFixed(1)} s</span>
        {result.appBinary ? (
          <span>
            · app {kib(result.appBinary.sizeBytes)} of {kib(result.appBinary.partitionBytes)} (
            {result.appBinary.freePercent}% free)
          </span>
        ) : null}
        {errors.length > 0 ? <span>· {errors.length} error(s)</span> : null}
        {warnings > 0 ? <span>· {warnings} warning(s)</span> : null}
      </div>
      {result.diagnostics.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {result.diagnostics.map((diagnostic) => {
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
      ) : null}
      {!result.ok && result.diagnostics.length === 0 ? (
        <pre className="max-h-48 overflow-auto rounded bg-muted p-2 text-2xs whitespace-pre-wrap">
          {result.logTail}
        </pre>
      ) : null}
    </div>
  );
}

/** ESP-IDF projects in the thread's workspace, each with a build button. */
export function HardwareProjects(props: {
  readonly threadRef: ScopedThreadRef;
  readonly projectId: ProjectId;
}) {
  const { environmentId, threadId } = props.threadRef;
  const { projectId } = props;
  const query = useEnvironmentQuery(
    hardwareProjects({ environmentId, input: { threadId, projectId } }),
  );
  const [builds, setBuilds] = useState<Readonly<Record<string, BuildState>>>({});

  const build = async (project: HardwareProject) => {
    setBuilds((current) => ({ ...current, [project.path]: { status: "running", log: "" } }));
    const onOutput = (text: string) => {
      const clean = text.replace(ANSI, "").replaceAll("\r\n", "\n");
      setBuilds((current) => {
        const previous = current[project.path];
        if (previous?.status !== "running") return current;
        const log = (previous.log + clean).slice(-MAX_LIVE_LOG_CHARS);
        return { ...current, [project.path]: { status: "running", log } };
      });
    };
    const result = await runAtomCommand(
      appAtomRegistry,
      hardwareBuild,
      { environmentId, input: { threadId, projectId, path: project.path }, onOutput },
      { reportFailure: false },
    );
    setBuilds((current) => ({
      ...current,
      [project.path]:
        result._tag === "Success"
          ? { status: "done", result: result.value }
          : { status: "failed", message: formatEnvironmentQueryError(result.cause) },
    }));
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
            const state = builds[project.path];
            const running = state?.status === "running";
            return (
              <li key={project.path} className="flex flex-col gap-2 py-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{project.name}</div>
                    <div className="truncate font-mono text-2xs text-muted-foreground">
                      {project.path}
                      {project.target ? ` · ${project.target}` : ""}
                    </div>
                  </div>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={running}
                    onClick={() => void build(project)}
                  >
                    {running ? <LoaderCircleIcon className="animate-spin" /> : <HammerIcon />}
                    {running ? "Building…" : "Build"}
                  </Button>
                </div>
                {state ? (
                  <BuildOutcome threadRef={props.threadRef} project={project} state={state} />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
