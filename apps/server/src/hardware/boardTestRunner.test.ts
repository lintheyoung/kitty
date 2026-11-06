import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  HardwareToolError,
  type HardwareFlashInput,
  type HardwareFlashResult,
  type HardwareMonitorReadInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { createBoardTest, listTestPlans, runBoardTests } from "./boardTestRunner.ts";
import * as HardwareService from "./HardwareService.ts";

const BOARD = {
  schema_version: "0.1",
  board_id: "keycap",
  name: "KeyCAP",
  mcu: { vendor: "Espressif", model: "ESP32-S3" },
  interfaces: { i2c: [{ name: "sensors", sda: 8, scl: 9 }] },
  peripherals: [{ name: "IMU", type: "imu", interface: "i2c0", address: "0x6B", part: "LSM6DSO" }],
};

const BOARD_LOG = [
  "ESP-ROM:esp32s3-20210327",
  '{"kitty":"start","firmware":"board-test","version":"0.1.0"}',
  '{"kitty":"metric","name":"chip.model","value":"ESP32-S3"}',
  '{"kitty":"metric","name":"flash.size_mb","value":8,"unit":"MB"}',
  '{"kitty":"metric","name":"heap.free_kb","value":310,"unit":"KB"}',
  '{"kitty":"metric","name":"i2c.addresses","value":["0x6b"]}',
  '{"kitty":"metric","name":"i2c.count","value":1}',
  '{"kitty":"metric","name":"imu.whoami","value":"0x6a"}',
  '{"kitty":"end"}',
].join("\r\n");

const fakeBoard = (calls: Array<string>, flash: Partial<HardwareFlashResult> = {}) =>
  HardwareService.HardwareService.of({
    flash: (input: HardwareFlashInput) =>
      Effect.sync(() => {
        calls.push(`flash ${input.path}`);
        return {
          ok: true,
          port: "/dev/cu.usbmodem1101",
          durationMs: 1,
          diagnostics: [],
          logTail: "",
          ...flash,
        };
      }),
    monitorRead: (input: HardwareMonitorReadInput) =>
      Effect.sync(() => {
        calls.push(`read ${input.port} ${input.seconds}s until=${input.until}`);
        return {
          port: input.port ?? "/dev/cu.usbmodem1101",
          text: BOARD_LOG,
          bytes: BOARD_LOG.length,
          truncated: false,
          matched: true,
          durationMs: 1,
        };
      }),
  } as unknown as HardwareService.HardwareService["Service"]);

const product = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "kitty-board-test-" });
  yield* fs.makeDirectory(path.join(workspace, "keycap", "hardware"), { recursive: true });
  yield* fs.writeFileString(
    path.join(workspace, "keycap", "hardware", "board.json"),
    JSON.stringify(BOARD),
  );
  yield* fs.writeFileString(
    path.join(workspace, "keycap", "project.json"),
    JSON.stringify({ target: "esp32s3" }),
  );
  return workspace;
});

it.effect("creates the test firmware and a plan from board.json, then runs it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workspace = yield* product();
    const created = yield* createBoardTest({ workspaceRoot: workspace, root: "keycap" });
    assert.equal(created.plan, "keycap/tests/test-plan.yaml");
    assert.include(created.files, "keycap/tests/board-test/main/board_test.c");
    assert.match(created.configured.join("\n"), /SDA GPIO8, SCL GPIO9/);
    const defaults = yield* fs.readFileString(
      `${workspace}/keycap/tests/board-test/sdkconfig.defaults`,
    );
    assert.include(defaults, "CONFIG_KITTY_TEST_IMU_ADDR=0x6b");
    assert.include(defaults, "CONFIG_KITTY_TEST_IMU_WHOAMI_REG=0x0f");
    assert.include(defaults, 'CONFIG_IDF_TARGET="esp32s3"');

    const again = yield* Effect.flip(createBoardTest({ workspaceRoot: workspace, root: "keycap" }));
    assert.equal(again.code, "already_exists");

    const listed = yield* listTestPlans(workspace);
    assert.deepStrictEqual(
      listed.plans.map((plan) => [plan.path, plan.cases, plan.errors.length]),
      [["keycap/tests/test-plan.yaml", 6, 0]],
    );

    const calls: Array<string> = [];
    const output: Array<string> = [];
    const result = yield* runBoardTests(
      { workspaceRoot: workspace, plan: "keycap/tests/test-plan.yaml" },
      { onOutput: (text) => output.push(text) },
    ).pipe(Effect.provideService(HardwareService.HardwareService, fakeBoard(calls)));

    assert.deepStrictEqual(calls, [
      "flash keycap/tests/board-test",
      String.raw`read /dev/cu.usbmodem1101 20s until="kitty"\s*:\s*"end"`,
    ]);
    assert.equal(result.stage, "done");
    assert.deepStrictEqual([result.passed, result.failed, result.missing], [5, 1, 0]);
    assert.isFalse(result.ok);
    const imu = result.cases.find((testCase) => testCase.id === "imu_id");
    assert.deepInclude(imu, { status: "fail", actual: '"0x6a"', reason: 'expected "0x6c"' });
    assert.deepStrictEqual(result.firmware, { name: "board-test", version: "0.1.0" });
    assert.match(output.join(""), /FAIL: 5 passed, 1 failed/);

    const report = result.report;
    assert.isDefined(report);
    assert.match(report?.markdown ?? "", /^keycap\/tests\/reports\/.+\.md$/);
    const markdown = yield* fs.readFileString(`${workspace}/${report?.markdown}`);
    assert.include(markdown, "# KeyCAP board test: FAIL");
    const relisted = yield* listTestPlans(workspace);
    assert.equal(relisted.plans[0]?.lastReport, report?.markdown);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reports a firmware that does not build without reading the board", () =>
  Effect.gen(function* () {
    const workspace = yield* product();
    yield* createBoardTest({ workspaceRoot: workspace, root: "keycap" });
    const calls: Array<string> = [];
    const result = yield* runBoardTests({
      workspaceRoot: workspace,
      plan: "keycap/tests/test-plan.yaml",
    }).pipe(
      Effect.provideService(
        HardwareService.HardwareService,
        fakeBoard(calls, {
          ok: false,
          diagnostics: [{ severity: "error", source: "compiler", message: "boom" }],
          logTail: "error: boom",
        }),
      ),
    );
    assert.equal(result.stage, "build_failed");
    assert.equal(result.missing, 6);
    assert.equal(result.logTail, "error: boom");
    assert.deepStrictEqual(calls, ["flash keycap/tests/board-test"]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("names the fields of an invalid plan and refuses paths outside the workspace", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const workspace = yield* product();
    yield* fs.makeDirectory(`${workspace}/keycap/tests`, { recursive: true });
    yield* fs.writeFileString(`${workspace}/keycap/tests/test-plan.yaml`, "name: x\ncases: []\n");
    const run = (plan: string) =>
      Effect.flip(
        runBoardTests({ workspaceRoot: workspace, plan }).pipe(
          Effect.provideService(HardwareService.HardwareService, fakeBoard([])),
        ),
      );
    const invalid: HardwareToolError = yield* run("keycap/tests/test-plan.yaml");
    assert.equal(invalid.code, "invalid_argument");
    assert.match(invalid.message, /schema_version/);
    assert.equal((yield* run("../elsewhere.yaml")).code, "invalid_path");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
