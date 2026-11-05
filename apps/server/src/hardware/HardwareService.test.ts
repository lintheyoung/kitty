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
