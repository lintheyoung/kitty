import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import * as HardwareService from "./HardwareService.ts";

const kicadCli = (stdout: string, code = 0) =>
  ProcessRunner.ProcessRunner.of({
    run: () =>
      Effect.succeed({
        stdout,
        stderr: "",
        code: code as never,
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      }),
  });

const writeIdf = Effect.fn(function* (
  root: string,
  [major, minor, patch]: [number, number, number],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.join(root, "tools", "cmake"), { recursive: true });
  yield* fs.writeFileString(
    path.join(root, "tools", "cmake", "version.cmake"),
    `set(IDF_VERSION_MAJOR ${major})\nset(IDF_VERSION_MINOR ${minor})\nset(IDF_VERSION_PATCH ${patch})\n`,
  );
});

const doctorIn = (home: string, env: NodeJS.ProcessEnv, kicad = kicadCli("10.0.7\n")) =>
  Effect.gen(function* () {
    const service = yield* HardwareService.make();
    return yield* service.doctor({});
  }).pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, kicad),
    Effect.provideService(HostProcess.HomeDirectory, home),
    Effect.provideService(HostProcess.Environment, env),
    Effect.provideService(HostProcess.Platform, "linux"),
  );

it.effect("prefers the supported ESP-IDF and finds its venv and esptool", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "kitty-hw-" });
    yield* writeIdf(path.join(home, "esp", "esp-idf"), [5, 4, 2]);
    yield* writeIdf(path.join(home, "esp", "esp-idf-v5.5"), [5, 5, 5]);
    const bin = path.join(home, ".espressif", "python_env", "idf5.5_py3.14_env", "bin");
    yield* fs.makeDirectory(bin, { recursive: true });
    yield* fs.writeFileString(path.join(bin, "python"), "");
    yield* fs.writeFileString(path.join(bin, "esptool.py"), "");

    const report = yield* doctorIn(home, {});
    const byId = Object.fromEntries(report.checks.map((check) => [check.id, check]));
    assert.deepStrictEqual(
      report.idfInstallations.map((idf) => idf.version),
      ["5.5.5", "5.4.2"],
    );
    assert.equal(byId["esp-idf"]?.status, "ok");
    assert.equal(byId["esp-idf"]?.path, path.join(home, "esp", "esp-idf-v5.5"));
    assert.equal(byId["python-env"]?.status, "ok");
    assert.equal(byId["esptool"]?.path, path.join(bin, "esptool.py"));
    assert.equal(byId["kicad"]?.version, "10.0.7");
    assert.isTrue(report.ok);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("follows IDF_PATH even when it is not the supported version", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "kitty-hw-" });
    const old = path.join(home, "esp", "esp-idf");
    yield* writeIdf(old, [5, 4, 2]);
    yield* writeIdf(path.join(home, "esp", "esp-idf-v5.5"), [5, 5, 5]);

    const report = yield* doctorIn(home, { IDF_PATH: old }, kicadCli("", 1));
    const byId = Object.fromEntries(report.checks.map((check) => [check.id, check]));
    assert.equal(byId["esp-idf"]?.path, old);
    assert.equal(byId["esp-idf"]?.status, "warning");
    assert.equal(byId["python-env"]?.status, "missing");
    assert.equal(byId["kicad"]?.status, "missing");
    assert.isFalse(report.ok);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reports a missing ESP-IDF", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "kitty-hw-" });
    const report = yield* doctorIn(home, {});
    assert.equal(report.checks.find((check) => check.id === "esp-idf")?.status, "missing");
    assert.deepStrictEqual(report.idfInstallations, []);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const output = (stdout: string, code = 0) => ({
  stdout,
  stderr: "",
  code: code as never,
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

/** A home with ESP-IDF 5.5 (with a hello_world example) and its venv. */
const espHome = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "kitty-hw-" });
  const idf = path.join(home, "esp", "esp-idf-v5.5");
  yield* writeIdf(idf, [5, 5, 5]);
  const example = path.join(idf, "examples", "get-started", "hello_world");
  yield* fs.makeDirectory(path.join(example, "main"), { recursive: true });
  yield* fs.writeFileString(path.join(example, "CMakeLists.txt"), "project(hello_world)\n");
  yield* fs.writeFileString(
    path.join(example, "main", "hello_world_main.c"),
    "void app_main(void) {}\n",
  );
  yield* fs.writeFileString(path.join(example, "pytest_hello_world.py"), "");
  const bin = path.join(home, ".espressif", "python_env", "idf5.5_py3.14_env", "bin");
  yield* fs.makeDirectory(bin, { recursive: true });
  yield* fs.writeFileString(path.join(bin, "python"), "");
  return { home, idf };
});

