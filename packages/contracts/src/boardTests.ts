import * as Schema from "effect/Schema";

/**
 * Board tests: `tests/test-plan.yaml` names the metrics the test firmware must
 * print and the rule each must meet. The firmware prints JSON Lines:
 * `{"kitty":"start",...}`, `{"kitty":"metric","name":...,"value":...}`, `{"kitty":"end"}`.
 */

const Scalar = Schema.Union([Schema.String, Schema.Number, Schema.Boolean]);

export const KittyTestExpect = Schema.Struct({
  min: Schema.optional(Schema.Number),
  max: Schema.optional(Schema.Number),
  /** Strings compare without case, so `0x6B` equals `0x6b`. */
  equals: Schema.optional(Scalar),
  /** The value (a list or a string) holds this item. */
  contains: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  /** A regular expression the value, as text, must match. */
  matches: Schema.optional(Schema.String),
});
export type KittyTestExpect = typeof KittyTestExpect.Type;

export const KittyTestCase = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  name: Schema.optional(Schema.String),
  /** The metric name the firmware reports, e.g. `imu.whoami`. */
  metric: Schema.String.check(Schema.isMinLength(1)),
  /** Without rules the case passes when the metric is reported at all. */
  expect: Schema.optional(KittyTestExpect),
});
export type KittyTestCase = typeof KittyTestCase.Type;

export const KittyTestPlan = Schema.Struct({
  schema_version: Schema.String,
  name: Schema.String,
  /** ESP-IDF project that prints the metrics, relative to the product root. */
  firmware: Schema.optional(Schema.String),
  /** How long to wait for the firmware's `end` line, 1-60 s. Default 20. */
  timeout_s: Schema.optional(Schema.Number),
  baud: Schema.optional(Schema.Int),
  cases: Schema.Array(KittyTestCase).check(Schema.isMinLength(1)),
});
export type KittyTestPlan = typeof KittyTestPlan.Type;

export const KittyTestStatus = Schema.Literals(["pass", "fail", "missing"]);
export type KittyTestStatus = typeof KittyTestStatus.Type;

export const KittyTestCaseResult = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  metric: Schema.String,
  status: KittyTestStatus,
  /** The rule in words, e.g. `between 3200 and 3400`. */
  expected: Schema.String,
  /** The reported value as JSON text, when there was one. */
  actual: Schema.optional(Schema.String),
  unit: Schema.optional(Schema.String),
  /** Why it failed. */
  reason: Schema.optional(Schema.String),
});
export type KittyTestCaseResult = typeof KittyTestCaseResult.Type;

export const HardwareTestStage = Schema.Literals([
  "done",
  "build_failed",
  "flash_failed",
  "no_output",
]);
export type HardwareTestStage = typeof HardwareTestStage.Type;

export const HardwareTestRunInput = Schema.Struct({
  plan: Schema.optional(
    Schema.String.annotate({
      description: "Test plan, relative to the workspace. Default tests/test-plan.yaml.",
    }),
  ),
  port: Schema.optional(
    Schema.String.annotate({
      description: "Serial port from hw_ports. Defaults to the only connected board.",
    }),
  ),
  flash: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Build and flash the plan's test firmware first (default true). false = reset the board and read what is already on it.",
    }),
  ),
});
export type HardwareTestRunInput = typeof HardwareTestRunInput.Type;

export const HardwareTestRunResult = Schema.Struct({
  plan: Schema.String,
  name: Schema.String,
  stage: HardwareTestStage,
  ok: Schema.Boolean,
  passed: Schema.Int,
  failed: Schema.Int,
  missing: Schema.Int,
  cases: Schema.Array(KittyTestCaseResult),
  port: Schema.optional(Schema.String),
  /** What the firmware said it is in its `start` line. */
  firmware: Schema.optional(Schema.Struct({ name: Schema.String, version: Schema.String })),
  /** Lines that started like a Kitty line but were not valid JSON for one. */
  unparsedLines: Schema.Int,
  durationMs: Schema.Int,
  /** Markdown and JSON reports, relative to the workspace. */
  report: Schema.optional(Schema.Struct({ markdown: Schema.String, json: Schema.String })),
  /** The end of the build, flash or serial log when something went wrong. */
  logTail: Schema.optional(Schema.String),
});
export type HardwareTestRunResult = typeof HardwareTestRunResult.Type;

/** A streamed test run: build, flash and serial output, then the judged result. */
export const HardwareTestRunEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("output"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("complete"), result: HardwareTestRunResult }),
]);
export type HardwareTestRunEvent = typeof HardwareTestRunEvent.Type;

export const HardwareTestFirmwareCreateInput = Schema.Struct({
  root: Schema.optional(
    Schema.String.annotate({
      description:
        "Product root (with hardware/ and firmware/), relative to the workspace. Default: the workspace.",
    }),
  ),
});
export type HardwareTestFirmwareCreateInput = typeof HardwareTestFirmwareCreateInput.Type;

export const HardwareTestFirmwareCreateResult = Schema.Struct({
  firmware: Schema.String,
  plan: Schema.String,
  files: Schema.Array(Schema.String),
  /** Pins and addresses taken from hardware/pinmap.json and components.json. */
  configured: Schema.Array(Schema.String),
  next_steps: Schema.Array(Schema.String),
});
export type HardwareTestFirmwareCreateResult = typeof HardwareTestFirmwareCreateResult.Type;
