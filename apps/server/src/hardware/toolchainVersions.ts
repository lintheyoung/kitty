import type { HardwareCheckStatus } from "@t3tools/contracts";

/** Kitty pins one ESP-IDF minor and one KiCad major (PRD Q-04). */
export const SUPPORTED_IDF = { major: 5, minor: 5 } as const;
export const SUPPORTED_KICAD_MAJOR = 10;

export interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export const formatVersion = (version: Version): string =>
  `${version.major}.${version.minor}.${version.patch}`;

export const compareVersions = (a: Version, b: Version): number =>
  a.major - b.major || a.minor - b.minor || a.patch - b.patch;

/** Reads `tools/cmake/version.cmake`, the version source of truth in an ESP-IDF checkout. */
export function parseIdfVersionCmake(text: string): Version | undefined {
  const part = (name: string) => {
    const match = new RegExp(`set\\(\\s*IDF_VERSION_${name}\\s+(\\d+)\\s*\\)`).exec(text);
    return match ? Number(match[1]) : undefined;
  };
  const major = part("MAJOR");
  const minor = part("MINOR");
  const patch = part("PATCH");
  if (major === undefined || minor === undefined || patch === undefined) return undefined;
  return { major, minor, patch };
}

/** `kicad-cli version` prints e.g. `10.0.7`, sometimes with a build suffix. */
export function parseKicadCliVersion(output: string): Version | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function classifyIdfVersion(version: Version): HardwareCheckStatus {
  if (version.major === SUPPORTED_IDF.major && version.minor === SUPPORTED_IDF.minor) return "ok";
  return "warning";
}

export function classifyKicadVersion(version: Version): HardwareCheckStatus {
  return version.major === SUPPORTED_KICAD_MAJOR ? "ok" : "warning";
}

/** ESP-IDF names its venvs `idf<major>.<minor>_py<python>_env`. */
export function matchesIdfPythonEnv(directoryName: string, version: Version): boolean {
  return new RegExp(`^idf${version.major}\\.${version.minor}_py[\\d.]+_env$`).test(directoryName);
}

const IGNORED_MAC_PORTS = new Set(["cu.Bluetooth-Incoming-Port", "cu.debug-console"]);

/** Device-node names under /dev that can be a USB serial port to a board. */
export function selectSerialPorts(
  entries: ReadonlyArray<string>,
  platform: NodeJS.Platform,
): ReadonlyArray<string> {
  const isPort =
    platform === "darwin"
      ? (name: string) => name.startsWith("cu.") && !IGNORED_MAC_PORTS.has(name)
      : (name: string) => /^tty(USB|ACM)\d+$/.test(name);
  return entries
    .filter(isPort)
    .toSorted()
    .map((name) => `/dev/${name}`);
}

/** The `project(<name>)` of an ESP-IDF top-level CMakeLists.txt, or undefined for other CMake files. */
export function parseIdfProjectName(cmakeLists: string): string | undefined {
  if (!/tools\/cmake\/project\.cmake/.test(cmakeLists)) return undefined;
  return /^\s*project\(\s*([A-Za-z0-9_.-]+)/m.exec(cmakeLists)?.[1];
}

/** `CONFIG_IDF_TARGET="esp32s3"` from a generated sdkconfig. */
export function parseSdkconfigTarget(sdkconfig: string): string | undefined {
  return /^CONFIG_IDF_TARGET="([^"]+)"/m.exec(sdkconfig)?.[1];
}

export interface EimInstall {
  readonly path: string;
  /** The install's own venv Python (EIM keeps it under tools/python/<version>/venv). */
  readonly python?: string;
  /** Script that sets up the install's environment, used instead of export.sh. */
  readonly activationScript?: string;
}

/** ESP-IDF installs listed in EIM's `eim_idf.json`; anything unreadable lists none. */
export function parseEimInstalls(json: string): ReadonlyArray<EimInstall> {
  let record: unknown;
  try {
    record = JSON.parse(json);
  } catch {
    return [];
  }
  if (typeof record !== "object" || record === null || !("idfInstalled" in record)) return [];
  const installed = record.idfInstalled;
  if (!Array.isArray(installed)) return [];
  const text = (entry: Record<string, unknown>, key: string) => {
    const value = entry[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  return installed.flatMap((raw: unknown) => {
    if (typeof raw !== "object" || raw === null) return [];
    const entry = raw as Record<string, unknown>;
    const path = text(entry, "path");
    if (!path) return [];
    const python = text(entry, "python");
    const activationScript = text(entry, "activationScript");
    return [
      { path, ...(python ? { python } : {}), ...(activationScript ? { activationScript } : {}) },
    ];
  });
}
