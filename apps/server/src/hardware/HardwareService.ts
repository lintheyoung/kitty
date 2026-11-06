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
  type HardwareSdkconfigEntry,
  type HardwareSdkconfigGetInput,
  type HardwareSdkconfigGetResult,
  type HardwareSdkconfigSetInput,
  type HardwareSdkconfigSetResult,
  type HardwareSetTargetInput,
  type HardwareSetTargetResult,
  type HardwareFlashBackup,
  type HardwareFlashBackupMode,
  type HardwareFlashInput,
  type HardwareFlashResult,
  type HardwareMonitorEvent,
  type HardwareMonitorInput,
  type HardwareMonitorReadInput,
  type HardwareMonitorReadResult,
  type HardwarePortsResult,
  type HardwareResetInput,
  type HardwareResetResult,
  type HardwareApproval,
  type HardwareToolchainInstallInput,
  type HardwareToolchainInstallResult,
  HardwareToolError,
  type ThreadId,
} from "@t3tools/contracts";
import { KITTY_HOME_DIRNAME } from "@t3tools/shared/kittyBrand";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as Stream from "effect/Stream";

import * as ProcessRunner from "../processRunner.ts";
import { logTail, parseAppBinarySize, parseBuildDiagnostics } from "./buildOutput.ts";
import { parseEsptoolChipInfo } from "./esptoolOutput.ts";
import { makeHardwareApprovals } from "./hardwareApprovals.ts";
import { kicadCliCandidates } from "./KicadService.ts";
import { makeSerialLeases } from "./serialLeases.ts";
import {
  EIM_VERSION,
  eimAsset,
  eimDownloadUrl,
  eimInstallArgs,
  KITTY_IDF_RELEASE,
} from "./toolchainInstall.ts";
import { LIST_PORTS_SCRIPT, MONITOR_SCRIPT, monitorTail, parsePortList } from "./serialPorts.ts";
import {
  applySdkconfigUpdates,
  encodeSdkconfigValue,
  entryValue,
  isSdkconfigKey,
  normalizeSdkconfigKey,
  parseKconfigChoices,
  parseSdkconfig,
  searchSdkconfig,
} from "./sdkconfig.ts";
import {
  classifyIdfVersion,
  classifyKicadVersion,
  compareVersions,
  formatVersion,
  matchesIdfPythonEnv,
  type EimInstall,
  parseEimInstalls,
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
    /** `onOutput` receives build output as it is printed, for live logs. */
    readonly build: (
      input: HardwareBuildInput & { readonly directory: string },
      onOutput?: (text: string) => void,
    ) => Effect.Effect<HardwareBuildResult, HardwareToolError>;
    /** Serial ports with what each is (native USB, CP210x, CH34x…) and who holds it. */
    readonly ports: Effect.Effect<HardwarePortsResult, HardwareToolError>;
    /** Listens to a board for a few seconds (after a reset, by default). */
    readonly monitorRead: (
      input: HardwareMonitorReadInput,
    ) => Effect.Effect<HardwareMonitorReadResult, HardwareToolError>;
    /** The panel's live monitor; yields the port to flashes and agent reads. */
    readonly monitor: (
      input: HardwareMonitorInput,
      onEvent: (event: HardwareMonitorEvent) => void,
    ) => Effect.Effect<void, HardwareToolError>;
    readonly reset: (
      input: HardwareResetInput,
    ) => Effect.Effect<HardwareResetResult, HardwareToolError>;
    /** Backs the board up (first time), then `idf.py flash`, which builds first if needed. */
    readonly flash: (
      input: HardwareFlashInput & { readonly directory: string },
      options?: {
        readonly onOutput?: ((text: string) => void) | undefined;
        readonly approvalFor?: { readonly threadId?: ThreadId | undefined } | undefined;
      },
    ) => Effect.Effect<HardwareFlashResult, HardwareToolError>;
    /**
     * Installs Kitty's ESP-IDF with Espressif's installer (EIM), downloading
     * EIM first. `basePath` / `registryDir` redirect the install (tests).
     */
    readonly installToolchain: (
      input: HardwareToolchainInstallInput & {
        readonly basePath?: string | undefined;
        readonly registryDir?: string | undefined;
      },
      onOutput: (text: string) => void,
    ) => Effect.Effect<HardwareToolchainInstallResult, HardwareToolError>;
    /** `git init` plus a first commit of everything; false without git or a git identity. */
    readonly initRepository: (root: string, message: string) => Effect.Effect<boolean>;
    /** Agent flashes waiting for the user's answer. */
    readonly approvals: Stream.Stream<ReadonlyArray<HardwareApproval>>;
    readonly respondApproval: (id: string, allow: boolean) => Effect.Effect<boolean>;
    /** Switches the chip; regenerates sdkconfig from sdkconfig.defaults and clears the build. */
    readonly setTarget: (
      input: HardwareSetTargetInput & { readonly directory: string },
    ) => Effect.Effect<HardwareSetTargetResult, HardwareToolError>;
    readonly sdkconfigGet: (
      input: HardwareSdkconfigGetInput & { readonly directory: string },
    ) => Effect.Effect<HardwareSdkconfigGetResult, HardwareToolError>;
    /** Applies values through Kconfig (`idf.py reconfigure`) and reports what it kept. */
    readonly sdkconfigSet: (
      input: HardwareSdkconfigSetInput & { readonly directory: string },
    ) => Effect.Effect<HardwareSdkconfigSetResult, HardwareToolError>;
    /** ESP-IDF projects up to three levels below `workspaceRoot`. */
    readonly listProjects: (workspaceRoot: string) => Effect.Effect<ReadonlyArray<HardwareProject>>;
  }