const withRunner = <A, E, R>(
  home: string,
  run: (
    input: ProcessRunner.ProcessRunInput,
  ) => ReturnType<typeof output> | Effect.Effect<ReturnType<typeof output>>,
  use: (service: HardwareService.HardwareService["Service"]) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const service = yield* HardwareService.make();
    return yield* use(service);
  }).pipe(
    Effect.provideService(
      ProcessRunner.ProcessRunner,
      ProcessRunner.ProcessRunner.of({
        run: (input) => {
          const result = run(input);
          return Effect.isEffect(result) ? result : Effect.succeed(result);
        },
      }),
    ),
    Effect.provideService(HostProcess.HomeDirectory, home),
    Effect.provideService(HostProcess.Environment, {}),
    Effect.provideService(HostProcess.Platform, "linux"),
  );

it.effect(
  "creates a project from the example with the board's flash size, then sets the target",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { home, idf } = yield* espHome();
      const directory = path.join(home, "work", "blink");
      const calls: Array<ProcessRunner.ProcessRunInput> = [];
      const created = yield* withRunner(
        home,
        (input) => {
          calls.push(input);
          return output("Done");
        },
        (service) => service.createProject({ path: "blink", directory, flashSize: "4MB" }),
      );
      assert.deepStrictEqual(created.files, [
        "CMakeLists.txt",
        "main",
        "main/hello_world_main.c",
        "sdkconfig.defaults",
      ]);
      assert.equal(
        yield* fs.readFileString(path.join(directory, "sdkconfig.defaults")),
        "CONFIG_ESPTOOLPY_FLASHSIZE_4MB=y\n",
      );
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.cwd, directory);
      assert.equal(calls[0]?.env?.IDF_PATH, idf);
      assert.deepStrictEqual(calls[0]?.args.slice(-2), ["set-target", "esp32s3"]);

      const again = yield* Effect.flip(
        withRunner(
          home,
          () => output(""),
          (service) => service.createProject({ path: "blink", directory }),
        ),
      );
      assert.equal(again.code, "already_exists");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("returns a failed build's diagnostics instead of failing the call", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { home } = yield* espHome();
    const directory = path.join(home, "app");
    yield* fs.makeDirectory(directory);
    yield* fs.writeFileString(path.join(directory, "CMakeLists.txt"), "");
    const result = yield* withRunner(
      home,
      () => output(`${directory}/main/app.c:3:5: error: 'x' undeclared\nninja: build stopped`, 2),
      (service) => service.build({ path: "app", directory }),
    );
    assert.isFalse(result.ok);
    assert.deepStrictEqual(
      result.diagnostics.map((d) => [d.file, d.line, d.message]),
      [["main/app.c", 3, "'x' undeclared"]],
    );

    const notProject = yield* Effect.flip(
      withRunner(
        home,
        () => output(""),
        (service) => service.build({ path: ".", directory: home }),
      ),
    );
    assert.equal(notProject.code, "invalid_path");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("streams build output as it arrives, keeping split UTF-8 characters whole", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { home } = yield* espHome();
    const directory = path.join(home, "app");
    yield* fs.makeDirectory(directory);
    yield* fs.writeFileString(path.join(directory, "CMakeLists.txt"), "");
    const bytes = new TextEncoder().encode("[1/2] 编译\n[2/2] done\n");
    const chunks: Array<string> = [];
    const result = yield* withRunner(
      home,
      (input) => {
        // Split inside the three-byte "编" so the decoder has to carry it over.
        input.onStdoutChunk?.(bytes.slice(0, 7));
        input.onStdoutChunk?.(bytes.slice(7));
        return output(new TextDecoder().decode(bytes));
      },
      (service) => service.build({ path: "app", directory }, (text) => chunks.push(text)),
    );
    assert.isTrue(result.ok);
    assert.equal(chunks.join(""), "[1/2] 编译\n[2/2] done\n");
    assert.isFalse(chunks.some((chunk) => chunk.includes("�")));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

/**
 * A stand-in for Kconfig: FREERTOS_HZ must be 1..1000 (else the default 100),
 * FLASHSIZE is a choice where the last `=y` wins, and unknown options vanish.
 */
function fakeKconfig(sdkconfig: string): string {
  const lines = sdkconfig.trimEnd().split("\n");
  const known = new Set(["CONFIG_FREERTOS_HZ", "CONFIG_FLASHSIZE_2MB", "CONFIG_FLASHSIZE_4MB"]);
  let hz = 100;
  let flash = "CONFIG_FLASHSIZE_2MB";
  for (const line of lines) {
    const hzMatch = /^CONFIG_FREERTOS_HZ=(\d+)$/.exec(line);
    if (hzMatch) hz = Number(hzMatch[1]) <= 1000 ? Number(hzMatch[1]) : 100;
    const flashMatch = /^(CONFIG_FLASHSIZE_\w+)=y$/.exec(line);
    if (flashMatch && known.has(flashMatch[1] ?? "")) flash = flashMatch[1] ?? flash;
  }
  return [
    `CONFIG_FREERTOS_HZ=${hz}`,
    ...["CONFIG_FLASHSIZE_2MB", "CONFIG_FLASHSIZE_4MB"].map((key) =>
      key === flash ? `${key}=y` : `# ${key} is not set`,
    ),
    "",
  ].join("\n");
}

const MENUS = JSON.stringify([
  {
    type: "choice",
    name: "FLASHSIZE",
    children: [
      { type: "bool", name: "FLASHSIZE_2MB", children: [] },
      { type: "bool", name: "FLASHSIZE_4MB", children: [] },
    ],
  },
]);

const configProject = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { home } = yield* espHome();
  const directory = path.join(home, "app");
  yield* fs.makeDirectory(path.join(directory, "build", "config"), { recursive: true });
  yield* fs.writeFileString(path.join(directory, "CMakeLists.txt"), "");
  yield* fs.writeFileString(path.join(directory, "build", "config", "kconfig_menus.json"), MENUS);
  yield* fs.writeFileString(
    path.join(directory, "sdkconfig"),
    "CONFIG_FREERTOS_HZ=100\nCONFIG_FLASHSIZE_2MB=y\n# CONFIG_FLASHSIZE_4MB is not set\n",
  );
  yield* fs.writeFileString(path.join(directory, "sdkconfig.defaults"), "CONFIG_FLASHSIZE_2MB=y\n");
  const reconfigures: Array<string> = [];
  const runner = (input: ProcessRunner.ProcessRunInput) =>
    Effect.gen(function* () {
      if (input.args.at(-1) === "reconfigure") {
        const file = path.join(directory, "sdkconfig");
        const next = fakeKconfig(yield* fs.readFileString(file));
        yield* fs.writeFileString(file, next);
        reconfigures.push(next);
      }
      return output("");
    }).pipe(Effect.orDie);
  return { home, directory, runner, reconfigures };
});

