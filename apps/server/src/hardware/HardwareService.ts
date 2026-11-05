import type {
  HardwareDoctorCheck,
  HardwareDoctorInput,
  HardwareDoctorReport,
  HardwareIdfInstallation,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import {
  classifyIdfVersion,
  classifyKicadVersion,
  compareVersions,
  formatVersion,
  matchesIdfPythonEnv,
  parseIdfVersionCmake,
  parseKicadCliVersion,
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

  const doctor = Effect.fn("HardwareService.doctor")(function* (input: HardwareDoctorInput) {
    const home = yield* HostProcess.HomeDirectory;
    const env = yield* HostProcess.Environment;
    const platform = yield* HostProcess.Platform;

    const found = (yield* findIdfInstallations(home, env)).toSorted((a, b) =>
      compareVersions(b.version, a.version),
    );
    const requested = input.idfPath?.trim();
    const fromEnv = env.IDF_PATH?.trim();
    const selected = requested
      ? Option.getOrUndefined(yield* readIdf(path.resolve(requested)))
      : ((fromEnv ? found.find((idf) => idf.path === path.resolve(fromEnv)) : undefined) ??
        found.find((idf) => classifyIdfVersion(idf.version) === "ok") ??
        found[0]);

    const { python, bin } = yield* checkPythonEnv(home, selected);
    const serialPorts = selectSerialPorts(yield* readDirectory("/dev"), platform);
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

  return HardwareService.of({ doctor });
});

export const layer = Layer.effect(HardwareService, make());
