import {
  type HardwareBuildInput,
  type HardwareBuildResult,
  type HardwareChipInfo,
  type HardwareChipInfoInput,
  type HardwareDoctorCheck,
  type HardwareDoctorInput,
  type HardwareDoctorReport,
  type HardwareIdfInstallation,
  type HardwareProject,
  type HardwareProjectCreated,
  type HardwareProjectCreateInput,
  HardwareToolError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import { logTail, parseAppBinarySize, parseBuildDiagnostics } from "./buildOutput.ts";
import { parseEsptoolChipInfo } from "./esptoolOutput.ts";
import {
  classifyIdfVersion,
  classifyKicadVersion,
  compareVersions,
  formatVersion,
  matchesIdfPythonEnv,
  parseIdfProjectName,
  parseIdfVersionCmake,
  parseKicadCliVersion,
  parseSdkconfigTarget,
  selectSerialPorts,
  SUPPORTED_IDF,
  SUPPORTED_KICAD_MAJOR,
  type Version,
} from "./toolchainVersions.ts";

/**
 * Kitty's hardware runtime. The UI (RPC) and agents (MCP `hw_*` tools) call the
 * same methods, so the two can never disagree about the machine's state.
 */
export class HardwareService extends Context.Service<
  HardwareService,
  {
    readonly doctor: (input: HardwareDoctorInput) => Effect.Effect<HardwareDoctorReport>;
    /** Resets the board: esptool enters the bootloader to read the chip. */
    readonly chipInfo: (
      input: HardwareChipInfoInput,
    ) => Effect.Effect<HardwareChipInfo, HardwareToolError>;
    /** `directory` is absolute; callers resolve and confine it first. */
    readonly createProject: (
      input: HardwareProjectCreateInput & { readonly directory: string },
    ) => Effect.Effect<HardwareProjectCreated, HardwareToolError>;
    readonly build: (
      input: HardwareBuildInput & { readonly directory: string },
    ) => Effect.Effect<HardwareBuildResult, HardwareToolError>;
    /** ESP-IDF projects up to three levels below `workspaceRoot`. */
    readonly listProjects: (workspaceRoot: string) => Effect.Effect<ReadonlyArray<HardwareProject>>;
  }
>()("t3/hardware/HardwareService") {}

const MAC_KICAD_CLI = "/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli";
const pinnedIdf = `${SUPPORTED_IDF.major}.${SUPPORTED_IDF.minor}`;

interface FoundIdf {
  readonly path: string;
  readonly version: Version;
}

export const make = Effect.fn("HardwareService.make")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;

  const readDirectory = (directory: string) =>
    fs.readDirectory(directory).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const exists = (target: string) => fs.exists(target).pipe(Effect.orElseSucceed(() => false));

  const readIdf = Effect.fn("HardwareService.readIdf")(function* (root: string) {
    const text = yield* fs
      .readFileString(path.join(root, "tools", "cmake", "version.cmake"))
      .pipe(Effect.option);
    if (Option.isNone(text)) return Option.none<FoundIdf>();
    const version = parseIdfVersionCmake(text.value);
    return version ? Option.some({ path: root, version }) : Option.none<FoundIdf>();
  });

  /** IDF_PATH, `~/esp/*` (manual installs), and `~/.espressif/<version>/esp-idf` (EIM). */
  const findIdfInstallations = Effect.fn("HardwareService.findIdfInstallations")(function* (
    home: string,
    env: NodeJS.ProcessEnv,
  ) {
    const candidates = new Set<string>();
    const idfPath = env.IDF_PATH?.trim();
    if (idfPath) candidates.add(path.resolve(idfPath));
    const espDir = path.join(home, "esp");
    for (const name of yield* readDirectory(espDir)) candidates.add(path.join(espDir, name));
    const espressifDir = path.join(home, ".espressif");
    for (const name of yield* readDirectory(espressifDir)) {
      candidates.add(path.join(espressifDir, name, "esp-idf"));
    }
    const found: Array<FoundIdf> = [];
    for (const candidate of candidates) {
      const idf = yield* readIdf(candidate);
      if (Option.isSome(idf)) found.push(idf.value);
    }
    return found;
  });

  const checkIdf = (selected: FoundIdf | undefined, found: number): HardwareDoctorCheck => {
    if (!selected) {
      return {
        id: "esp-idf",
        status: "missing",
        detail: `ESP-IDF not found. Install v${pinnedIdf} (https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/get-started/).`,
      };
    }
    const status = classifyIdfVersion(selected.version);
    const others = found > 1 ? ` ${found - 1} other installation(s) found.` : "";
    return {
      id: "esp-idf",
      status,
      version: formatVersion(selected.version),
      path: selected.path,
      detail:
        (status === "ok"
          ? `Supported ESP-IDF v${pinnedIdf}.`
          : `Kitty supports ESP-IDF v${pinnedIdf}; this is v${formatVersion(selected.version)}.`) +
        others,
    };
  };

  const checkPythonEnv = Effect.fn("HardwareService.checkPythonEnv")(function* (
    home: string,
    idf: FoundIdf | undefined,
  ) {
    if (!idf) {
      return {
        python: {
          id: "python-env",
          status: "missing",
          detail: "Needs ESP-IDF first.",
        } satisfies HardwareDoctorCheck,
        bin: undefined,
      };
    }
    const envsDir = path.join(home, ".espressif", "python_env");
    const names = (yield* readDirectory(envsDir))
      .filter((name) => matchesIdfPythonEnv(name, idf.version))
      .toSorted()
      .toReversed();
    for (const name of names) {
      const bin = path.join(envsDir, name, "bin");
      if (yield* exists(path.join(bin, "python"))) {
        return {
          python: {
            id: "python-env",
            status: "ok",
            path: path.join(envsDir, name),
            detail: "ESP-IDF Python environment is installed.",
          } satisfies HardwareDoctorCheck,
          bin,
        };
      }
    }
    return {
      python: {
        id: "python-env",
        status: "missing",
        detail: `No Python environment for ESP-IDF v${idf.version.major}.${idf.version.minor}. Run install.sh in ${idf.path}.`,
      } satisfies HardwareDoctorCheck,
      bin: undefined,
    };
  });

  const checkEsptool = Effect.fn("HardwareService.checkEsptool")(function* (
    bin: string | undefined,
  ) {
    if (bin) {
      for (const name of ["esptool.py", "esptool"]) {
        const candidate = path.join(bin, name);
        if (yield* exists(candidate)) {
          return {
            id: "esptool",
            status: "ok",
            path: candidate,
            detail: "esptool is installed in the ESP-IDF Python environment.",
          } satisfies HardwareDoctorCheck;
        }
      }
    }
    return {
      id: "esptool",
      status: "missing",
      detail: "esptool not found in the ESP-IDF Python environment.",
    } satisfies HardwareDoctorCheck;
  });

  const checkKicad = Effect.fn("HardwareService.checkKicad")(function* (env: NodeJS.ProcessEnv) {
    const configured = env.KICAD_CLI?.trim();
    const candidates = configured ? [configured, MAC_KICAD_CLI] : [MAC_KICAD_CLI, "kicad-cli"];
    for (const command of candidates) {
      const result = yield* processRunner
        .run({ command, args: ["version"], timeout: "15 seconds" })
        .pipe(Effect.option);
      if (Option.isNone(result) || result.value.code !== 0) continue;
      const version = parseKicadCliVersion(result.value.stdout);
      if (!version) continue;
      const status = classifyKicadVersion(version);
      return {
        id: "kicad",
        status,
        version: formatVersion(version),
        path: command,
        detail:
          status === "ok"
            ? `Supported KiCad ${SUPPORTED_KICAD_MAJOR}.`
            : `Kitty supports KiCad ${SUPPORTED_KICAD_MAJOR}; this is ${formatVersion(version)}.`,
      } satisfies HardwareDoctorCheck;
    }
    return {
      id: "kicad",
      status: "missing",
      detail: `kicad-cli not found. Install KiCad ${SUPPORTED_KICAD_MAJOR} or set KICAD_CLI.`,
    } satisfies HardwareDoctorCheck;
  });

  /** The ESP-IDF, venv and boards every operation works with. */
  const resolveToolchain = Effect.fn("HardwareService.resolveToolchain")(function* (
    idfPath?: string,
  ) {
    const home = yield* HostProcess.HomeDirectory;
    const env = yield* HostProcess.Environment;
    const platform = yield* HostProcess.Platform;
    const found = (yield* findIdfInstallations(home, env)).toSorted((a, b) =>
      compareVersions(b.version, a.version),
    );
    const requested = idfPath?.trim();
    const fromEnv = env.IDF_PATH?.trim();
    const selected = requested
      ? Option.getOrUndefined(yield* readIdf(path.resolve(requested)))
      : ((fromEnv ? found.find((idf) => idf.path === path.resolve(fromEnv)) : undefined) ??
        found.find((idf) => classifyIdfVersion(idf.version) === "ok") ??
        found[0]);
    const { python, bin } = yield* checkPythonEnv(home, selected);
    const serialPorts = selectSerialPorts(yield* readDirectory("/dev"), platform);
    return { env, platform, found, selected, python, bin, serialPorts };
  });

  const doctor = Effect.fn("HardwareService.doctor")(function* (input: HardwareDoctorInput) {
    const { env, platform, found, selected, python, bin, serialPorts } = yield* resolveToolchain(
      input.idfPath,
    );
    const checks: ReadonlyArray<HardwareDoctorCheck> = [
      checkIdf(selected, found.length),
      python,
      yield* checkEsptool(bin),
      yield* checkKicad(env),
      serialPorts.length > 0
        ? {
            id: "serial",
            status: "ok",
            detail: `${serialPorts.length} serial port(s) found.`,
          }
        : {
            id: "serial",
            status: "warning",
            detail:
              platform === "darwin"
                ? 'No board found. Plug in the ESP32-S3 with a data cable (not charge-only), directly rather than through a hub, and allow it in the macOS "Allow accessory to connect" prompt (System Settings > Privacy & Security).'
                : "No board found. Plug in the ESP32-S3 with a data cable (not charge-only), and check that your user can open serial devices (e.g. the dialout group).",
          },
    ];
    const idfInstallations: ReadonlyArray<HardwareIdfInstallation> = found.map((idf) => ({
      path: idf.path,
      version: formatVersion(idf.version),
    }));
    return {
      ok: checks.every((check) => check.id === "serial" || check.status === "ok"),
      checks,
      idfInstallations,
      serialPorts,
    } satisfies HardwareDoctorReport;
  });

  const failure = (code: HardwareToolError["code"], message: string) =>
    new HardwareToolError({ code, message });

  const requireIdf = Effect.fn("HardwareService.requireIdf")(function* () {
    const toolchain = yield* resolveToolchain();
    if (!toolchain.selected || !toolchain.bin) {
      return yield* failure(
        "toolchain_missing",
        "ESP-IDF or its Python environment is missing. Run hw_doctor for details.",
      );
    }
    return { ...toolchain, idf: toolchain.selected, bin: toolchain.bin };
  });

  /** Runs `idf.py` inside ESP-IDF's own environment, as a terminal after export.sh would. */
  const runIdf = (
    idf: FoundIdf,
    env: NodeJS.ProcessEnv,
    cwd: string,
    args: ReadonlyArray<string>,
    timeout: ProcessRunner.ProcessRunInput["timeout"],
  ) =>
    processRunner
      .run({
        command: "/bin/bash",
        args: [
          "-c",
          '. "$IDF_PATH/export.sh" >/dev/null 2>&1 && exec idf.py "$@"',
          "idf.py",
          ...args,
        ],
        cwd,
        env: { ...env, IDF_PATH: idf.path },
        timeout,
        outputMode: "truncate",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(
        Effect.mapError((cause) =>
          failure("command_failed", `idf.py ${args.join(" ")} could not run: ${cause.message}`),
        ),
      );

  const chipInfo = Effect.fn("HardwareService.chipInfo")(function* (input: HardwareChipInfoInput) {
    const { bin, serialPorts } = yield* requireIdf();
    const port = input.port?.trim() || serialPorts[0];
    if (!port) return yield* failure("no_board", "No board is connected. Run hw_doctor.");
    if (!input.port && serialPorts.length > 1) {
      return yield* failure(
        "board_ambiguous",
        `Several boards are connected (${serialPorts.join(", ")}). Pass port.`,
      );
    }
    const result = yield* processRunner
      .run({
        command: path.join(bin, "python"),
        args: ["-m", "esptool", "--port", port, "flash_id"],
        timeout: "45 seconds",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.mapError((cause) => failure("command_failed", cause.message)));
    const info = parseEsptoolChipInfo(result.stdout, port);
    if (!info) {
      return yield* failure(
        "command_failed",
        `esptool could not read the chip on ${port}. ${logTail(`${result.stdout}\n${result.stderr}`, 6)}`,
      );
    }
    return info;
  });

  const createProject = Effect.fn("HardwareService.createProject")(function* (
    input: HardwareProjectCreateInput & { readonly directory: string },
  ) {
    const { idf, env } = yield* requireIdf();
    const template = input.template ?? "hello_world";
    const target = input.target ?? "esp32s3";
    if (yield* exists(input.directory)) {
      return yield* failure("already_exists", `${input.path} already exists.`);
    }
    const source = path.join(idf.path, "examples", "get-started", template);
    const fail = (message: string) => (cause: { readonly message: string }) =>
      failure("command_failed", `${message}: ${cause.message}`);
    yield* fs
      .copy(source, input.directory)
      .pipe(Effect.mapError(fail(`Could not copy the ${template} template`)));
    // Example test harnesses are noise in a new project.
    for (const extra of ["pytest_hello_world.py", "pytest_blink.py"]) {
      yield* fs.remove(path.join(input.directory, extra)).pipe(Effect.ignore);
    }
    if (input.flashSize) {
      const defaults = path.join(input.directory, "sdkconfig.defaults");
      const previous = yield* fs.readFileString(defaults).pipe(Effect.orElseSucceed(() => ""));
      yield* fs
        .writeFileString(
          defaults,
          `${previous}${previous && !previous.endsWith("\n") ? "\n" : ""}CONFIG_ESPTOOLPY_FLASHSIZE_${input.flashSize}=y\n`,
        )
        .pipe(Effect.mapError(fail("Could not write sdkconfig.defaults")));
    }
    const setTarget = yield* runIdf(idf, env, input.directory, ["set-target", target], "5 minutes");
    if (setTarget.code !== 0 || setTarget.timedOut) {
      return yield* failure(
        "command_failed",
        `idf.py set-target ${target} failed.\n${logTail(`${setTarget.stdout}\n${setTarget.stderr}`, 20)}`,
      );
    }
    const files = (yield* fs
      .readDirectory(input.directory, { recursive: true })
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => [])))
      .filter((file) => !file.startsWith("build") && !file.startsWith("managed_components"))
      .toSorted();
    return {
      path: input.path,
      template,
      target,
      ...(input.flashSize ? { flashSize: input.flashSize } : {}),
      files,
    } satisfies HardwareProjectCreated;
  });

  const build = Effect.fn("HardwareService.build")(function* (
    input: HardwareBuildInput & { readonly directory: string },
  ) {
    const { idf, env } = yield* requireIdf();
    if (!(yield* exists(path.join(input.directory, "CMakeLists.txt")))) {
      return yield* failure(
        "invalid_path",
        `${input.path} is not an ESP-IDF project (no CMakeLists.txt).`,
      );
    }
    const started = yield* Clock.currentTimeMillis;
    const result = yield* runIdf(idf, env, input.directory, ["build"], "20 minutes");
    const durationMs = (yield* Clock.currentTimeMillis) - started;
    const output = `${result.stdout}\n${result.stderr}`;
    const appBinary = parseAppBinarySize(output);
    return {
      ok: result.code === 0 && !result.timedOut,
      durationMs,
      diagnostics: parseBuildDiagnostics(output, input.directory),
      ...(appBinary ? { appBinary } : {}),
      logTail: result.timedOut ? "Build timed out after 20 minutes." : logTail(output),
    } satisfies HardwareBuildResult;
  });

  const SKIPPED_DIRECTORIES = new Set([
    "node_modules",
    "build",
    "managed_components",
    "components",
    ".git",
    ".t3",
  ]);
  const listProjects = Effect.fn("HardwareService.listProjects")(function* (workspaceRoot: string) {
    const projects: Array<HardwareProject> = [];
    let frontier: ReadonlyArray<string> = [""];
    for (let depth = 0; depth <= 3 && frontier.length > 0; depth++) {
      const next: Array<string> = [];
      for (const relative of frontier) {
        const directory = path.join(workspaceRoot, relative);
        const cmake = yield* fs
          .readFileString(path.join(directory, "CMakeLists.txt"))
          .pipe(Effect.orElseSucceed(() => ""));
        const name = parseIdfProjectName(cmake);
        if (name) {
          const sdkconfig = yield* fs
            .readFileString(path.join(directory, "sdkconfig"))
            .pipe(Effect.orElseSucceed(() => ""));
          const target = parseSdkconfigTarget(sdkconfig);
          projects.push({ path: relative || ".", name, ...(target ? { target } : {}) });
          continue;
        }
        for (const entry of yield* readDirectory(directory)) {
          if (entry.startsWith(".") || SKIPPED_DIRECTORIES.has(entry)) continue;
          const child = relative ? path.join(relative, entry) : entry;
          const info = yield* fs.stat(path.join(workspaceRoot, child)).pipe(Effect.option);
          if (Option.isSome(info) && info.value.type === "Directory") next.push(child);
        }
      }
      frontier = next;
    }
    return projects.toSorted((a, b) => a.path.localeCompare(b.path));
  });

  return HardwareService.of({ doctor, chipInfo, createProject, build, listProjects });
});

export const layer = Layer.effect(HardwareService, make());
