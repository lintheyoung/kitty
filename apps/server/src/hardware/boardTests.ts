import {
  KittyTestPlan,
  type HardwareTestRunResult,
  type KittyTestCase,
  type KittyTestCaseResult,
  type KittyTestExpect,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import { parse as parseYaml } from "yaml";

/** Default plan location in a product repository. */
export const DEFAULT_TEST_PLAN = "tests/test-plan.yaml";
/** Where the generated Board Test Firmware lives, beside the product firmware. */
export const DEFAULT_TEST_FIRMWARE = "tests/board-test";
export const DEFAULT_TEST_TIMEOUT_S = 20;
/** The firmware's last line; the serial read stops when it arrives. */
export const KITTY_END_PATTERN = String.raw`"kitty"\s*:\s*"end"`;

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();
const decodePlan = Schema.decodeUnknownExit(KittyTestPlan);

/** Decodes a test plan, or lists what is wrong with it field by field. */
export function parseTestPlan(
  text: string,
): { readonly plan: KittyTestPlan } | { readonly errors: ReadonlyArray<string> } {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (cause) {
    return {
      errors: [`Not valid YAML: ${cause instanceof Error ? cause.message : String(cause)}`],
    };
  }
  const decoded = decodePlan(raw, { errors: "all" });
  if (decoded._tag === "Success") {
    const ids = decoded.value.cases.map((testCase) => testCase.id);
    const repeated = ids.filter((id, index) => ids.indexOf(id) !== index);
    if (repeated.length > 0) {
      return {
        errors: [`cases: ids must be unique; repeated: ${[...new Set(repeated)].join(", ")}`],
      };
    }
    return { plan: decoded.value };
  }
  const errors = decoded.cause.reasons.flatMap((reason) =>
    reason._tag === "Fail" && Schema.isSchemaError(reason.error)
      ? formatIssues(reason.error.issue).issues.map((issue) => {
          const where = (issue.path ?? [])
            .map((key) => (typeof key === "number" ? `[${key}]` : `.${String(key)}`))
            .join("")
            .replace(/^\./, "");
          return `${where || "(plan)"}: ${issue.message}`;
        })
      : ["Invalid test plan"],
  );
  return { errors };
}

const KittyLine = Schema.Union([
  Schema.Struct({
    kitty: Schema.Literal("start"),
    firmware: Schema.String,
    version: Schema.String,
  }),
  Schema.Struct({
    kitty: Schema.Literal("metric"),
    name: Schema.String,
    value: Schema.Unknown,
    unit: Schema.optional(Schema.String),
  }),
  Schema.Struct({ kitty: Schema.Literal("end") }),
]);
const decodeKittyLine = Schema.decodeExit(Schema.fromJsonString(KittyLine));

export interface KittyMetric {
  readonly value: unknown;
  readonly unit?: string | undefined;
}

export interface KittyOutput {
  readonly firmware?: { readonly name: string; readonly version: string } | undefined;
  /** The last value reported for each metric. */
  readonly metrics: ReadonlyMap<string, KittyMetric>;
  readonly ended: boolean;
  /** Lines that started a Kitty object but did not decode as one. */
  readonly unparsed: number;
}

/**
 * Reads the Kitty JSON Lines out of a serial log. Other lines (boot ROM,
 * ESP_LOG output) are skipped; a Kitty object may follow a log prefix.
 * Only the run after the last `start` counts, so a reset mid-read starts over.
 */
export function parseKittyLines(text: string): KittyOutput {
  let firmware: KittyOutput["firmware"];
  let metrics = new Map<string, KittyMetric>();
  let ended = false;
  let unparsed = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const start = rawLine.search(/\{\s*"kitty"\s*:/);
    if (start < 0) continue;
    const decoded = decodeKittyLine(rawLine.slice(start).trim());
    if (decoded._tag === "Failure") {
      unparsed++;
      continue;
    }
    const line = decoded.value;
    if (line.kitty === "start") {
      firmware = { name: line.firmware, version: line.version };
      metrics = new Map();
      ended = false;
    } else if (line.kitty === "metric") {
      metrics.set(line.name, { value: line.value, unit: line.unit });
    } else {
      ended = true;
    }
  }
  return { firmware, metrics, ended, unparsed };
}

const show = (value: unknown) => JSON.stringify(value) ?? String(value);

/** The rule in words, for the report. */
export function describeExpect(expect: KittyTestExpect | undefined): string {
  if (!expect) return "reported";
  const parts: Array<string> = [];
  if (expect.min !== undefined && expect.max !== undefined) {
    parts.push(`between ${expect.min} and ${expect.max}`);
  } else if (expect.min !== undefined) {
    parts.push(`at least ${expect.min}`);
  } else if (expect.max !== undefined) {
    parts.push(`at most ${expect.max}`);
  }
  if (expect.equals !== undefined) parts.push(`equals ${show(expect.equals)}`);
  if (expect.contains !== undefined) parts.push(`contains ${show(expect.contains)}`);
  if (expect.matches !== undefined) parts.push(`matches /${expect.matches}/`);
  return parts.length > 0 ? parts.join(", ") : "reported";
}

const sameScalar = (a: unknown, b: unknown) =>
  typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : a === b;

/** Why `value` breaks `expect`, or null when it meets every rule. */
function violation(value: unknown, expect: KittyTestExpect): string | null {
  if (expect.min !== undefined || expect.max !== undefined) {
    if (typeof value !== "number" || Number.isNaN(value)) return "not a number";
    if (expect.min !== undefined && value < expect.min) return `below ${expect.min}`;
    if (expect.max !== undefined && value > expect.max) return `above ${expect.max}`;
  }
  if (expect.equals !== undefined && !sameScalar(value, expect.equals)) {
    return `expected ${show(expect.equals)}`;
  }
  if (expect.contains !== undefined) {
    const wanted = expect.contains;
    const found = Array.isArray(value)
      ? value.some((item) => sameScalar(item, wanted))
      : typeof value === "string" && value.toLowerCase().includes(String(wanted).toLowerCase());
    if (!found) return `${show(wanted)} not found`;
  }
  if (expect.matches !== undefined) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(expect.matches);
    } catch {
      return `invalid pattern /${expect.matches}/`;
    }
    if (!pattern.test(typeof value === "string" ? value : show(value))) {
      return `does not match /${expect.matches}/`;
    }
  }
  return null;
}