it.effect("sets options through Kconfig, clearing the rest of a choice and syncing defaults", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { home, directory, runner } = yield* configProject();
    const result = yield* withRunner(home, runner, (service) =>
      service.sdkconfigSet({
        path: "app",
        directory,
        values: { freertos_hz: 1000, FLASHSIZE_4MB: true, KITTY_NOPE: true },
      }),
    );
    assert.deepStrictEqual(result.applied, [
      { key: "CONFIG_FREERTOS_HZ", value: 1000 },
      { key: "CONFIG_FLASHSIZE_4MB", value: true },
    ]);
    assert.deepStrictEqual(
      result.rejected.map((entry) => entry.key),
      ["CONFIG_KITTY_NOPE"],
    );
    assert.isTrue(result.persisted);
    assert.equal(
      yield* fs.readFileString(path.join(directory, "sdkconfig.defaults")),
      "# CONFIG_FLASHSIZE_2MB is not set\nCONFIG_FREERTOS_HZ=1000\nCONFIG_FLASHSIZE_4MB=y\n",
    );

    // Switching the choice back works even though 4MB is now later in the file.
    const back = yield* withRunner(home, runner, (service) =>
      service.sdkconfigGet({ path: "app", directory, keys: ["FLASHSIZE_2MB", "NOPE"] }),
    );
    assert.deepStrictEqual(back.entries, [{ key: "CONFIG_FLASHSIZE_2MB", value: false }]);
    assert.deepStrictEqual(back.missing, ["CONFIG_NOPE"]);
    const switched = yield* withRunner(home, runner, (service) =>
      service.sdkconfigSet({ path: "app", directory, values: { FLASHSIZE_2MB: true } }),
    );
    assert.deepStrictEqual(switched.applied, [{ key: "CONFIG_FLASHSIZE_2MB", value: true }]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps the previous value when Kconfig rejects a new one", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { home, directory, runner } = yield* configProject();
    yield* withRunner(home, runner, (service) =>
      service.sdkconfigSet({ path: "app", directory, values: { FREERTOS_HZ: 1000 } }),
    );
    const result = yield* withRunner(home, runner, (service) =>
      service.sdkconfigSet({
        path: "app",
        directory,
        values: { FREERTOS_HZ: 5000, FLASHSIZE_4MB: true },
        persist: false,
      }),
    );
    assert.deepStrictEqual(result.rejected, [
      {
        key: "CONFIG_FREERTOS_HZ",
        requested: 5000,
        actual: 100,
        reason: "Kconfig kept another value: out of range, or another option decides it.",
      },
    ]);
    assert.isFalse(result.persisted);
    const sdkconfig = yield* fs.readFileString(path.join(directory, "sdkconfig"));
    assert.include(sdkconfig, "CONFIG_FREERTOS_HZ=1000");
    assert.include(sdkconfig, "CONFIG_FLASHSIZE_4MB=y");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects bad option names and empty reads before touching the project", () =>
  Effect.gen(function* () {
    const { home, directory, runner, reconfigures } = yield* configProject();
    const badKey = yield* Effect.flip(
      withRunner(home, runner, (service) =>
        service.sdkconfigSet({ path: "app", directory, values: { "bad-key": 1 } }),
      ),
    );
    assert.equal(badKey.code, "invalid_argument");
    const noQuery = yield* Effect.flip(
      withRunner(home, runner, (service) => service.sdkconfigGet({ path: "app", directory })),
    );
    assert.equal(noQuery.code, "invalid_argument");
    assert.equal(reconfigures.length, 0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
