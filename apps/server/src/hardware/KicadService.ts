import {
  HardwareToolError,
  type KicadBomInput,
  type KicadBomResult,
  type KicadDrcInput,
  type KicadDrcResult,
  type KicadErcInput,
  type KicadErcResult,
  type KicadFabExportInput,
  type KicadFabExportResult,
  type KicadNetlistInput,
  type KicadNetlistResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import { logTail } from "./buildOutput.ts";
import {
  buildBom,
  componentPins,
  parseDrcReport,
  parseErcReport,
  parseNetlist,
} from "./kicadReports.ts";
import { parseKicadCliVersion } from "./toolchainVersions.ts";
import { resolveInWorkspace } from "./workspacePath.ts";

type InWorkspace<A> = A & { readonly workspaceRoot: string };

/**
 * KiCad 10 through `kicad-cli`: checks (ERC/DRC), the netlist and BOM an
 * agent needs to write firmware against the schematic, and fab outputs.
 */
export class KicadService extends Context.Service<
  KicadService,
  {
    readonly erc: (
      input: InWorkspace<KicadErcInput>,
    ) => Effect.Effect<KicadErcResult, HardwareToolError>;
    readonly drc: (
      input: InWorkspace<KicadDrcInput>,
    ) => Effect.Effect<KicadDrcResult, HardwareToolError>;
    readonly netlist: (
      input: InWorkspace<KicadNetlistInput>,
    ) => Effect.Effect<KicadNetlistResult, HardwareToolError>;
    readonly bom: (
      input: InWorkspace<KicadBomInput>,
    ) => Effect.Effect<KicadBomResult, HardwareToolError>;
    readonly fabExport: (
      input: InWorkspace<KicadFabExportInput>,
    ) => Effect.Effect<KicadFabExportResult, HardwareToolError>;
  }
>()("t3/hardware/KicadService") {}

const MAC_KICAD_CLI = "/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli";

/** Where to look for kicad-cli: KICAD_CLI, then the macOS app, then PATH. */
export function kicadCliCandidates(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const configured = env.KICAD_CLI?.trim();
  return configured ? [configured, MAC_KICAD_CLI] : [MAC_KICAD_CLI, "kicad-cli"];
}

/** KiCad's own stderr noise (fontconfig on Homebrew systems). */
const NOISE = /^Fontconfig (warning|error)/;
const cleanOutput = (text: string) =>
  text
    .split("\n")
    .filter((line) => !NOISE.test(line))
    .join("\n");

const COPPER_LAYER = /^\s*\(\d+\s+"([^"]+\.Cu)"\s+(?:signal|power|mixed|jumper)\b/gm;
const FAB_LAYERS = [
  "F.Paste",
  "B.Paste",
  "F.Silkscreen",
  "B.Silkscreen",
  "F.Mask",
  "B.Mask",
  "Edge.Cuts",
];

/** Copper layers declared in a board's `(layers …)` header. */
export function boardCopperLayers(board: string): ReadonlyArray<string> {
  const header = board.slice(0, 20_000);
  return [...header.matchAll(COPPER_LAYER)].map((match) => match[1] ?? "").filter(Boolean);
}

