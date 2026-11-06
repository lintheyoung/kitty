import {
  HardwareToolError,
  KittyBoard,
  KittyPinmap,
  type HardwareTestFirmwareCreateInput,
  type HardwareTestFirmwareCreateResult,
  type HardwareTestRunInput,
  type HardwareTestRunResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { logTail } from "./buildOutput.ts";
import { boardTestProject, boardTestSettings } from "./boardTestFirmware.ts";
import {
  DEFAULT_TEST_FIRMWARE,
  DEFAULT_TEST_PLAN,
  DEFAULT_TEST_TIMEOUT_S,
  KITTY_END_PATTERN,
  judgePlan,
  parseKittyLines,
  parseTestPlan,
  renderTestReport,
  reportJson,
} from "./boardTests.ts";
import * as HardwareService from "./HardwareService.ts";
import { resolveInWorkspace } from "./workspacePath.ts";

const failure = (code: HardwareToolError["code"], message: string) =>
  new HardwareToolError({ code, message });

const ProjectTarget = Schema.Struct({ target: Schema.optional(Schema.String) });

/** A product file decoded leniently: absent or invalid reads as undefined. */
const readOptional = Effect.fn("boardTests.readOptional")(function* <A>(
  schema: Schema.Codec<A, unknown>,
  file: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(file).pipe(Effect.option);
  if (Option.isNone(text)) return undefined;
  return Option.getOrUndefined(Schema.decodeOption(Schema.fromJsonString(schema))(text.value));
});

/** The product root of a plan: the parent of `tests/`, else the plan's own directory. */
function productRootOf(path: Path.Path, planFile: string) {
  const directory = path.dirname(planFile);
  return path.basename(directory) === "tests" ? path.dirname(directory) : directory;
}

/**
 * Writes the standard Board Test Firmware to `<root>/tests/board-test` and a
 * starting `tests/test-plan.yaml`, configured from the product's board.json
 * and pinmap.json.
 */
export const createBoardTest = Effect.fn("createBoardTest")(function* (
  input: HardwareTestFirmwareCreateInput & { readonly workspaceRoot: string },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* resolveInWorkspace(input.workspaceRoot, input.root ?? ".");
  const firmwareDir = path.join(root, DEFAULT_TEST_FIRMWARE);
  const planFile = path.join(root, DEFAULT_TEST_PLAN);
  if (yield* fs.exists(firmwareDir).pipe(Effect.orElseSucceed(() => false))) {
    return yield* failure(
      "already_exists",
      `${path.relative(input.workspaceRoot, firmwareDir)} already exists. Edit it, or delete it to start over.`,
    );
  }
  const board = yield* readOptional(KittyBoard, path.join(root, "hardware", "board.json"));
  const pinmap = yield* readOptional(KittyPinmap, path.join(root, "hardware", "pinmap.json"));
  const project = yield* readOptional(ProjectTarget, path.join(root, "project.json"));
  const generated = boardTestProject({
    product: board?.name ?? path.basename(root),
    target: project?.target ?? "esp32s3",
    firmwareDir: DEFAULT_TEST_FIRMWARE,
    settings: boardTestSettings(board, pinmap),
  });

  const written: Array<string> = [];
  const write = (file: string, text: string) =>
    fs.makeDirectory(path.dirname(file), { recursive: true }).pipe(
      Effect.andThen(fs.writeFileString(file, text)),
      Effect.tap(() => Effect.sync(() => written.push(path.relative(input.workspaceRoot, file)))),
      Effect.mapError((cause) => failure("command_failed", cause.message)),
    );
  for (const [file, text] of Object.entries(generated.firmware)) {
    yield* write(path.join(firmwareDir, file), text);
  }
  const planExists = yield* fs.exists(planFile).pipe(Effect.orElseSucceed(() => false));
  if (!planExists) yield* write(planFile, generated.plan);

  const plan = path.relative(input.workspaceRoot, planFile);
  return {
    firmware: path.relative(input.workspaceRoot, firmwareDir),
    plan,
    files: written,
    configured: [...generated.configured],
    next_steps: [
      ...(planExists
        ? [
            `${plan} already existed and was left as is; point its firmware at ${DEFAULT_TEST_FIRMWARE}.`,
          ]
        : []),
      ...(generated.configured.length === 0
        ? [
            "No I2C bus found: fill hardware/board.json interfaces.i2c, or run hw_pinmap_sync on a schematic with SDA/SCL nets, then recreate; or set the pins in sdkconfig.defaults.",
          ]
        : []),
      "Review the cases in the test plan, then run hw_test_run (it builds, flashes, reads the results and writes a report to tests/reports/).",
    ],
  } satisfies HardwareTestFirmwareCreateResult;
});

/**
 * Runs a test plan (PRD FR-TST-04): build and flash its firmware, reset and
 * read the board's Kitty lines until `end` or the timeout, judge each case,
 * and keep a Markdown and a JSON report in `<product>/tests/reports/`.
 */
export const runBoardTests = Effect.fn("runBoardTests")(function* (
  input: HardwareTestRunInput & { readonly workspaceRoot: string },
  options: {
    readonly onOutput?: ((text: string) => void) | undefined;
    readonly approvalFor?: { readonly threadId?: ThreadId | undefined } | undefined;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hardware = yield* HardwareService.HardwareService;
  const say = (text: string) => options.onOutput?.(text);
  const started = yield* Clock.currentTimeMillis;
  const startedAt = DateTime.formatIso(yield* DateTime.now);

  const planRelative = input.plan ?? DEFAULT_TEST_PLAN;
  const planFile = yield* resolveInWorkspace(input.workspaceRoot, planRelative);
  const text = yield* fs
    .readFileString(planFile)
    .pipe(
      Effect.mapError(() =>
        failure(
          "invalid_path",
          `No test plan at ${planRelative}. Create one with hw_test_firmware_create.`,
        ),
      ),
    );
  const parsed = parseTestPlan(text);
  if ("errors" in parsed) {
    return yield* failure(
      "invalid_argument",
      `${planRelative} is not a valid test plan:\n${parsed.errors.join("\n")}`,
    );
  }
  const { plan } = parsed;
  const productRoot = productRootOf(path, planFile);
  const firmwareDir = yield* resolveInWorkspace(
    input.workspaceRoot,
    path.relative(
      input.workspaceRoot,
      path.resolve(productRoot, plan.firmware ?? DEFAULT_TEST_FIRMWARE),
    ),
  );
  const firmwareRelative = path.relative(input.workspaceRoot, firmwareDir) || ".";
  const relative = path.relative(input.workspaceRoot, planFile);

  const base = {
    plan: relative,
    name: plan.name,
    passed: 0,
    failed: 0,
    missing: plan.cases.length,
    unparsedLines: 0,
  };
  const finish = Effect.fn("runBoardTests.finish")(function* (
    result: Omit<HardwareTestRunResult, "report" | "durationMs">,
  ) {
    const complete = { ...result, durationMs: (yield* Clock.currentTimeMillis) - started };
    const reports = path.join(productRoot, "tests", "reports");
    const stem = startedAt.replace(/[:.]/g, "-");
    const markdown = path.join(reports, `${stem}.md`);
    const json = path.join(reports, `${stem}.json`);
    const saved = yield* fs.makeDirectory(reports, { recursive: true }).pipe(
      Effect.andThen(
        fs.writeFileString(
          markdown,
          renderTestReport(complete, { startedAt, product: path.basename(productRoot) }),
        ),
      ),
      Effect.andThen(fs.writeFileString(json, reportJson({ startedAt, ...complete }))),
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    say(
      `\n${complete.ok ? "PASS" : "FAIL"}: ${complete.passed} passed, ${complete.failed} failed, ${complete.missing} missing\n`,
    );
    return {
      ...complete,
      ...(saved
        ? {
            report: {
              markdown: path.relative(input.workspaceRoot, markdown),
              json: path.relative(input.workspaceRoot, json),
            },
          }
        : {}),
    } satisfies HardwareTestRunResult;
  });
  const notRun = (stage: HardwareTestRunResult["stage"], log: string) =>
    plan.cases.map((testCase) => ({
      id: testCase.id,
      name: testCase.name ?? testCase.id,
      metric: testCase.metric,
      status: "missing" as const,
      expected: "",
      reason: stage === "build_failed" ? "Not run: the firmware did not build." : log,
    }));

  let port = input.port;
  if (input.flash !== false) {
    say(`Building and flashing ${firmwareRelative}…\n`);
    const flashed = yield* hardware.flash(
      { path: firmwareRelative, directory: firmwareDir, ...(port ? { port } : {}) },
      { onOutput: options.onOutput, approvalFor: options.approvalFor },
    );
    port = flashed.port;
    if (!flashed.ok) {
      const stage = flashed.diagnostics.some((diagnostic) => diagnostic.severity === "error")
        ? "build_failed"
        : "flash_failed";
      return yield* finish({
        ...base,
        stage,
        ok: false,
        port: flashed.port,
        cases: notRun(stage, "Not run: flashing failed."),
        logTail: flashed.logTail,
      });
    }
  }

  const timeout = Math.min(60, Math.max(1, plan.timeout_s ?? DEFAULT_TEST_TIMEOUT_S));
  say(`\nResetting the board and reading results (up to ${timeout} s)…\n`);
  const read = yield* hardware.monitorRead({
    ...(port ? { port } : {}),
    seconds: timeout,
    reset: true,
    until: KITTY_END_PATTERN,
    ...(plan.baud ? { baud: plan.baud } : {}),
  });
  say(read.text);
  const output = parseKittyLines(read.text);
  const judged = judgePlan(plan, output);
  const silent = output.firmware === undefined && output.metrics.size === 0;
  return yield* finish({
    ...base,
    ...judged,
    stage: silent ? "no_output" : "done",
    ok: !silent && judged.failed === 0 && judged.missing === 0,
    port: read.port,
    ...(output.firmware ? { firmware: output.firmware } : {}),
    unparsedLines: output.unparsed,
    ...(silent || !output.ended ? { logTail: logTail(read.text, 30) } : {}),
  });
});

const PLAN_SEARCH_DEPTH = 3;
const SKIPPED_DIRECTORIES = new Set(["node_modules", "build", "managed_components", ".git"]);

/** `tests/test-plan.yaml` files in the workspace and up to three levels below it. */
export const listTestPlans = Effect.fn("listTestPlans")(function* (workspaceRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const found: Array<string> = [];
  const visit: (directory: string, depth: number) => Effect.Effect<void> = Effect.fn(
    "listTestPlans.visit",
  )(function* (directory: string, depth: number) {
    const plan = path.join(directory, DEFAULT_TEST_PLAN);
    if (yield* fs.exists(plan).pipe(Effect.orElseSucceed(() => false))) found.push(plan);
    if (depth >= PLAN_SEARCH_DEPTH) return;
    const entries = yield* fs
      .readDirectory(directory)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const entry of entries.toSorted()) {
      if (entry.startsWith(".") || SKIPPED_DIRECTORIES.has(entry)) continue;
      const child = path.join(directory, entry);
      const info = yield* fs.stat(child).pipe(Effect.option);
      if (Option.isSome(info) && info.value.type === "Directory") yield* visit(child, depth + 1);
    }
  });
  yield* visit(workspaceRoot, 0);

  const plans = yield* Effect.forEach(found, (file) =>
    Effect.gen(function* () {
      const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
      const parsed = parseTestPlan(text);
      const reports = path.join(path.dirname(file), "reports");
      const newest = (yield* fs
        .readDirectory(reports)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => [])))
        .filter((entry) => entry.endsWith(".md"))
        .toSorted()
        .at(-1);
      return {
        path: path.relative(workspaceRoot, file),
        ...("plan" in parsed
          ? {
              name: parsed.plan.name,
              cases: parsed.plan.cases.length,
              firmware: parsed.plan.firmware ?? DEFAULT_TEST_FIRMWARE,
              errors: [],
            }
          : { cases: 0, errors: [...parsed.errors] }),
        ...(newest ? { lastReport: path.relative(workspaceRoot, path.join(reports, newest)) } : {}),
      };
    }),
  );
  return { plans };
});