>()("t3/hardware/HardwareService") {}

const pinnedIdf = `${SUPPORTED_IDF.major}.${SUPPORTED_IDF.minor}`;

/** Decodes chunked process output without splitting multi-byte characters. */
function utf8Chunks(onText: (text: string) => void) {
  const decoder = new TextDecoder();
  return (chunk: Uint8Array) => {
    const text = decoder.decode(chunk, { stream: true });
    if (text.length > 0) onText(text);
  };
}

/** "4MB" → 4 MiB; undefined for anything esptool did not report as a size. */
function flashSizeBytes(size: string | undefined): number | undefined {
  const match = /^(\d+)MB$/.exec(size?.trim() ?? "");
  return match ? Number(match[1]) * 1024 * 1024 : undefined;
}

interface FoundIdf {
  readonly path: string;
  readonly version: Version;
  /** Set for installs made by Espressif's installer, which use their own layout. */
  readonly eim?: EimInstall | undefined;
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

  /**
   * IDF_PATH, installs recorded by Espressif's installer (EIM, also used by the
   * VS Code extension) in `~/.espressif/tools/eim_idf.json`, `~/esp/*` (manual
   * installs), and `~/.espressif/<version>/esp-idf`.
   */
  const findIdfInstallations = Effect.fn("HardwareService.findIdfInstallations")(function* (
    home: string,
    env: NodeJS.ProcessEnv,
  ) {
    const candidates = new Set<string>();
    const idfPath = env.IDF_PATH?.trim();
    if (idfPath) candidates.add(path.resolve(idfPath));
    const eimRecord = yield* fs
      .readFileString(path.join(home, ".espressif", "tools", "eim_idf.json"))
      .pipe(Effect.orElseSucceed(() => ""));
    const eimInstalls = new Map<string, EimInstall>();
    for (const install of parseEimInstalls(eimRecord)) {
      eimInstalls.set(path.resolve(install.path), install);
      candidates.add(path.resolve(install.path));
    }
    const espDir = path.join(home, "esp");
    for (const name of yield* readDirectory(espDir)) candidates.add(path.join(espDir, name));
    const espressifDir = path.join(home, ".espressif");
    for (const name of yield* readDirectory(espressifDir)) {
      candidates.add(path.join(espressifDir, name, "esp-idf"));
    }
    const found: Array<FoundIdf> = [];
    for (const candidate of candidates) {
      const idf = yield* readIdf(candidate);
      if (Option.isSome(idf)) found.push({ ...idf.value, eim: eimInstalls.get(candidate) });
    }
    return found;
  });