export const make = Effect.fn("KicadService.make")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;

  const failure = (code: HardwareToolError["code"], message: string) =>
    new HardwareToolError({ code, message });
  const confine = (workspaceRoot: string, requested: string) =>
    resolveInWorkspace(workspaceRoot, requested).pipe(Effect.provideService(Path.Path, path));

  const findCli = Effect.fn("KicadService.findCli")(function* () {
    const env = yield* HostProcess.Environment;
    for (const command of kicadCliCandidates(env)) {
      const result = yield* processRunner
        .run({ command, args: ["version"], timeout: "15 seconds" })
        .pipe(Effect.option);
      if (Option.isSome(result) && result.value.code === 0) {
        if (parseKicadCliVersion(result.value.stdout)) return command;
      }
    }
    return yield* failure(
      "toolchain_missing",
      "kicad-cli not found. Install KiCad 10 or set KICAD_CLI. Run hw_doctor for details.",
    );
  });

  const runCli = Effect.fn("KicadService.runCli")(function* (
    cli: string,
    args: ReadonlyArray<string>,
    cwd: string,
  ) {
    const result = yield* processRunner
      .run({
        command: cli,
        args,
        cwd,
        timeout: "10 minutes",
        outputMode: "truncate",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.mapError((cause) => failure("command_failed", cause.message)));
    if (result.code !== 0 || result.timedOut) {
      const output = cleanOutput(`${result.stdout}\n${result.stderr}`);
      return yield* failure(
        "command_failed",
        result.timedOut
          ? `kicad-cli ${args.slice(0, 2).join(" ")} timed out.`
          : `kicad-cli ${args.slice(0, 2).join(" ")} failed.\n${logTail(output, 15)}`,
      );
    }
    return result;
  });

  /**
   * The design file `requested` points to: the file itself, or the
   * `<project>.<extension>` of a project file or directory.
   */
  const resolveDesign = Effect.fn("KicadService.resolveDesign")(function* (
    workspaceRoot: string,
    requested: string,
    extension: ".kicad_sch" | ".kicad_pcb",
  ) {
    const target = yield* confine(workspaceRoot, requested);
    const info = yield* fs.stat(target).pipe(Effect.option);
    if (Option.isNone(info)) return yield* failure("invalid_path", `${requested} does not exist.`);
    let file: string | undefined;
    if (info.value.type === "Directory") {
      const entries = yield* fs
        .readDirectory(target)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      const project = entries.find((entry) => entry.endsWith(".kicad_pro"));
      const stem = project ? project.slice(0, -".kicad_pro".length) : undefined;
      const matches = entries.filter((entry) => entry.endsWith(extension)).toSorted();
      const chosen =
        (stem && matches.find((entry) => entry === `${stem}${extension}`)) ?? matches[0];
      if (chosen && (stem || matches.length === 1)) file = path.join(target, chosen);
    } else if (target.endsWith(extension)) {
      file = target;
    } else if (target.endsWith(".kicad_pro")) {
      file = `${target.slice(0, -".kicad_pro".length)}${extension}`;
    }
    if (!file || !(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) {
      return yield* failure(
        "invalid_path",
        `No ${extension} file for ${requested}. Pass the ${extension} file, its .kicad_pro, or its directory.`,
      );
    }
    return { file, relative: path.relative(workspaceRoot, file) };
  });

  /** Runs kicad-cli writing to a temporary file and returns that file's text. */
  const runToFile = Effect.fn("KicadService.runToFile")(function* (
    args: (output: string) => ReadonlyArray<string>,
    cwd: string,
    name: string,
  ) {
    const cli = yield* findCli();
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const temp = yield* fs
          .makeTempDirectoryScoped({ prefix: "kitty-kicad-" })
          .pipe(Effect.mapError((cause) => failure("command_failed", cause.message)));
        const output = path.join(temp, name);
        yield* runCli(cli, args(output), cwd);
        return yield* fs
          .readFileString(output)
          .pipe(
            Effect.mapError(() =>
              failure("command_failed", `kicad-cli did not write its ${name} output.`),
            ),
          );
      }),
    );
  });

  const parseOrFail = <A>(parse: () => A, what: string) =>
    Effect.try({
      try: parse,
      catch: (cause) => failure("command_failed", `Could not read the ${what}: ${String(cause)}`),
    });

  const erc = Effect.fn("KicadService.erc")(function* (input: InWorkspace<KicadErcInput>) {
    const { file, relative } = yield* resolveDesign(input.workspaceRoot, input.path, ".kicad_sch");
    const json = yield* runToFile(
      (output) => ["sch", "erc", "--format", "json", "--severity-all", "-o", output, file],
      path.dirname(file),
      "erc.json",
    );
    const report = yield* parseOrFail(() => parseErcReport(json), "ERC report");
    return { schematic: relative, ...report } satisfies KicadErcResult;
  });

  const drc = Effect.fn("KicadService.drc")(function* (input: InWorkspace<KicadDrcInput>) {
    const { file, relative } = yield* resolveDesign(input.workspaceRoot, input.path, ".kicad_pcb");
    const parity = input.schematicParity ?? true;
    const json = yield* runToFile(
      (output) => [
        "pcb",
        "drc",
        "--format",
        "json",
        "--severity-all",
        ...(parity ? ["--schematic-parity"] : []),
        "-o",
        output,
        file,
      ],
      path.dirname(file),
      "drc.json",
    );
    const report = yield* parseOrFail(() => parseDrcReport(json), "DRC report");
    return { board: relative, ...report } satisfies KicadDrcResult;
  });

  const readNetlist = Effect.fn("KicadService.readNetlist")(function* (
    workspaceRoot: string,
    requested: string,
  ) {
    const design = yield* resolveDesign(workspaceRoot, requested, ".kicad_sch");
    const text = yield* runToFile(
      (output) => ["sch", "export", "netlist", "--format", "kicadsexpr", "-o", output, design.file],
      path.dirname(design.file),
      "netlist.net",
    );
    const netlist = yield* parseOrFail(() => parseNetlist(text), "netlist");
    return { ...design, netlist };
  });

  const MAX_NETS = 300;

  const netlist = Effect.fn("KicadService.netlist")(function* (
    input: InWorkspace<KicadNetlistInput>,
  ) {
    const { relative, netlist: parsed } = yield* readNetlist(input.workspaceRoot, input.path);
    const ref = input.component?.trim();
    if (ref) {
      const component = parsed.components.find(
        (candidate) => candidate.ref.toLowerCase() === ref.toLowerCase(),
      );
      if (!component) {
        return yield* failure(
          "invalid_argument",
          `No component ${ref} in ${relative}. Components: ${parsed.components
            .map((candidate) => candidate.ref)
            .slice(0, 40)
            .join(", ")}.`,
        );
      }
      return {
        schematic: relative,
        components: [component],
        nets: [],
        pins: componentPins(parsed, component.ref),
        truncated: false,
      } satisfies KicadNetlistResult;
    }
    const nets = parsed.nets.filter((net) => net.nodes.length > 1);
    return {
      schematic: relative,
      components: parsed.components,
      nets: nets.slice(0, MAX_NETS),
      truncated: nets.length > MAX_NETS,
    } satisfies KicadNetlistResult;
  });

  const bom = Effect.fn("KicadService.bom")(function* (input: InWorkspace<KicadBomInput>) {
    const { relative, netlist: parsed } = yield* readNetlist(input.workspaceRoot, input.path);
    return {
      schematic: relative,
      ...buildBom(parsed.components, input.includeDnp ?? false),
    } satisfies KicadBomResult;
  });

  const listFiles = (directory: string) =>
    fs.readDirectory(directory).pipe(
      Effect.map((entries) => entries.toSorted()),
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    );

  const fabExport = Effect.fn("KicadService.fabExport")(function* (
    input: InWorkspace<KicadFabExportInput>,
  ) {
    const { file, relative } = yield* resolveDesign(input.workspaceRoot, input.path, ".kicad_pcb");
    const outputDir = input.outputDir
      ? yield* confine(input.workspaceRoot, input.outputDir)
      : path.join(path.dirname(file), "fab");
    const cli = yield* findCli();
    const board = yield* fs
      .readFileString(file)
      .pipe(Effect.mapError((cause) => failure("command_failed", cause.message)));
    const copper = boardCopperLayers(board);
    if (copper.length === 0) {
      return yield* failure("command_failed", `${relative} declares no copper layers.`);
    }
    const stem = path.basename(file, ".kicad_pcb");
    const gerberDir = path.join(outputDir, "gerber");
    // Replace only what an earlier export of this board wrote; leave other files.
    const ours = (entry: string) => entry.startsWith(`${stem}-`) || entry.startsWith(`${stem}.`);
    for (const entry of yield* listFiles(gerberDir)) {
      if (ours(entry)) yield* fs.remove(path.join(gerberDir, entry)).pipe(Effect.ignore);
    }
    yield* fs
      .makeDirectory(gerberDir, { recursive: true })
      .pipe(Effect.mapError((cause) => failure("command_failed", cause.message)));
    const cwd = path.dirname(file);
    yield* runCli(
      cli,
      [
        "pcb",
        "export",
        "gerbers",
        "-o",
        `${gerberDir}/`,
        "-l",
        [...copper, ...FAB_LAYERS].join(","),
        "--check-zones",
        file,
      ],
      cwd,
    );
    const gerbers = (yield* listFiles(gerberDir)).filter(ours);
    yield* runCli(
      cli,
      [
        "pcb",
        "export",
        "drill",
        "-o",
        `${gerberDir}/`,
        "--format",
        "excellon",
        "--excellon-units",
        "mm",
        file,
      ],
      cwd,
    );
    const drill = (yield* listFiles(gerberDir)).filter(
      (entry) => ours(entry) && !gerbers.includes(entry),
    );
    const positions = path.join(outputDir, `${stem}-pos.csv`);
    yield* runCli(
      cli,
      [
        "pcb",
        "export",
        "pos",
        "-o",
        positions,
        "--format",
        "csv",
        "--units",
        "mm",
        "--side",
        "both",
        "--exclude-dnp",
        file,
      ],
      cwd,
    );
    const zip = path.join(outputDir, `${stem}-gerber.zip`);
    yield* fs.remove(zip).pipe(Effect.ignore);
    const zipped = yield* processRunner
      .run({
        command: "zip",
        args: [
          "-q",
          "-j",
          zip,
          ...[...gerbers, ...drill].map((entry) => path.join(gerberDir, entry)),
        ],
        cwd: outputDir,
        timeout: "2 minutes",
      })
      .pipe(Effect.option);
    const rel = (target: string) => path.relative(input.workspaceRoot, target);
    return {
      board: relative,
      outputDir: rel(outputDir),
      gerbers: gerbers.map((entry) => rel(path.join(gerberDir, entry))),
      drill: drill.map((entry) => rel(path.join(gerberDir, entry))),
      positions: rel(positions),
      ...(Option.isSome(zipped) && zipped.value.code === 0 ? { zip: rel(zip) } : {}),
    } satisfies KicadFabExportResult;
  });

  return KicadService.of({ erc, drc, netlist, bom, fabExport });
});

export const layer = Layer.effect(KicadService, make());