function judgeCase(testCase: KittyTestCase, output: KittyOutput): KittyTestCaseResult {
  const base = {
    id: testCase.id,
    name: testCase.name ?? testCase.id,
    metric: testCase.metric,
    expected: describeExpect(testCase.expect),
  };
  const metric = output.metrics.get(testCase.metric);
  if (!metric) {
    return {
      ...base,
      status: "missing",
      reason: output.ended
        ? "The firmware finished without reporting it."
        : "Not reported before the timeout.",
    };
  }
  const reason = testCase.expect ? violation(metric.value, testCase.expect) : null;
  return {
    ...base,
    status: reason === null ? "pass" : "fail",
    actual: show(metric.value),
    ...(metric.unit ? { unit: metric.unit } : {}),
    ...(reason === null ? {} : { reason }),
  };
}

export function judgePlan(plan: KittyTestPlan, output: KittyOutput) {
  const cases = plan.cases.map((testCase) => judgeCase(testCase, output));
  const count = (status: KittyTestCaseResult["status"]) =>
    cases.filter((result) => result.status === status).length;
  return { cases, passed: count("pass"), failed: count("fail"), missing: count("missing") };
}

const escapeCell = (text: string) => text.replaceAll("|", String.raw`\|`).replaceAll("\n", " ");

const STAGE_TEXT: Record<HardwareTestRunResult["stage"], string> = {
  done: "Ran",
  build_failed: "The test firmware did not build",
  flash_failed: "Flashing failed",
  no_output: "The board printed no Kitty lines",
};

/** The Markdown report kept in tests/reports/ (PRD FR-TST-05). */
export function renderTestReport(
  result: Omit<HardwareTestRunResult, "report">,
  context: { readonly startedAt: string; readonly product?: string | undefined },
): string {
  const verdict = result.ok
    ? "PASS"
    : result.stage === "done"
      ? "FAIL"
      : `NOT RUN (${STAGE_TEXT[result.stage]})`;
  const lines = [
    `# ${result.name}: ${verdict}`,
    "",
    "| | |",
    "| --- | --- |",
    ...(context.product ? [`| Product | ${escapeCell(context.product)} |`] : []),
    `| Plan | \`${result.plan}\` |`,
    `| Started | ${context.startedAt} |`,
    `| Duration | ${(result.durationMs / 1000).toFixed(1)} s |`,
    `| Port | ${result.port ?? "-"} |`,
    `| Firmware | ${result.firmware ? `${escapeCell(result.firmware.name)} ${escapeCell(result.firmware.version)}` : "-"} |`,
    `| Result | ${result.passed} passed, ${result.failed} failed, ${result.missing} missing |`,
    "",
    "| Case | Metric | Expected | Actual | Result |",
    "| --- | --- | --- | --- | --- |",
    ...result.cases.map((testCase) => {
      const actual = testCase.actual
        ? `${testCase.actual}${testCase.unit ? ` ${testCase.unit}` : ""}`
        : "-";
      const status =
        testCase.status === "pass"
          ? "pass"
          : `**${testCase.status}**${testCase.reason ? `: ${testCase.reason}` : ""}`;
      return `| ${escapeCell(testCase.name)} | \`${testCase.metric}\` | ${escapeCell(testCase.expected)} | ${escapeCell(actual)} | ${escapeCell(status)} |`;
    }),
  ];
  if (result.unparsedLines > 0) {
    lines.push("", `${result.unparsedLines} Kitty line(s) could not be read.`);
  }
  if (result.logTail) {
    lines.push("", "## Log", "", "```text", result.logTail, "```");
  }
  return `${lines.join("\n")}\n`;
}

export const reportJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
