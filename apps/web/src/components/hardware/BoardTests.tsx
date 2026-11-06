import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type {
  HardwareTestPlansResult,
  HardwareTestRunResult,
  ProjectId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  FlaskConicalIcon,
  LoaderCircleIcon,
  PlayIcon,
  PlusIcon,
  RotateCcwIcon,
} from "lucide-react";
import { useState } from "react";

import { useRightPanelStore } from "../../rightPanelStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { hardwareTestCreate, hardwareTestPlans, hardwareTestRun } from "../../state/hardware";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

type TestPlan = HardwareTestPlansResult["plans"][number];

type RunState =
  | { readonly status: "running"; readonly flash: boolean; readonly log: string }
  | { readonly status: "done"; readonly result: HardwareTestRunResult }
  | { readonly status: "failed"; readonly message: string };

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const MAX_LIVE_LOG_CHARS = 64_000;

const STAGE_TEXT: Record<HardwareTestRunResult["stage"], string> = {
  done: "",
  build_failed: "The test firmware did not build.",
  flash_failed: "Flashing failed.",
  no_output: "The board printed no Kitty lines. Is the test firmware on it, at the plan's baud?",
};

function RunResult(props: {
  readonly threadRef: ScopedThreadRef;
  readonly result: HardwareTestRunResult;
}) {
  const { result } = props;
  const openFile = (file: string) => useRightPanelStore.getState().openFile(props.threadRef, file);
  return (
    <div className="flex flex-col gap-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-1.5 text-muted-foreground">
        <Badge variant={result.ok ? "success" : "error"}>{result.ok ? "Pass" : "Fail"}</Badge>
        <span>
          {result.passed} passed · {result.failed} failed · {result.missing} missing
        </span>
        <span>· {(result.durationMs / 1000).toFixed(1)} s</span>
        {result.port ? <span className="font-mono">· {result.port}</span> : null}
        {result.firmware ? (
          <span className="font-mono">
            · {result.firmware.name} {result.firmware.version}
          </span>
        ) : null}
      </div>
      {STAGE_TEXT[result.stage] ? (
        <p className="text-destructive-foreground">{STAGE_TEXT[result.stage]}</p>
      ) : null}
      {result.stage === "done" ? (
        <ul className="flex flex-col gap-1">
          {result.cases.map((testCase) => (
            <li key={testCase.id} className="flex items-start gap-1.5">
              <Badge
                size="sm"
                variant={
                  testCase.status === "pass"
                    ? "success"
                    : testCase.status === "fail"
                      ? "error"
                      : "warning"
                }
              >
                {testCase.status}
              </Badge>
              <div className="min-w-0">
                <div>{testCase.name}</div>
                <div className="font-mono text-2xs break-all text-muted-foreground">
                  {testCase.metric} = {testCase.actual ?? "-"}
                  {testCase.unit ? ` ${testCase.unit}` : ""} · expected {testCase.expected}
                  {testCase.reason && testCase.status !== "pass" ? ` · ${testCase.reason}` : ""}
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {result.unparsedLines > 0 ? (
        <p className="text-warning-foreground">
          {result.unparsedLines} line(s) from the firmware could not be read.
        </p>
      ) : null}
      {result.logTail ? (
        <pre className="max-h-48 overflow-auto rounded bg-muted p-2 text-2xs whitespace-pre-wrap">
          {result.logTail}
        </pre>
      ) : null}
      {result.report ? (
        <button
          type="button"
          className="self-start font-mono text-2xs text-muted-foreground hover:text-foreground hover:underline"
          onClick={() => {
            if (result.report) openFile(result.report.markdown);
          }}
        >
          Report: {result.report.markdown}
        </button>
      ) : null}
    </div>
  );
}

function PlanRow(props: {
  readonly threadRef: ScopedThreadRef;
  readonly projectId: ProjectId;
  readonly plan: TestPlan;
  readonly onFinished: () => void;
}) {
  const { plan, threadRef } = props;
  const [state, setState] = useState<RunState | null>(null);
  const running = state?.status === "running";

  const run = async (flash: boolean) => {
    setState({ status: "running", flash, log: "" });
    const onOutput = (text: string) => {
      const clean = text.replace(ANSI, "").replaceAll("\r\n", "\n");
      setState((current) =>
        current?.status === "running"
          ? { ...current, log: (current.log + clean).slice(-MAX_LIVE_LOG_CHARS) }
          : current,
      );
    };
    const result = await runAtomCommand(
      appAtomRegistry,
      hardwareTestRun,
      {
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          projectId: props.projectId,
          plan: plan.path,
          flash,
        },
        onOutput,
      },
      { reportFailure: false },
    );
    setState(
      result._tag === "Success"
        ? { status: "done", result: result.value }
        : { status: "failed", message: formatEnvironmentQueryError(result.cause) },
    );
    props.onFinished();
  };

  const blocked = plan.errors.length > 0;
  return (
    <li className="flex flex-col gap-2 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{plan.name ?? plan.path}</div>
          <div className="truncate font-mono text-2xs text-muted-foreground">
            {plan.path} · {plan.cases} case(s)
            {plan.firmware ? ` · ${plan.firmware}` : ""}
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button
            size="xs"
            variant="outline"
            disabled={blocked || running}
            onClick={() => void run(true)}
          >
            {running && state.flash ? <LoaderCircleIcon className="animate-spin" /> : <PlayIcon />}
            {running && state.flash ? "Testing…" : "Run tests"}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={blocked || running}
            aria-label="Read the board again without flashing"
            onClick={() => void run(false)}
          >
            {running && !state.flash ? (
              <LoaderCircleIcon className="animate-spin" />
            ) : (
              <RotateCcwIcon />
            )}
            Re-read
          </Button>
        </div>
      </div>
      {blocked ? (
        <ul className="font-mono text-2xs text-destructive-foreground">
          {plan.errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : null}
      {state?.status === "running" ? (
        <div className="flex max-h-48 flex-col-reverse overflow-auto rounded bg-muted p-2">
          <pre className="font-mono text-2xs whitespace-pre-wrap text-muted-foreground">
            {state.log || (state.flash ? "Building the test firmware…" : "Resetting the board…")}
          </pre>
        </div>
      ) : state?.status === "failed" ? (
        <p className="text-xs text-destructive-foreground">{state.message}</p>
      ) : state?.status === "done" ? (
        <RunResult threadRef={threadRef} result={state.result} />
      ) : plan.lastReport ? (
        <button
          type="button"
          className="self-start font-mono text-2xs text-muted-foreground hover:text-foreground hover:underline"
          onClick={() => {
            if (plan.lastReport) useRightPanelStore.getState().openFile(threadRef, plan.lastReport);
          }}
        >
          Last report: {plan.lastReport}
        </button>
      ) : null}
    </li>
  );
}

/** Board bring-up tests: the plan's firmware prints metrics, Kitty judges them and keeps a report. */
export function BoardTests(props: {
  readonly threadRef: ScopedThreadRef;
  readonly projectId: ProjectId;
}) {
  const { environmentId, threadId } = props.threadRef;
  const input = { threadId, projectId: props.projectId };
  const query = useEnvironmentQuery(hardwareTestPlans({ environmentId, input }));
  const [creating, setCreating] = useState<{ running: boolean; message: string | null }>({
    running: false,
    message: null,
  });
  const plans = query.data?.plans ?? [];

  const create = async () => {
    setCreating({ running: true, message: null });
    const result = await runAtomCommand(
      appAtomRegistry,
      hardwareTestCreate,
      { environmentId, input },
      { reportFailure: false },
    );
    setCreating({
      running: false,
      message:
        result._tag === "Success"
          ? [
              `Created ${result.value.firmware} and ${result.value.plan}.`,
              ...result.value.configured,
              ...result.value.next_steps,
            ].join("\n")
          : formatEnvironmentQueryError(result.cause),
    });
    query.refresh();
  };

  return (
    <section className="mt-4">
      <div className="mb-1 flex items-center justify-between">
        <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
          <FlaskConicalIcon className="size-3" />
          Board tests
        </div>
        {plans.length === 0 && !query.isPending ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={creating.running}
            onClick={() => void create()}
          >
            {creating.running ? <LoaderCircleIcon className="animate-spin" /> : <PlusIcon />}
            Create board test
          </Button>
        ) : null}
      </div>
      {creating.message ? (
        <p className="mb-2 text-xs whitespace-pre-line text-muted-foreground">{creating.message}</p>
      ) : null}
      {query.error !== null ? (
        <p className="text-xs text-destructive-foreground">{query.error}</p>
      ) : plans.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {query.isPending
            ? "Looking for test plans…"
            : "No tests/test-plan.yaml yet. Create the standard board test: it checks the chip, flash, I2C bus and IMU, and is set up from hardware/board.json."}
        </p>
      ) : (
        <ul className="divide-y">
          {plans.map((plan) => (
            <PlanRow
              key={plan.path}
              threadRef={props.threadRef}
              projectId={props.projectId}
              plan={plan}
              onFinished={() => query.refresh()}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
