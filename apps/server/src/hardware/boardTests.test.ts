import { describe, expect, it } from "vite-plus/test";

import {
  describeExpect,
  judgePlan,
  parseKittyLines,
  parseTestPlan,
  renderTestReport,
} from "./boardTests.ts";

const PLAN = `
schema_version: "0.1"
name: KeyCAP board test
firmware: tests/board-test
timeout_s: 15
cases:
  - id: boot
    name: Reports its chip
    metric: chip.model
    expect: { equals: esp32-s3 }
  - id: rail
    metric: power.vbat_mv
    expect: { min: 3200, max: 3400 }
  - id: imu_on_bus
    metric: i2c.addresses
    expect: { contains: "0x6B" }
  - id: imu_id
    metric: imu.whoami
    expect: { matches: "^0x6[ab]$" }
  - id: loopback
    metric: gpio.loopback
`;

const LOG = [
  "ESP-ROM:esp32s3-20210327",
  "I (312) cpu_start: Multicore app",
  '{"kitty":"start","firmware":"board-test","version":"0.1.0"}',
  '{"kitty":"metric","name":"chip.model","value":"ESP32-S3"}',
  'I (400) board_test: {"kitty":"metric","name":"power.vbat_mv","value":3511,"unit":"mV"}',
  '{"kitty":"metric","name":"i2c.addresses","value":["0x3c","0x6b"]}',
  '{"kitty":"metric","name":"imu.whoami","value":"0x6b"}',
  '{"kitty":"metric","name":"broken"',
  '{"kitty":"end"}',
].join("\r\n");

describe("test plans", () => {
  it("decodes a plan", () => {
    const parsed = parseTestPlan(PLAN);
    if (!("plan" in parsed)) throw new Error(parsed.errors.join("\n"));
    expect(parsed.plan.cases).toHaveLength(5);
    expect(parsed.plan.timeout_s).toBe(15);
  });

  it("names the field that is wrong", () => {
    const parsed = parseTestPlan(
      `schema_version: "0.1"\nname: x\ncases:\n  - id: a\n    expect: { min: low }\n`,
    );
    expect("errors" in parsed && parsed.errors.join("\n")).toMatch(/cases\[0\]\.(metric|expect)/);
    expect(parseTestPlan("name: [unclosed")).toHaveProperty("errors");
    const repeated = parseTestPlan(
      `schema_version: "0.1"\nname: x\ncases:\n  - { id: a, metric: m }\n  - { id: a, metric: n }\n`,
    );
    expect("errors" in repeated && repeated.errors[0]).toMatch(/repeated: a/);
  });
});

describe("Kitty lines", () => {
  it("reads metrics after log prefixes and counts broken lines", () => {
    const output = parseKittyLines(LOG);
    expect(output.firmware).toEqual({ name: "board-test", version: "0.1.0" });
    expect(output.metrics.get("power.vbat_mv")).toEqual({ value: 3511, unit: "mV" });
    expect(output.ended).toBe(true);
    expect(output.unparsed).toBe(1);
  });

  it("starts over when the board resets", () => {
    const output = parseKittyLines(
      [
        '{"kitty":"start","firmware":"a","version":"1"}',
        '{"kitty":"metric","name":"old","value":1}',
        '{"kitty":"start","firmware":"a","version":"1"}',
        '{"kitty":"metric","name":"new","value":2}',
      ].join("\n"),
    );
    expect([...output.metrics.keys()]).toEqual(["new"]);
    expect(output.ended).toBe(false);
  });
});

describe("judging", () => {
  it("passes, fails and misses cases with reasons", () => {
    const parsed = parseTestPlan(PLAN);
    if (!("plan" in parsed)) throw new Error("plan");
    const result = judgePlan(parsed.plan, parseKittyLines(LOG));
    expect(result.cases.map((testCase) => [testCase.id, testCase.status])).toEqual([
      ["boot", "pass"],
      ["rail", "fail"],
      ["imu_on_bus", "pass"],
      ["imu_id", "pass"],
      ["loopback", "missing"],
    ]);
    expect(result.cases[1]).toMatchObject({ actual: "3511", unit: "mV", reason: "above 3400" });
    expect(result.cases[4]?.reason).toMatch(/finished without/);
    expect([result.passed, result.failed, result.missing]).toEqual([3, 1, 1]);
  });

  it("describes rules", () => {
    expect(describeExpect(undefined)).toBe("reported");
    expect(describeExpect({ min: 1, max: 2 })).toBe("between 1 and 2");
    expect(describeExpect({ min: 4, equals: true })).toBe("at least 4, equals true");
  });

  it("writes a Markdown report", () => {
    const markdown = renderTestReport(
      {
        plan: "tests/test-plan.yaml",
        name: "KeyCAP board test",
        stage: "done",
        ok: false,
        passed: 1,
        failed: 1,
        missing: 0,
        cases: [
          {
            id: "rail",
            name: "VBAT | rail",
            metric: "power.vbat_mv",
            status: "fail",
            expected: "at most 3400",
            actual: "3511",
            unit: "mV",
            reason: "above 3400",
          },
        ],
        port: "/dev/cu.usbmodem1101",
        firmware: { name: "board-test", version: "0.1.0" },
        unparsedLines: 0,
        durationMs: 4200,
      },
      { startedAt: "2026-11-07T01:02:03Z", product: "KeyCAP" },
    );
    expect(markdown).toContain("# KeyCAP board test: FAIL");
    expect(markdown).toContain(String.raw`VBAT \| rail`);
    expect(markdown).toContain("| 3511 mV | **fail**: above 3400 |");
  });
});
