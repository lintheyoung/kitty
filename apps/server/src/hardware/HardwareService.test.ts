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
  run: (input: ProcessRunner.ProcessRunInput) => ReturnType<typeof output>,
  use: (service: HardwareService.HardwareService["Service"]) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const service = yield* HardwareService.make();
    return yield* use(service);
  }).pipe(
    Effect.provideService(
      ProcessRunner.ProcessRunner,
      ProcessRunner.ProcessRunner.of({ run: (input) => Effect.succeed(run(input)) }),
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
