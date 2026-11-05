import type { HardwareBuildDiagnostic } from "@t3tools/contracts";

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const MAX_DIAGNOSTICS = 50;

const COMPILER = /^(.+?):(\d+):(\d+): (fatal error|error|warning): (.+)$/;
const UNDEFINED_REFERENCE = /undefined reference to [`'‘](.+?)['’]/;
const LINKER_SOURCE = /^(.+?\.(?:c|cc|cpp|cxx|S|s)):(\d+):\(/;
const CMAKE_ERROR = /CMake Error at\s+(\S+?):(\d+)(?: \([^)]*\))?:/g;
const APP_SIZE =
  /binary size (0x[0-9a-f]+) bytes\. Smallest app partition is (0x[0-9a-f]+) bytes\. 0x[0-9a-f]+ bytes \((\d+)%\) free/i;

/** Paths inside the project come back relative to it, so agents can open them directly. */
function displayPath(file: string, projectDir: string): string {
  const root = projectDir.endsWith("/") ? projectDir : `${projectDir}/`;
  return file.startsWith(root) ? file.slice(root.length) : file;
}

function cmakeMessage(rest: string): string {
  const lines: Array<string> = [];
  for (const raw of rest.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) {
      if (lines.length > 0) break;
      continue;
    }
    if (line.startsWith("Call Stack")) break;
    lines.push(line);
  }
  return lines.join(" ");
}

/**
 * Turns `idf.py build` output into the diagnostics an agent needs to fix the
 * build: GCC errors and warnings, unresolved symbols from the linker, and
 * CMake errors. ESP-IDF nests CMake errors from its own scripts around the one
 * in the project's file, so only the project's are kept when there are any.
 */
export function parseBuildDiagnostics(
  output: string,
  projectDir: string,
): ReadonlyArray<HardwareBuildDiagnostic> {
  const text = output.replace(ANSI, "").replaceAll("\r\n", "\n");
  const diagnostics: Array<HardwareBuildDiagnostic> = [];
  const seen = new Set<string>();
  const add = (diagnostic: HardwareBuildDiagnostic, key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    diagnostics.push(diagnostic);
  };

  const undefinedSymbols = new Map<string, HardwareBuildDiagnostic>();
  for (const line of text.split("\n")) {
    const compiler = COMPILER.exec(line);
    if (compiler) {
      const [, file = "", lineNo, column, kind, message = ""] = compiler;
      const diagnostic: HardwareBuildDiagnostic = {
        severity: kind === "warning" ? "warning" : "error",
        source: "compiler",
        file: displayPath(file, projectDir),
        line: Number(lineNo),
        column: Number(column),
        message: message.trim(),
      };
      add(diagnostic, `c:${diagnostic.file}:${lineNo}:${column}:${diagnostic.message}`);
      continue;
    }
    const undefinedRef = UNDEFINED_REFERENCE.exec(line);
    if (undefinedRef) {
      const symbol = undefinedRef[1] ?? "";
      const source = LINKER_SOURCE.exec(line);
      const previous = undefinedSymbols.get(symbol);
      if (previous?.file !== undefined) continue;
      undefinedSymbols.set(symbol, {
        severity: "error",
        source: "linker",
        ...(source
          ? { file: displayPath(source[1] ?? "", projectDir), line: Number(source[2]) }
          : {}),
        message: `undefined reference to '${symbol}'`,
      });
    }
  }
  for (const [symbol, diagnostic] of undefinedSymbols) add(diagnostic, `l:${symbol}`);

  const cmake: Array<HardwareBuildDiagnostic> = [];
  for (const match of text.matchAll(CMAKE_ERROR)) {
    const file = match[1] ?? "";
    cmake.push({
      severity: "error",
      source: "cmake",
      file: displayPath(file, projectDir),
      line: Number(match[2]),
      message: cmakeMessage(text.slice((match.index ?? 0) + match[0].length)),
    });
  }
  const inProject = cmake.filter((diagnostic) => !diagnostic.file?.startsWith("/"));
  for (const diagnostic of inProject.length > 0 ? inProject : cmake) {
    add(diagnostic, `m:${diagnostic.file}:${diagnostic.line}`);
  }

  return diagnostics
    .toSorted((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1))
    .slice(0, MAX_DIAGNOSTICS);
}

export function parseAppBinarySize(
  output: string,
): { sizeBytes: number; partitionBytes: number; freePercent: number } | undefined {
  const match = APP_SIZE.exec(output);
  if (!match) return undefined;
  return {
    sizeBytes: Number.parseInt(match[1] ?? "", 16),
    partitionBytes: Number.parseInt(match[2] ?? "", 16),
    freePercent: Number(match[3]),
  };
}

/** The last lines of a build log, for when the diagnostics do not explain a failure. */
export function logTail(output: string, lines = 40): string {
  return output.replace(ANSI, "").trimEnd().split("\n").slice(-lines).join("\n");
}