  const checkIdf = (selected: FoundIdf | undefined, found: number): HardwareDoctorCheck => {
    if (!selected) {
      return {
        id: "esp-idf",
        status: "missing",
        detail: `ESP-IDF not found. Install it with one click in Kitty's Hardware panel, or by hand: v${pinnedIdf} (https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/get-started/).`,
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
    const eimPython = idf.eim?.python;
    if (eimPython && (yield* exists(eimPython))) {
      return {
        python: {
          id: "python-env",
          status: "ok",
          path: path.dirname(path.dirname(eimPython)),
          detail: "ESP-IDF Python environment is installed.",
        } satisfies HardwareDoctorCheck,
        bin: path.dirname(eimPython),
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
    for (const command of kicadCliCandidates(env)) {
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
    onOutput?: (text: string) => void,
  ) =>
    processRunner
      .run({
        command: "/bin/bash",
        // stderr joins stdout so live output keeps compiler errors in order.
        // EIM installs come with their own activation script; others use export.sh.
        args: [
          "-c",
          '. "$KITTY_IDF_ACTIVATE" >/dev/null 2>&1 && exec idf.py "$@" 2>&1',
          // $0 must look like a shell: EIM's script refuses to run when it thinks it was executed.
          "bash",
          ...args,
        ],
        cwd,
        env: {
          ...env,
          IDF_PATH: idf.path,
          KITTY_IDF_ACTIVATE: idf.eim?.activationScript ?? path.join(idf.path, "export.sh"),
        },
        timeout,
        ...(onOutput ? { onStdoutChunk: utf8Chunks(onOutput) } : {}),
        outputMode: "truncate",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(
        Effect.mapError((cause) =>
          failure("command_failed", `idf.py ${args.join(" ")} could not run: ${cause.message}`),
        ),
      );

  const leases = makeSerialLeases();
  const approvals = yield* makeHardwareApprovals();
  /** Last USB serial number seen on each device, to follow a board that re-enumerates. */
  const serialNumbers = new Map<string, string>();

  const python = (bin: string) => path.join(bin, "python");

  const listPorts = Effect.fn("HardwareService.listPorts")(function* () {
    const { bin } = yield* requireIdf();
    const result = yield* processRunner
      .run({ command: python(bin), args: ["-c", LIST_PORTS_SCRIPT], timeout: "20 seconds" })
      .pipe(Effect.mapError((cause) => failure("command_failed", cause.message)));
    const holders = leases.holders();
    return parsePortList(result.stdout).map((port) => {
      if (port.serialNumber) serialNumbers.set(port.device, port.serialNumber);
      const heldBy = holders.get(port.device);
      return heldBy ? { ...port, heldBy } : port;
    });
  });

  /**
   * The board to talk to: the requested port, the same board under a new name
   * after it re-enumerated, or the only board connected.
   */
  const resolvePort = Effect.fn("HardwareService.resolvePort")(function* (requested?: string) {
    const ports = yield* listPorts();
    const wanted = requested?.trim();
    if (wanted) {
      if (ports.some((port) => port.device === wanted)) return wanted;
      const serial = serialNumbers.get(wanted);
      const moved = serial ? ports.find((port) => port.serialNumber === serial) : undefined;
      if (moved) return moved.device;
      // Ports pyserial does not enumerate (some adapters, virtual ports) still open by path.
      if (wanted.startsWith("/dev/") && (yield* exists(wanted))) return wanted;
      return yield* failure("no_board", `${wanted} is not connected. Run hw_ports.`);
    }
    const boards = ports.filter((port) => port.kind !== "other");
    const candidates = boards.length > 0 ? boards : ports;
    if (candidates.length === 0) {
      return yield* failure("no_board", "No board is connected. Run hw_doctor.");
    }
    if (candidates.length > 1) {
      return yield* failure(
        "board_ambiguous",
        `Several boards are connected (${candidates.map((port) => port.device).join(", ")}). Pass port.`,
      );
    }
    return candidates[0]?.device ?? "";
  });

  const readChip = Effect.fn("HardwareService.readChip")(function* (bin: string, port: string) {
    const result = yield* processRunner
      .run({
        command: python(bin),
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

  const chipInfo = Effect.fn("HardwareService.chipInfo")(function* (input: HardwareChipInfoInput) {
    const { bin } = yield* requireIdf();
    const port = yield* resolvePort(input.port);
    return yield* Effect.scoped(
      Effect.gen(function* () {
        yield* leases.acquire(port, "agent", "a chip info read");
        return yield* readChip(bin, port);
      }),
    );
  });

  /** Runs MONITOR_SCRIPT: `seconds` 0 streams until interrupted. */
  const runMonitor = (
    bin: string,
    port: string,
    options: { readonly baud: number; readonly reset: boolean; readonly seconds: number },
    onText: (text: string) => void,
  ) =>
    processRunner
      .run({
        command: python(bin),
        args: [
          "-c",
          MONITOR_SCRIPT,
          port,
          String(options.baud),
          options.reset ? "1" : "0",
          String(options.seconds),
        ],
        timeout: options.seconds > 0 ? `${Math.ceil(options.seconds) + 15} seconds` : "12 hours",
        onStdoutChunk: utf8Chunks(onText),
        maxOutputBytes: 1024 * 1024,
        outputMode: "truncate",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.mapError((cause) => failure("command_failed", cause.message)));

  const monitorFailure = (port: string, result: { stderr: string; code: unknown }) =>
    result.code !== 0
      ? failure(
          "command_failed",
          `Could not open ${port}. ${logTail(result.stderr.replace(/kitty-monitor-\S+\n?/g, ""), 4)}`,
        )
      : undefined;

  const monitorRead = Effect.fn("HardwareService.monitorRead")(function* (
    input: HardwareMonitorReadInput,
  ) {
    const { bin } = yield* requireIdf();
    const port = yield* resolvePort(input.port);
    const seconds = Math.min(60, Math.max(1, input.seconds ?? 5));
    const until = input.until;
    const pattern = until
      ? yield* Effect.try({
          try: () => new RegExp(until),
          catch: () => failure("invalid_argument", `until is not a regular expression: ${until}`),
        })
      : undefined;
    const started = yield* Clock.currentTimeMillis;
    let text = "";
    let matched = false;
    const done = yield* Deferred.make<void>();
    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        yield* leases.acquire(port, "agent", "an agent reading the serial log");
        return yield* runMonitor(
          bin,
          port,
          { baud: input.baud ?? 115_200, reset: input.reset ?? true, seconds },
          (chunk) => {
            text += chunk;
            if (pattern && !matched && pattern.test(text)) {
              matched = true;
              Deferred.doneUnsafe(done, Exit.void);
            }
          },
        ).pipe(Effect.raceFirst(Deferred.await(done).pipe(Effect.as(undefined))));
      }),
    );
    if (result) {
      const error = monitorFailure(port, result);
      if (error) return yield* error;
    }
    const tail = monitorTail(text);
    return {
      port,
      text: tail.text,
      bytes: new TextEncoder().encode(text).length,
      truncated: tail.truncated,
      ...(pattern ? { matched } : {}),
      durationMs: (yield* Clock.currentTimeMillis) - started,
    } satisfies HardwareMonitorReadResult;
  });

  /**
   * The panel's live monitor: runs until interrupted, and closes by itself
   * (with a `preempted` status) when a flash or an agent read needs the port.
   */
  const monitor = Effect.fn("HardwareService.monitor")(function* (
    input: HardwareMonitorInput,
    onEvent: (event: HardwareMonitorEvent) => void,
  ) {
    const { bin } = yield* requireIdf();
    const port = yield* resolvePort(input.port);
    const stop = yield* Deferred.make<void>();
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* leases.acquire(port, "monitor", "the Hardware panel monitor", (by) =>
          Effect.sync(() => onEvent({ type: "status", status: "preempted", detail: by })).pipe(
            Effect.andThen(Deferred.succeed(stop, undefined)),
            Effect.asVoid,
          ),
        );
        onEvent({ type: "status", status: "open", detail: port });
        const result = yield* runMonitor(
          bin,
          port,
          { baud: input.baud ?? 115_200, reset: input.reset ?? false, seconds: 0 },
          (text) => onEvent({ type: "output", text }),
        ).pipe(Effect.raceFirst(Deferred.await(stop).pipe(Effect.as(undefined))));
        if (result) {
          const error = monitorFailure(port, result);
          if (error) return yield* error;
        }
      }),
    );
    onEvent({ type: "status", status: "closed" });
  });

  const reset = Effect.fn("HardwareService.reset")(function* (input: HardwareResetInput) {
    const { bin } = yield* requireIdf();
    const port = yield* resolvePort(input.port);
    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        yield* leases.acquire(port, "reset", "a reset");
        return yield* runMonitor(bin, port, { baud: 115_200, reset: true, seconds: 0.2 }, () => {});
      }),
    );
    const error = monitorFailure(port, result);
    if (error) return yield* error;
    if (result.stderr.includes("kitty-monitor-reset-unsupported")) {
      return yield* failure("command_failed", `${port} cannot reset the board (no RTS line).`);
    }
    return { port } satisfies HardwareResetResult;
  });

  /** A full-flash image of the board, unless `auto` finds an earlier one. */
  const backupFlash = Effect.fn("HardwareService.backupFlash")(function* (
    bin: string,
    port: string,
    mode: HardwareFlashBackupMode,
    onOutput: (text: string) => void,
  ) {
    const home = yield* HostProcess.HomeDirectory;
    const chip = yield* readChip(bin, port);
    const bytes = flashSizeBytes(chip.flashSize);
    if (!bytes) {
      return yield* failure(
        "command_failed",
        `esptool did not report ${port}'s flash size, so Kitty cannot back it up. Pass backup: "skip" to flash anyway.`,
      );
    }
    const board = (chip.mac ?? "unknown").replaceAll(":", "");
    const directory = path.join(home, KITTY_HOME_DIRNAME, "hardware-backups", board);
    const existing = (yield* readDirectory(directory))
      .filter((name) => name.endsWith(".bin"))
      .toSorted();
    if (mode === "auto" && existing.length > 0) {
      const file = path.join(directory, existing.at(-1) ?? "");
      onOutput(`Kitty already has a backup of this board: ${file}\n`);
      return { file, created: false } satisfies HardwareFlashBackup;
    }
    yield* fs
      .makeDirectory(directory, { recursive: true })
      .pipe(Effect.mapError((cause) => failure("command_failed", cause.message)));
    const stamp = DateTime.formatIso(yield* DateTime.now).replace(/[:.]/g, "-");
    const file = path.join(directory, `${stamp}-${chip.flashSize}.bin`);
    onOutput(`Backing up the whole ${chip.flashSize} flash to ${file}…\n`);
    const result = yield* processRunner
      .run({
        command: python(bin),
        args: [
          "-m",
          "esptool",
          "--port",
          port,
          "--baud",
          "921600",
          "read_flash",
          "0",
          `0x${bytes.toString(16)}`,
          file,
        ],
        timeout: "10 minutes",
        onStdoutChunk: utf8Chunks(onOutput),
        outputMode: "truncate",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.mapError((cause) => failure("command_failed", cause.message)));
    if (result.code !== 0 || result.timedOut) {
      yield* fs.remove(file).pipe(Effect.ignore);
      return yield* commandFailed("esptool read_flash (backup)", result);
    }
    return { file, created: true } satisfies HardwareFlashBackup;
  });

  const flash = Effect.fn("HardwareService.flash")(function* (
    input: HardwareFlashInput & { readonly directory: string },
    options: {
      readonly onOutput?: ((text: string) => void) | undefined;
      /** Set for agent calls: the user must allow the flash in the Hardware panel. */
      readonly approvalFor?: { readonly threadId?: ThreadId | undefined } | undefined;
    } = {},
  ) {
    const { idf, env, bin } = yield* requireIdf();
    yield* requireProject(input);
    const port = yield* resolvePort(input.port);
    const onOutput = options.onOutput ?? (() => {});
    if (options.approvalFor) {
      const allowed = yield* approvals.request(
        {
          kind: "flash",
          ...(options.approvalFor.threadId ? { threadId: options.approvalFor.threadId } : {}),
          project: input.path,
          port,
        },
        "5 minutes",
      );
      if (!allowed) {
        return yield* failure(
          "denied",
          "The user did not allow this flash (denied, or no answer within 5 minutes in Kitty's Hardware panel). Ask them before trying again.",
        );
      }
    }
    return yield* Effect.scoped(
      Effect.gen(function* () {
        yield* leases.acquire(port, "flash", `a flash of ${input.path}`);
        const started = yield* Clock.currentTimeMillis;
        const mode = input.backup ?? "auto";
        const backup = mode === "skip" ? undefined : yield* backupFlash(bin, port, mode, onOutput);
        const result = yield* runIdf(
          idf,
          env,
          input.directory,
          ["-p", port, "-b", "460800", "flash"],
          "20 minutes",
          onOutput,
        );
        const output = `${result.stdout}\n${result.stderr}`;
        // The board may come back under another name; remember it by serial number.
        yield* listPorts().pipe(Effect.ignore);
        return {
          ok: result.code === 0 && !result.timedOut,
          port,
          durationMs: (yield* Clock.currentTimeMillis) - started,
          ...(backup ? { backup } : {}),
          diagnostics: parseBuildDiagnostics(output, input.directory),
          logTail: result.timedOut ? "Flash timed out after 20 minutes." : logTail(output),
        } satisfies HardwareFlashResult;
      }),
    );
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
    for (const extra of ["pytest_hello_world.py", "pytest_blink.py", "sdkconfig.ci"]) {
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

  const requireProject = Effect.fn("HardwareService.requireProject")(function* (input: {
    readonly path: string;
    readonly directory: string;
  }) {
    if (!(yield* exists(path.join(input.directory, "CMakeLists.txt")))) {
      return yield* failure(
        "invalid_path",
        `${input.path} is not an ESP-IDF project (no CMakeLists.txt).`,
      );
    }
  });

  const commandFailed = (
    command: string,
    result: { readonly stdout: string; readonly stderr: string; readonly timedOut: boolean },
  ) =>
    failure(
      "command_failed",
      result.timedOut
        ? `${command} timed out.`
        : `${command} failed.\n${logTail(`${result.stdout}\n${result.stderr}`, 20)}`,
    );

  const readText = (file: string) => fs.readFileString(file).pipe(Effect.option);
  const writeText = (file: string, text: string) =>
    fs
      .writeFileString(file, text)
      .pipe(
        Effect.mapError((cause) =>
          failure("command_failed", `Could not write ${path.basename(file)}: ${cause.message}`),
        ),
      );

  /** Re-runs Kconfig over sdkconfig.defaults + sdkconfig, creating sdkconfig if needed. */
  const reconfigure = Effect.fn("HardwareService.reconfigure")(function* (
    idf: FoundIdf,
    env: NodeJS.ProcessEnv,
    directory: string,
  ) {
    const result = yield* runIdf(idf, env, directory, ["reconfigure"], "5 minutes");
    if (result.code !== 0 || result.timedOut) {
      return yield* commandFailed("idf.py reconfigure", result);
    }
  });

  const setTarget = Effect.fn("HardwareService.setTarget")(function* (
    input: HardwareSetTargetInput & { readonly directory: string },
  ) {
    const { idf, env } = yield* requireIdf();
    yield* requireProject(input);
    const result = yield* runIdf(
      idf,
      env,
      input.directory,
      ["set-target", input.target],
      "5 minutes",
    );
    if (result.code !== 0 || result.timedOut) {
      return yield* commandFailed(`idf.py set-target ${input.target}`, result);
    }
    return { path: input.path, target: input.target } satisfies HardwareSetTargetResult;
  });

  const MAX_SDKCONFIG_ENTRIES = 100;

  const loadSdkconfig = Effect.fn("HardwareService.loadSdkconfig")(function* (input: {
    readonly path: string;
    readonly directory: string;
  }) {
    const { idf, env } = yield* requireIdf();
    yield* requireProject(input);
    const file = path.join(input.directory, "sdkconfig");
    let text = yield* readText(file);
    if (Option.isNone(text)) {
      yield* reconfigure(idf, env, input.directory);
      text = yield* readText(file);
    }
    if (Option.isNone(text)) {
      return yield* failure("command_failed", "idf.py reconfigure did not write sdkconfig.");
    }
    return { idf, env, file, text: text.value };
  });

  const sdkconfigGet = Effect.fn("HardwareService.sdkconfigGet")(function* (
    input: HardwareSdkconfigGetInput & { readonly directory: string },
  ) {
    if (!input.keys?.length && !input.search?.trim()) {
      return yield* failure("invalid_argument", "Pass keys or search.");
    }
    const { text } = yield* loadSdkconfig(input);
    const entries = parseSdkconfig(text);
    const wanted = new Set<string>();
    const missing: Array<string> = [];
    for (const key of input.keys ?? []) {
      const normalized = normalizeSdkconfigKey(key);
      if (entries.has(normalized)) wanted.add(normalized);
      else missing.push(normalized);
    }
    if (input.search?.trim()) {
      for (const key of searchSdkconfig(entries, input.search)) wanted.add(key);
    }
    const keys = [...wanted];
    const target = parseSdkconfigTarget(text);
    return {
      ...(target ? { target } : {}),
      entries: keys.slice(0, MAX_SDKCONFIG_ENTRIES).map((key): HardwareSdkconfigEntry => ({
        key,
        value: entryValue(entries.get(key) ?? { raw: null }),
      })),
      missing,
      truncated: keys.length > MAX_SDKCONFIG_ENTRIES,
    } satisfies HardwareSdkconfigGetResult;
  });

  const sdkconfigSet = Effect.fn("HardwareService.sdkconfigSet")(function* (
    input: HardwareSdkconfigSetInput & { readonly directory: string },
  ) {
    const requested = Object.entries(input.values).map(
      ([key, value]) => [normalizeSdkconfigKey(key), value] as const,
    );
    if (requested.length === 0) return yield* failure("invalid_argument", "Pass values to set.");
    const invalid = requested.filter(([key]) => !isSdkconfigKey(key)).map(([key]) => key);
    if (invalid.length > 0) {
      return yield* failure("invalid_argument", `Not option names: ${invalid.join(", ")}.`);
    }
    const { idf, env, file, text: before } = yield* loadSdkconfig(input);
    const beforeEntries = parseSdkconfig(before);
    const choices = parseKconfigChoices(
      Option.getOrElse(
        yield* readText(path.join(input.directory, "build", "config", "kconfig_menus.json")),
        () => "",
      ),
    );
    const updates = new Map<string, string | null>();
    /** Choice entries cleared on behalf of a requested entry of the same choice. */
    const clearedFor = new Map<string, string>();
    for (const [key, value] of requested) {
      const raw = encodeSdkconfigValue(value, beforeEntries.get(key)?.raw);
      updates.set(key, raw);
      // Kconfig keeps the last `=y` of a choice, so clear the other entries.
      if (raw === "y") {
        for (const sibling of choices.get(key) ?? []) {
          if (requested.some(([other]) => other === sibling)) continue;
          updates.set(sibling, null);
          clearedFor.set(sibling, key);
        }
      }
    }
    const configure = Effect.fn("HardwareService.sdkconfigSet.configure")(function* (
      next: ReadonlyMap<string, string | null>,
    ) {
      yield* writeText(file, applySdkconfigUpdates(before, next));
      // A failed reconfigure leaves the project as it was.
      yield* reconfigure(idf, env, input.directory).pipe(
        Effect.tapError(() => writeText(file, before).pipe(Effect.ignore)),
      );
      return parseSdkconfig(Option.getOrElse(yield* readText(file), () => ""));
    });
    let after = yield* configure(updates);

    const applied: Array<HardwareSdkconfigEntry> = [];
    const rejected: Array<HardwareSdkconfigSetResult["rejected"][number]> = [];
    for (const [key, value] of requested) {
      const actual = after.get(key);
      const wantedRaw = updates.get(key) ?? null;
      if (actual === undefined) {
        if (wantedRaw === null) {
          applied.push({ key, value: false });
        } else {
          rejected.push({
            key,
            requested: value,
            reason:
              "Not an option in this project: unknown name, or an option it depends on is off.",
          });
        }
      } else if (actual.raw === wantedRaw) {
        applied.push({ key, value: entryValue(actual) });
      } else {
        rejected.push({
          key,
          requested: value,
          actual: entryValue(actual),
          reason: "Kconfig kept another value: out of range, or another option decides it.",
        });
      }
    }

    if (rejected.length > 0) {
      // Kconfig resets a rejected value to its default rather than the
      // previous one, so configure again with only the accepted values.
      const rejectedKeys = new Set(rejected.map((entry) => entry.key));
      const accepted = new Map(
        [...updates].filter(([key]) => {
          const requester = clearedFor.get(key);
          return !rejectedKeys.has(key) && !(requester && rejectedKeys.has(requester));
        }),
      );
      after = yield* configure(accepted);
    }

    const persist = input.persist ?? true;
    if (persist && applied.length > 0) {
      // Record the accepted values, and follow any option already in the
      // defaults that Kconfig changed as a result (e.g. the other choices of a
      // choice group), so the defaults never contradict the new configuration.
      const defaultsFile = path.join(input.directory, "sdkconfig.defaults");
      const defaults = Option.getOrElse(yield* readText(defaultsFile), () => "");
      const defaultsUpdates = new Map<string, string | null>();
      for (const { key } of applied) defaultsUpdates.set(key, after.get(key)?.raw ?? null);
      for (const [key, entry] of parseSdkconfig(defaults)) {
        if (defaultsUpdates.has(key)) continue;
        const now = after.get(key);
        if (now && now.raw !== entry.raw && beforeEntries.get(key)?.raw !== now.raw) {
          defaultsUpdates.set(key, now.raw);
        }
      }
      yield* writeText(defaultsFile, applySdkconfigUpdates(defaults, defaultsUpdates));
    }
    return {
      applied,
      rejected,
      persisted: persist && applied.length > 0,
    } satisfies HardwareSdkconfigSetResult;
  });

  let installing = false;

  /** EIM for this machine under ~/.kitty/tools, downloaded on first use. */
  const ensureEim = Effect.fn("HardwareService.ensureEim")(function* (
    onOutput: (text: string) => void,
  ) {
    const home = yield* HostProcess.HomeDirectory;
    const platform = yield* HostProcess.Platform;
    const arch = yield* HostProcess.Architecture;
    const asset = eimAsset(platform, arch);
    if (!asset) {
      return yield* failure(
        "toolchain_missing",
        `Espressif's installer has no build for ${platform}/${arch}. Install ESP-IDF ${KITTY_IDF_RELEASE} by hand.`,
      );
    }
    const directory = path.join(home, KITTY_HOME_DIRNAME, "tools", `eim-${EIM_VERSION}`);
    const eim = path.join(directory, platform === "win32" ? "eim.exe" : "eim");
    if (yield* exists(eim)) return { eim, directory };
    yield* fs
      .makeDirectory(directory, { recursive: true })
      .pipe(Effect.mapError((cause) => failure("command_failed", cause.message)));
    const download = path.join(directory, asset.name);
    onOutput(`Downloading Espressif's installer (EIM ${EIM_VERSION})…\n`);
    const fetched = yield* processRunner
      .run({
        command: "curl",
        args: [
          "-fL",
          "--retry",
          "3",
          "--silent",
          "--show-error",
          "-o",
          download,
          eimDownloadUrl(asset.name),
        ],
        timeout: "10 minutes",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.mapError((cause) => failure("command_failed", cause.message)));
    if (fetched.code !== 0 || fetched.timedOut) {
      return yield* commandFailed("Downloading EIM", fetched);
    }
    if (asset.archive === "zip") {
      const unzipped = yield* processRunner
        .run({
          command: "unzip",
          args: ["-o", "-q", download, "-d", directory],
          timeout: "2 minutes",
        })
        .pipe(Effect.mapError((cause) => failure("command_failed", cause.message)));
      if (unzipped.code !== 0) return yield* commandFailed("Unpacking EIM", unzipped);
      yield* fs.remove(download).pipe(Effect.ignore);
    } else {
      yield* fs
        .rename(download, eim)
        .pipe(Effect.mapError((cause) => failure("command_failed", cause.message)));
    }
    if (platform !== "win32") {
      yield* fs.chmod(eim, 0o755).pipe(Effect.ignore);
    }
    if (!(yield* exists(eim))) {
      return yield* failure(
        "command_failed",
        `The EIM download did not contain ${path.basename(eim)}.`,
      );
    }
    return { eim, directory };
  });

  const installToolchain = Effect.fn("HardwareService.installToolchain")(function* (
    input: HardwareToolchainInstallInput & {
      readonly basePath?: string | undefined;
      readonly registryDir?: string | undefined;
    },
    onOutput: (text: string) => void,
  ) {
    if (installing) {
      return yield* failure("port_busy", "An ESP-IDF install is already running.");
    }
    installing = true;
    return yield* Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      const { eim, directory } = yield* ensureEim(onOutput);
      const platform = yield* HostProcess.Platform;
      const args = eimInstallArgs({
        mirror: input.mirror ?? "global",
        basePath: input.basePath,
        registryDir: input.registryDir,
      });
      onOutput(`Installing ESP-IDF ${KITTY_IDF_RELEASE} for ESP32-S3 (about 2 GB)…\n`);
      const result = yield* processRunner
        .run({
          // EIM logs progress to stderr; merge it so the panel shows it live.
          ...(platform === "win32"
            ? { command: eim, args }
            : { command: "/bin/bash", args: ["-c", 'exec "$@" 2>&1', "eim", eim, ...args] }),
          cwd: directory,
          timeout: "90 minutes",
          onStdoutChunk: utf8Chunks(onOutput),
          outputMode: "truncate",
          timeoutBehavior: "timedOutResult",
        })
        .pipe(Effect.mapError((cause) => failure("command_failed", cause.message)));
      const output = `${result.stdout}\n${result.stderr}`;
      return {
        ok: result.code === 0 && !result.timedOut,
        idfVersion: KITTY_IDF_RELEASE,
        durationMs: (yield* Clock.currentTimeMillis) - started,
        logTail: result.timedOut ? "The install timed out after 90 minutes." : logTail(output, 30),
      } satisfies HardwareToolchainInstallResult;
    }).pipe(Effect.ensuring(Effect.sync(() => (installing = false))));
  });

  const initRepository = Effect.fn("HardwareService.initRepository")(function* (
    root: string,
    message: string,
  ) {
    const git = (args: ReadonlyArray<string>) =>
      processRunner.run({ command: "git", args, cwd: root, timeout: "1 minute" }).pipe(
        Effect.map((result) => result.code === 0),
        Effect.orElseSucceed(() => false),
      );
    if (!(yield* git(["init", "-b", "main"]))) return false;
    if (!(yield* git(["add", "-A"]))) return false;
    return yield* git(["commit", "-m", message]);
  });

  const build = Effect.fn("HardwareService.build")(function* (
    input: HardwareBuildInput & { readonly directory: string },
    onOutput?: (text: string) => void,
  ) {
    const { idf, env } = yield* requireIdf();
    yield* requireProject(input);
    const started = yield* Clock.currentTimeMillis;
    const result = yield* runIdf(idf, env, input.directory, ["build"], "20 minutes", onOutput);
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

  return HardwareService.of({
    doctor,
    chipInfo,
    ports: Effect.map(listPorts(), (ports) => ({ ports })),
    monitorRead,
    monitor,
    reset,
    flash,
    installToolchain,
    initRepository,
    approvals: approvals.pending,
    respondApproval: approvals.respond,
    createProject,
    build,
    setTarget,
    sdkconfigGet,
    sdkconfigSet,
    listProjects,
  });
});

export const layer = Layer.effect(HardwareService, make());
