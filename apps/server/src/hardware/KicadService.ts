import {
  type BoardSyncInput,
  type BoardSyncResult,
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
  type KicadBoardModelResult,
  type KicadDesignFile,
  type KicadDesignSourceResult,
  type KicadDesignStampResult,
  type KicadPreviewKind,
  type KicadPreviewResult,
  type HardwarePinCheckInput,
  type HardwarePinCheckResult,
  type HardwarePinmapSyncInput,
  type HardwarePinmapSyncResult,
  type HardwareProjectInspectInput,
  type HardwareProjectInspectResult,
  type KittyFileReport,
  type KicadDesign,
  type KicadDesignsResult,
  KittyBoard,
  KittyComponents,
  KittyPinmap,
  type SchematicChange,
  type SchematicChangeAuthor,
  type SchematicChangesInput,
  type SchematicChangesResult,
  type SchematicEditInput,
  type SchematicEditResult,
  type SchematicHistoryResult,
  type SchematicHistoryStep,
  type SchematicReviewDecision,
  type SchematicReviewResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { applySchematicEdits, SchematicEditError } from "@t3tools/shared/kicad/schematicEdit";
import { schematicSubSheets, type SubSheet } from "@t3tools/shared/kicad/schematicScene";
import { type Node, parseDoc } from "@t3tools/shared/kicad/sexprDoc";
import { librarySymbols } from "@t3tools/shared/kicad/symbolLibrary";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as SchemaIssue from "effect/SchemaIssue";

import * as ProcessRunner from "../processRunner.ts";
import {
  BOARD_SYNC_SCRIPT,
  boardSyncJob,
  boardSyncPlan,
  footprintLibraries,
  kicadPythonCandidates,
  parseSyncReport,
} from "./boardSync.ts";
import { logTail } from "./buildOutput.ts";
import {
  buildBom,
  componentPins,
  isBlankBoardSvg,
  parseDrcReport,
  parseErcReport,
  parseNetlist,
  schematicPages,
} from "./kicadReports.ts";
import {
  buildComponents,
  buildPinmap,
  checkPins,
  chipFamily,
  detectMcu,
  hardwareProjectRoot,
  scanFirmwarePins,
  schematicPins,
} from "./projectModel.ts";
import { parseIdfProjectName, parseKicadCliVersion } from "./toolchainVersions.ts";
import { blankBoard, blankProject, blankSchematic } from "./kicadBlank.ts";
import {
  appendChange,
  CHANGE_LOG_FILE,
  parseChangeLog,
  userChangesSinceAgent,
} from "./schematicChangeLog.ts";
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
    /** What the hardware project has (schematic, board, firmware, config files) and what is wrong. */
    readonly projectInspect: (
      input: InWorkspace<HardwareProjectInspectInput>,
    ) => Effect.Effect<HardwareProjectInspectResult, HardwareToolError>;
    /** Writes hardware/pinmap.json and hardware/components.json from the schematic. */
    readonly pinmapSync: (
      input: InWorkspace<HardwarePinmapSyncInput>,
    ) => Effect.Effect<HardwarePinmapSyncResult, HardwareToolError>;
    /** KiCad projects up to four levels below `workspaceRoot`. */
    readonly listDesigns: (workspaceRoot: string) => Effect.Effect<KicadDesignsResult>;
    /** Opens a .kicad_pro in the KiCad app. */
    readonly openInKicad: (
      input: InWorkspace<{ readonly path: string }>,
    ) => Effect.Effect<{ readonly opened: string }, HardwareToolError>;
    /** Writes a blank KiCad project `<directory>/<fileStem>.kicad_*` in KiCad's current format. */
    readonly createBlankDesign: (
      directory: string,
      fileStem: string,
      title: string,
    ) => Effect.Effect<ReadonlyArray<string>, HardwareToolError>;
    /** SVG drawings of the schematic sheets or the board, for the panel. */
    /** Rewrites a symbol library file and a footprint library folder in KiCad's current format. */
    readonly upgradeLibraries: (input: {
      readonly symbols: string;
      readonly footprints: string;
    }) => Effect.Effect<void, HardwareToolError>;
    /** The board exported as a glTF model. */
    readonly boardModel: (
      input: InWorkspace<{ readonly path: string }>,
    ) => Effect.Effect<KicadBoardModelResult, HardwareToolError>;
    /** Changes a schematic sheet; KiCad reads the result back before it is saved. */
    readonly schematicEdit: (
      input: InWorkspace<SchematicEditInput> & {
        /** Who is editing; the agent unless said otherwise. */
        readonly by?: SchematicChangeAuthor;
      },
    ) => Effect.Effect<SchematicEditResult, HardwareToolError>;
    /** The design's change log, and what the user changed since the agent last edited. */
    readonly schematicChanges: (
      input: InWorkspace<SchematicChangesInput>,
    ) => Effect.Effect<SchematicChangesResult, HardwareToolError>;
    /** Brings the schematic's parts and nets onto the board. */
    readonly boardSync: (
      input: InWorkspace<BoardSyncInput>,
    ) => Effect.Effect<BoardSyncResult, HardwareToolError>;
    /** Keeps or reverts the agent's edits the user has not yet looked at. */
    readonly schematicReview: (
      input: InWorkspace<{ readonly path: string; readonly decision: SchematicReviewDecision }>,
    ) => Effect.Effect<SchematicReviewResult, HardwareToolError>;
    /** Steps back or forward through the edits made with `schematicEdit`. */
    readonly schematicHistory: (
      input: InWorkspace<{ readonly path: string; readonly step: SchematicHistoryStep }>,
    ) => Effect.Effect<SchematicHistoryResult, HardwareToolError>;
    /** A value that changes when the design's schematic or board files are saved. */
    readonly designStamp: (
      input: InWorkspace<{ readonly path: string }>,
    ) => Effect.Effect<KicadDesignStampResult, HardwareToolError>;
    /** The design's files as text, for the client to draw. */
    readonly designSource: (
      input: InWorkspace<{ readonly path: string }>,
    ) => Effect.Effect<KicadDesignSourceResult, HardwareToolError>;
    readonly preview: (
      input: InWorkspace<{ readonly path: string; readonly kind: KicadPreviewKind }>,
    ) => Effect.Effect<KicadPreviewResult, HardwareToolError>;
    /** Checks firmware pins and pinmap.json against the schematic. */
    readonly pinCheck: (
      input: InWorkspace<HardwarePinCheckInput>,
    ) => Effect.Effect<HardwarePinCheckResult, HardwareToolError>;
  }
>()("t3/hardware/KicadService") {}

/** What the board preview draws: copper, silkscreen and outline, like a bare board. */
const BOARD_PREVIEW_LAYERS = "F.Cu,B.Cu,F.Silkscreen,B.Silkscreen,Edge.Cuts";
/** Keeps a preview reply well under the WebSocket message size. */
const MAX_PREVIEW_BYTES = 8_000_000;
/** A model is sent base64 encoded, which adds a third; this stays under the same cap. */
const MAX_BOARD_MODEL_BYTES = 5_500_000;
const BOARD_MODEL_DETAIL = ["--include-silkscreen", "--include-soldermask"];

const MAC_KICAD_CLI = "/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli";

/** Where to look for kicad-cli: KICAD_CLI, then the macOS app, then PATH. */
/** Where KiCad keeps its own symbol libraries, for the kicad-cli in use. */
function kicadSymbolDirectories(cli: string, env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const configured = [env.KICAD10_SYMBOL_DIR, env.KICAD_SYMBOL_DIR]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  const bundled = cli.endsWith("/Contents/MacOS/kicad-cli")
    ? [`${cli.slice(0, -"/MacOS/kicad-cli".length)}/SharedSupport/symbols`]
    : [];
  return [...configured, ...bundled, "/usr/share/kicad/symbols", "/usr/local/share/kicad/symbols"];
}

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
  const random = yield* SecureRandom.SecureRandom;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;

  const failure = (code: HardwareToolError["code"], message: string) =>
    new HardwareToolError({ code, message });
  const confine = (workspaceRoot: string, requested: string) =>
    resolveInWorkspace(workspaceRoot, requested).pipe(Effect.provideService(Path.Path, path));

  // Asking kicad-cli for its version takes a moment, so a CLI that answered is remembered.
  let knownCli: string | undefined;
  const findCli = Effect.fn("KicadService.findCli")(function* () {
    if (knownCli) return knownCli;
    const env = yield* HostProcess.Environment;
    for (const command of kicadCliCandidates(env)) {
      const result = yield* processRunner
        .run({ command, args: ["version"], timeout: "15 seconds" })
        .pipe(Effect.option);
      if (Option.isSome(result) && result.value.code === 0) {
        if (parseKicadCliVersion(result.value.stdout)) {
          knownCli = command;
          return command;
        }
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
      if (!file) {
        // A hardware project root: its design sits in hardware/ (e.g. hardware/kicad/).
        const nested = (yield* walk(target, 3)).filter((entry) => entry.endsWith(extension));
        const projects = (yield* walk(target, 3)).filter((entry) => entry.endsWith(".kicad_pro"));
        const paired = nested.filter((entry) =>
          projects.includes(`${entry.slice(0, -extension.length)}.kicad_pro`),
        );
        const only = paired.length === 1 ? paired[0] : nested.length === 1 ? nested[0] : undefined;
        if (only) file = path.join(target, only);
      }
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

  const boardSync = Effect.fn("KicadService.boardSync")(function* (
    input: InWorkspace<BoardSyncInput>,
  ) {
    const board = yield* resolveDesign(input.workspaceRoot, input.path, ".kicad_pcb");
    const directory = path.dirname(board.file);
    const schematic = yield* resolveDesign(input.workspaceRoot, directory, ".kicad_sch").pipe(
      Effect.mapError(() =>
        failure("invalid_path", `${board.relative} has no schematic beside it to take parts from.`),
      ),
    );
    const netlistText = yield* runToFile(
      (output) => [
        "sch",
        "export",
        "netlist",
        "--format",
        "kicadsexpr",
        "-o",
        output,
        schematic.file,
      ],
      directory,
      "netlist.net",
    );
    const plan = yield* parseOrFail(() => boardSyncPlan(netlistText), "netlist");
    const cli = yield* findCli();
    const env = yield* HostProcess.Environment;
    const table = yield* fs
      .readFileString(path.join(directory, "fp-lib-table"))
      .pipe(Effect.option);
    const libraries = footprintLibraries(
      Option.getOrUndefined(table),
      directory,
      new Set(plan.components.map((part) => part.footprint.split(":")[0] ?? "")),
      kicadSymbolDirectories(cli, env).map((symbols) =>
        path.join(path.dirname(symbols), "footprints"),
      ),
    );
    const io = <A, E extends { readonly message: string }, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError((cause) => failure("command_failed", cause.message)));
    const report = yield* Effect.scoped(
      Effect.gen(function* () {
        const temp = yield* io(fs.makeTempDirectoryScoped({ prefix: "kitty-pcb-" }));
        const script = path.join(temp, "sync.py");
        const job = path.join(temp, "job.json");
        yield* io(fs.writeFileString(script, BOARD_SYNC_SCRIPT));
        yield* io(fs.writeFileString(job, boardSyncJob(board.file, plan.components, libraries)));
        // KiCad's own Python writes the board, so the file is exactly what KiCad would save.
        let last =
          "KiCad's Python (the pcbnew module) was not found. Install KiCad 10 or set KITTY_KICAD_PYTHON.";
        for (const python of kicadPythonCandidates(env, cli)) {
          const run = yield* processRunner
            .run({
              command: python,
              args: [script, job],
              cwd: directory,
              timeout: "2 minutes",
              outputMode: "truncate",
              timeoutBehavior: "timedOutResult",
            })
            .pipe(Effect.option);
          if (Option.isNone(run)) continue;
          const parsed = parseSyncReport(run.value.stdout);
          if (parsed) return parsed;
          const output = `${run.value.stdout}\n${run.value.stderr}`;
          // A Python without pcbnew is not KiCad's; the next candidate may be.
          if (output.includes("No module named")) continue;
          last = `KiCad could not update the board, so it was left as it was.\n${logTail(output, 8)}`;
          break;
        }
        return yield* failure("command_failed", last);
      }),
    );
    return {
      board: board.relative,
      ...report,
      missing: [...report.missing],
      withoutFootprint: [...plan.withoutFootprint],
      parts: plan.components.length - report.missing.length,
    } satisfies BoardSyncResult;
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
    // Kitty projects keep fab files in manufacturing/; other KiCad projects get fab/.
    const manufacturing = path.join(
      input.workspaceRoot,
      hardwareProjectRoot(relative),
      "manufacturing",
    );
    const outputDir = input.outputDir
      ? yield* confine(input.workspaceRoot, input.outputDir)
      : (yield* fs.exists(manufacturing).pipe(Effect.orElseSucceed(() => false)))
        ? manufacturing
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

  const SKIP_DIRECTORIES = new Set(["node_modules", "build", "managed_components", ".git", "fab"]);

  /** Files under `root` (relative paths) up to `depth` levels, skipping build output. */
  const walk = Effect.fn("KicadService.walk")(function* (root: string, depth: number) {
    const files: Array<string> = [];
    let frontier: ReadonlyArray<string> = [""];
    for (let level = 0; level <= depth && frontier.length > 0; level++) {
      const next: Array<string> = [];
      for (const relative of frontier) {
        for (const entry of yield* listFiles(path.join(root, relative))) {
          if (entry.startsWith(".") || SKIP_DIRECTORIES.has(entry)) continue;
          const child = relative ? path.join(relative, entry) : entry;
          const info = yield* fs.stat(path.join(root, child)).pipe(Effect.option);
          if (Option.isNone(info)) continue;
          if (info.value.type === "Directory") next.push(child);
          else files.push(child);
        }
      }
      frontier = next;
    }
    return files.toSorted();
  });

  const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

  /** A project-model JSON file: absent, invalid (with field-level errors), or decoded. */
  const readModel = Effect.fn("KicadService.readModel")(function* <A>(
    schema: Schema.Codec<A, unknown>,
    file: string,
    display: string,
  ) {
    const text = yield* fs.readFileString(file).pipe(Effect.option);
    if (Option.isNone(text)) {
      const report: KittyFileReport = { file: display, present: false, errors: [] };
      return { report, value: undefined };
    }
    const decoded = Schema.decodeExit(Schema.fromJsonString(schema))(text.value, {
      errors: "all",
    });
    if (decoded._tag === "Success") {
      const report: KittyFileReport = { file: display, present: true, errors: [] };
      return { report, value: decoded.value };
    }
    const errors = decoded.cause.reasons.flatMap((reason) =>
      reason._tag === "Fail" && Schema.isSchemaError(reason.error)
        ? formatIssues(reason.error.issue).issues.map((issue) => {
            const where = (issue.path ?? [])
              .map((key) => (typeof key === "number" ? `[${key}]` : `.${String(key)}`))
              .join("")
              .replace(/^\./, "");
            return `${where || "(file)"}: ${issue.message}`;
          })
        : ["Invalid file"],
    );
    const report: KittyFileReport = { file: display, present: true, errors };
    return { report, value: undefined };
  });

  interface ProjectLayout {
    readonly root: string;
    readonly rootRelative: string;
    readonly schematic?: string | undefined;
    readonly board?: string | undefined;
    readonly firmware: ReadonlyArray<string>;
  }

  /** Where the schematic, board and ESP-IDF projects of a hardware project are. */
  const layout = Effect.fn("KicadService.layout")(function* (
    workspaceRoot: string,
    requested: string | undefined,
  ) {
    const root = yield* confine(workspaceRoot, requested ?? ".");
    const info = yield* fs.stat(root).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "Directory") {
      return yield* failure("invalid_path", `${requested ?? "."} is not a directory.`);
    }
    const files = yield* walk(root, 4);
    const pick = (extension: string) => {
      const matches = files.filter((file) => file.endsWith(extension));
      const pro = files.find((file) => file.endsWith(".kicad_pro"));
      const stem = pro ? pro.slice(0, -".kicad_pro".length) : undefined;
      return (
        (stem && matches.find((file) => file === `${stem}${extension}`)) ??
        matches.find((file) => file.startsWith("hardware/")) ??
        matches[0]
      );
    };
    const firmware: Array<string> = [];
    for (const file of files.filter((candidate) => candidate.endsWith("CMakeLists.txt"))) {
      const text = yield* fs
        .readFileString(path.join(root, file))
        .pipe(Effect.orElseSucceed(() => ""));
      if (parseIdfProjectName(text)) firmware.push(path.dirname(file));
    }
    const rel = (file: string | undefined) =>
      file ? path.relative(workspaceRoot, path.join(root, file)) : undefined;
    return {
      root,
      rootRelative: path.relative(workspaceRoot, root) || ".",
      schematic: rel(pick(".kicad_sch")),
      board: rel(pick(".kicad_pcb")),
      firmware: firmware.map((dir) => rel(dir) ?? dir),
    } satisfies ProjectLayout;
  });

  const MODEL_FILES = {
    board: "hardware/board.json",
    pinmap: "hardware/pinmap.json",
    components: "hardware/components.json",
  } as const;

  const projectInspect = Effect.fn("KicadService.projectInspect")(function* (
    input: InWorkspace<HardwareProjectInspectInput>,
  ) {
    const found = yield* layout(input.workspaceRoot, input.path);
    const display = (file: string) => path.join(found.rootRelative, file);
    const board = yield* readModel(
      KittyBoard,
      path.join(found.root, MODEL_FILES.board),
      display(MODEL_FILES.board),
    );
    const pinmap = yield* readModel(
      KittyPinmap,
      path.join(found.root, MODEL_FILES.pinmap),
      display(MODEL_FILES.pinmap),
    );
    const components = yield* readModel(
      KittyComponents,
      path.join(found.root, MODEL_FILES.components),
      display(MODEL_FILES.components),
    );
    const next: Array<string> = [];
    if (!found.schematic)
      next.push("No KiCad schematic found; put the KiCad project under hardware/.");
    if (found.schematic && (!pinmap.report.present || !components.report.present)) {
      next.push("Run hw_pinmap_sync to export pinmap.json and components.json from the schematic.");
    }
    if (!board.report.present) {
      next.push(
        "Write hardware/board.json (board name, MCU, buses, peripherals) to describe the board.",
      );
    }
    for (const report of [board.report, pinmap.report, components.report]) {
      if (report.errors.length > 0) next.push(`Fix ${report.file}: ${report.errors[0]}`);
    }
    if (found.firmware.length === 0)
      next.push("No ESP-IDF project yet; create one with hw_project_create.");
    if (found.schematic && found.firmware.length > 0) {
      next.push("Run hw_pin_check after changing pins in the firmware or the schematic.");
    }
    return {
      root: found.rootRelative,
      ...(found.schematic ? { schematic: found.schematic } : {}),
      ...(found.board ? { board: found.board } : {}),
      firmware: found.firmware,
      files: [board.report, pinmap.report, components.report],
      ...(board.value ? { board_config: board.value } : {}),
      ...(pinmap.value ? { pinmap: pinmap.value } : {}),
      next_steps: next,
    } satisfies HardwareProjectInspectResult;
  });

  /** The schematic, its netlist and its MCU. */
  const schematicModel = Effect.fn("KicadService.schematicModel")(function* (
    workspaceRoot: string,
    found: ProjectLayout,
    mcuRef: string | undefined,
  ) {
    if (!found.schematic) {
      return yield* failure("invalid_path", `No KiCad schematic under ${found.rootRelative}.`);
    }
    const { relative, netlist: parsed } = yield* readNetlist(workspaceRoot, found.schematic);
    const wanted = mcuRef?.trim().toLowerCase();
    const mcu = wanted
      ? parsed.components.find((component) => component.ref.toLowerCase() === wanted)
      : detectMcu(parsed.components);
    if (!mcu) {
      return yield* failure(
        "invalid_argument",
        wanted
          ? `No component ${mcuRef} in ${relative}.`
          : `No ESP32 part in ${relative}. Pass mcu with the reference of the MCU or module.`,
      );
    }
    return { relative, netlist: parsed, mcu, pins: schematicPins(parsed, mcu) };
  });

  const writeJson = (file: string, value: unknown) =>
    fs.makeDirectory(path.dirname(file), { recursive: true }).pipe(
      Effect.andThen(fs.writeFileString(file, `${JSON.stringify(value, null, 2)}\n`)),
      Effect.mapError((cause) =>
        failure("command_failed", `Could not write ${file}: ${cause.message}`),
      ),
    );

  const pinmapSync = Effect.fn("KicadService.pinmapSync")(function* (
    input: InWorkspace<HardwarePinmapSyncInput>,
  ) {
    const found = yield* layout(input.workspaceRoot, input.path);
    const model = yield* schematicModel(input.workspaceRoot, found, input.mcu);
    const pinmapFile = path.join(found.root, MODEL_FILES.pinmap);
    const componentsFile = path.join(found.root, MODEL_FILES.components);
    // Hand-written notes survive a sync; an invalid file is replaced rather than merged.
    const previousPinmap = (yield* readModel(KittyPinmap, pinmapFile, MODEL_FILES.pinmap)).value;
    const previousComponents = (yield* readModel(
      KittyComponents,
      componentsFile,
      MODEL_FILES.components,
    )).value;
    const schematic = path.relative(found.root, path.join(input.workspaceRoot, model.relative));
    const { pinmap, changes } = buildPinmap(model.mcu, model.pins, schematic, previousPinmap);
    yield* writeJson(pinmapFile, pinmap);
    yield* writeJson(
      componentsFile,
      buildComponents(model.netlist.components, schematic, previousComponents),
    );
    return {
      pinmap: path.relative(input.workspaceRoot, pinmapFile),
      components: path.relative(input.workspaceRoot, componentsFile),
      mcu: pinmap.mcu,
      gpios: pinmap.pins.length,
      connected: pinmap.pins.filter((pin) => pin.connected).length,
      changes,
    } satisfies HardwarePinmapSyncResult;
  });

  const FIRMWARE_SOURCE = /\.(c|cc|cpp|h|hpp)$|(^|\/)sdkconfig(\.defaults)?$/;

  const pinCheck = Effect.fn("KicadService.pinCheck")(function* (
    input: InWorkspace<HardwarePinCheckInput>,
  ) {
    const found = yield* layout(input.workspaceRoot, input.path);
    const pinmapFile = path.join(found.root, MODEL_FILES.pinmap);
    const pinmap = (yield* readModel(KittyPinmap, pinmapFile, MODEL_FILES.pinmap)).value;
    const model = yield* schematicModel(input.workspaceRoot, found, pinmap?.mcu.ref);
    const sources: Array<{ path: string; text: string }> = [];
    for (const firmware of found.firmware) {
      const directory = path.join(input.workspaceRoot, firmware);
      for (const file of yield* walk(directory, 4)) {
        if (!FIRMWARE_SOURCE.test(file)) continue;
        const text = yield* fs
          .readFileString(path.join(directory, file))
          .pipe(Effect.orElseSucceed(() => ""));
        sources.push({ path: path.join(firmware, file), text });
      }
    }
    const { issues, firmware } = checkPins({
      family: chipFamily(`${model.mcu.value} ${model.mcu.footprint ?? ""}`),
      schematic: model.pins,
      pinmap,
      firmware: scanFirmwarePins(sources),
    });
    return {
      ok: issues.every((issue) => issue.severity !== "error"),
      issues,
      firmware_pins: firmware,
    } satisfies HardwarePinCheckResult;
  });

  const createBlankDesign = Effect.fn("KicadService.createBlankDesign")(function* (
    directory: string,
    fileStem: string,
    title: string,
  ) {
    yield* fs
      .makeDirectory(directory, { recursive: true })
      .pipe(Effect.mapError((cause) => failure("command_failed", cause.message)));
    const files = {
      pro: path.join(directory, `${fileStem}.kicad_pro`),
      sch: path.join(directory, `${fileStem}.kicad_sch`),
      pcb: path.join(directory, `${fileStem}.kicad_pcb`),
    };
    const write = (file: string, text: string) =>
      fs
        .writeFileString(file, text)
        .pipe(Effect.mapError((cause) => failure("command_failed", cause.message)));
    yield* write(files.pro, blankProject(path.basename(files.pro)));
    yield* write(files.sch, blankSchematic(title));
    yield* write(files.pcb, blankBoard(title));
    // Let KiCad rewrite both in its own format; without kicad-cli the files still open.
    const cli = yield* findCli().pipe(Effect.option);
    if (Option.isSome(cli)) {
      yield* runCli(cli.value, ["sch", "upgrade", "--force", files.sch], directory);
      yield* runCli(cli.value, ["pcb", "upgrade", "--force", files.pcb], directory);
    }
    return [files.pro, files.sch, files.pcb];
  });

  const listDesigns = Effect.fn("KicadService.listDesigns")(function* (workspaceRoot: string) {
    const files = yield* walk(workspaceRoot, 4).pipe(
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    );
    const designs = files
      .filter((file) => file.endsWith(".kicad_pro"))
      .map((project): KicadDesign => {
        const stem = project.slice(0, -".kicad_pro".length);
        const schematic = files.includes(`${stem}.kicad_sch`) ? `${stem}.kicad_sch` : undefined;
        const board = files.includes(`${stem}.kicad_pcb`) ? `${stem}.kicad_pcb` : undefined;
        return {
          project,
          name: path.basename(stem),
          ...(schematic ? { schematic } : {}),
          ...(board ? { board } : {}),
        };
      });
    return { designs } satisfies KicadDesignsResult;
  });

  const openInKicad = Effect.fn("KicadService.openInKicad")(function* (
    input: InWorkspace<{ readonly path: string }>,
  ) {
    const file = yield* confine(input.workspaceRoot, input.path);
    if (
      !file.endsWith(".kicad_pro") ||
      !(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))
    ) {
      return yield* failure("invalid_path", `${input.path} is not a KiCad project.`);
    }
    const platform = yield* HostProcess.Platform;
    const command =
      platform === "darwin"
        ? { command: "open", args: [file] }
        : platform === "win32"
          ? { command: "cmd", args: ["/c", "start", "", file] }
          : { command: "xdg-open", args: [file] };
    const result = yield* processRunner
      .run({ ...command, timeout: "30 seconds" })
      .pipe(Effect.mapError((cause) => failure("command_failed", cause.message)));
    if (result.code !== 0) {
      return yield* failure("command_failed", `Could not open KiCad. ${logTail(result.stderr, 4)}`);
    }
    return { opened: input.path };
  });

  const preview = Effect.fn("KicadService.preview")(function* (
    input: InWorkspace<{ readonly path: string; readonly kind: KicadPreviewKind }>,
  ) {
    const extension = input.kind === "schematic" ? ".kicad_sch" : ".kicad_pcb";
    const { file, relative } = yield* resolveDesign(input.workspaceRoot, input.path, extension);
    const cli = yield* findCli();
    const stem = path.basename(file, extension);
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const temp = yield* fs
          .makeTempDirectoryScoped({ prefix: "kitty-kicad-preview-" })
          .pipe(Effect.mapError((cause) => failure("command_failed", cause.message)));
        const read = (name: string) =>
          fs
            .readFileString(path.join(temp, name))
            .pipe(Effect.mapError((cause) => failure("command_failed", cause.message)));
        if (input.kind === "board") {
          const output = path.join(temp, `${stem}.svg`);
          yield* runCli(
            cli,
            [
              "pcb",
              "export",
              "svg",
              "--mode-single",
              "--layers",
              BOARD_PREVIEW_LAYERS,
              "--page-size-mode",
              "2",
              "--exclude-drawing-sheet",
              "-o",
              output,
              file,
            ],
            path.dirname(file),
          );
          const svg = yield* read(`${stem}.svg`);
          if (svg.length > MAX_PREVIEW_BYTES) {
            return {
              kind: input.kind,
              file: relative,
              pages: [],
              omitted: 1,
            } satisfies KicadPreviewResult;
          }
          const pages = isBlankBoardSvg(svg) ? [] : [{ name: "Board", svg }];
          return {
            kind: input.kind,
            file: relative,
            pages,
            omitted: 0,
          } satisfies KicadPreviewResult;
        }
        yield* runCli(cli, ["sch", "export", "svg", "-o", temp, file], path.dirname(file));
        const names = yield* fs
          .readDirectory(temp)
          .pipe(Effect.mapError((cause) => failure("command_failed", cause.message)));
        const files = yield* Effect.forEach(
          names.filter((name) => name.endsWith(".svg")),
          (name) => read(name).pipe(Effect.map((svg) => ({ name, svg }))),
        );
        const { pages, omitted } = schematicPages(stem, files, MAX_PREVIEW_BYTES);
        return {
          kind: input.kind,
          file: relative,
          pages: [...pages],
          omitted,
        } satisfies KicadPreviewResult;
      }),
    );
  });

  /** The agent's edits to each schematic that the user has yet to keep or revert. */
  const reviews = new Map<
    string,
    { readonly baseline: string; readonly summary: ReadonlyArray<string>; readonly current: string }
  >();

  const designSource = Effect.fn("KicadService.designSource")(function* (
    input: InWorkspace<{ readonly path: string }>,
  ) {
    const root = input.workspaceRoot;
    const schematic = yield* resolveDesign(root, input.path, ".kicad_sch").pipe(Effect.option);
    const board = yield* resolveDesign(root, input.path, ".kicad_pcb").pipe(Effect.option);
    if (Option.isNone(schematic) && Option.isNone(board)) {
      return yield* failure("invalid_path", `No KiCad schematic or board for ${input.path}.`);
    }
    let budget = MAX_PREVIEW_BYTES;
    let omitted = 0;
    const load = Effect.fn("KicadService.designSource.load")(function* (
      file: string,
      name: string,
    ) {
      const source = yield* fs.readFileString(file).pipe(Effect.option);
      if (Option.isNone(source)) return undefined;
      if (source.value.length > budget) {
        omitted++;
        return undefined;
      }
      budget -= source.value.length;
      const review = reviews.get(file);
      const loaded: KicadDesignFile = {
        name,
        file: path.relative(root, file),
        source: source.value,
        // A review only stands while the file is still what the agent left.
        ...(review && review.current === source.value
          ? { review: { baseline: review.baseline, summary: review.summary } }
          : {}),
      };
      return loaded;
    });
    const sheets: Array<KicadDesignFile> = [];
    if (Option.isSome(schematic)) {
      // Sub-sheet files are relative to the sheet that refers to them.
      const queue = [{ file: schematic.value.file, name: "Root sheet" }];
      const seen = new Set<string>();
      for (const next of queue) {
        if (seen.has(next.file)) continue;
        seen.add(next.file);
        const loaded = yield* load(next.file, next.name);
        if (!loaded) continue;
        sheets.push(loaded);
        // A sheet that does not parse is still returned; it just has no sub-sheets to follow.
        const subs = yield* Effect.try({
          try: () => schematicSubSheets(loaded.source),
          catch: () => "unreadable" as const,
        }).pipe(Effect.orElseSucceed((): ReadonlyArray<SubSheet> => []));
        for (const sub of subs) {
          const file = path.resolve(path.dirname(next.file), sub.file);
          const inside = yield* confine(root, path.relative(root, file)).pipe(Effect.option);
          if (Option.isSome(inside)) queue.push({ file, name: sub.name || sub.file });
        }
      }
    }
    const boardFile = Option.isSome(board) ? yield* load(board.value.file, "Board") : undefined;
    return {
      sheets,
      ...(boardFile ? { board: boardFile } : {}),
      omitted,
    } satisfies KicadDesignSourceResult;
  });

  const boardModel = Effect.fn("KicadService.boardModel")(function* (
    input: InWorkspace<{ readonly path: string }>,
  ) {
    const { file, relative } = yield* resolveDesign(input.workspaceRoot, input.path, ".kicad_pcb");
    const cli = yield* findCli();
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const temp = yield* fs
          .makeTempDirectoryScoped({ prefix: "kitty-kicad-model-" })
          .pipe(Effect.mapError((cause) => failure("command_failed", cause.message)));
        const output = path.join(temp, "board.glb");
        const exportModel = Effect.fn("KicadService.boardModel.export")(function* (
          extra: ReadonlyArray<string>,
        ) {
          yield* runCli(
            cli,
            ["pcb", "export", "glb", "--subst-models", "--force", ...extra, "-o", output, file],
            path.dirname(file),
          );
          return yield* fs
            .readFile(output)
            .pipe(Effect.mapError((cause) => failure("command_failed", cause.message)));
        });
        // Silkscreen and solder mask make the board look real but can triple its size.
        const detailed = yield* exportModel(BOARD_MODEL_DETAIL);
        const bytes = detailed.length <= MAX_BOARD_MODEL_BYTES ? detailed : yield* exportModel([]);
        if (bytes.length > MAX_BOARD_MODEL_BYTES) {
          return yield* failure(
            "command_failed",
            `The 3D model is ${Math.round(bytes.length / 1e6)} MB, too large to show here. Open the board in KiCad's 3D viewer.`,
          );
        }
        return {
          file: relative,
          glb: Buffer.from(bytes).toString("base64"),
          detailed: bytes === detailed,
        } satisfies KicadBoardModelResult;
      }),
    );
  });

  const designStamp = Effect.fn("KicadService.designStamp")(function* (
    input: InWorkspace<{ readonly path: string }>,
  ) {
    const target = yield* confine(input.workspaceRoot, input.path);
    const info = yield* fs.stat(target).pipe(Effect.option);
    const directory =
      Option.isSome(info) && info.value.type === "Directory" ? target : path.dirname(target);
    // Sub-sheets live beside the root sheet, so every design file in the folder counts.
    const parts: Array<string> = [];
    for (const entry of (yield* listFiles(directory)).toSorted()) {
      if (!entry.endsWith(".kicad_sch") && !entry.endsWith(".kicad_pcb")) continue;
      const stat = yield* fs.stat(path.join(directory, entry)).pipe(Effect.option);
      if (Option.isNone(stat)) continue;
      const modified = Option.getOrUndefined(stat.value.mtime)?.getTime() ?? 0;
      parts.push(`${entry}:${stat.value.size}:${modified}`);
    }
    return { stamp: parts.join("|") } satisfies KicadDesignStampResult;
  });

  const upgradeLibraries = Effect.fn("KicadService.upgradeLibraries")(function* (input: {
    readonly symbols: string;
    readonly footprints: string;
  }) {
    const cli = yield* findCli();
    yield* runCli(cli, ["sym", "upgrade", "--force", input.symbols], path.dirname(input.symbols));
    yield* runCli(
      cli,
      ["fp", "upgrade", "--force", input.footprints],
      path.dirname(input.footprints),
    );
  });

  /** The symbols of a library file by name; empty when the file is missing. */
  const readSymbols = Effect.fn("KicadService.readSymbols")(function* (file: string) {
    const source = yield* fs.readFileString(file).pipe(Effect.option);
    if (Option.isNone(source)) return new Map<string, ReadonlyArray<Node>>();
    const symbols = yield* parseOrFail(() => librarySymbols(parseDoc(source.value)), "library");
    return new Map(symbols.map((symbol) => [String(symbol[1]).slice(1, -1), symbol] as const));
  });

  // KiCad's power library is large and does not change while the server runs.
  let knownPower: Map<string, ReadonlyArray<Node>> | undefined;
  const powerSymbols = Effect.fn("KicadService.powerSymbols")(function* () {
    if (knownPower) return knownPower;
    const env = yield* HostProcess.Environment;
    for (const directory of kicadSymbolDirectories(yield* findCli(), env)) {
      const symbols = yield* readSymbols(path.join(directory, "power.kicad_sym"));
      if (symbols.size > 0) {
        knownPower = symbols;
        return symbols;
      }
    }
    return new Map<string, ReadonlyArray<Node>>();
  });

  const isEditError = Schema.is(SchematicEditError);
  const HISTORY_LIMIT = 50;
  /** Earlier and undone versions of each schematic edited here, newest last. */
  interface Version {
    readonly source: string;
    /** What the edit that replaced this version did. */
    readonly summary: ReadonlyArray<string>;
  }
  const histories = new Map<
    string,
    { undo: Array<Version>; redo: Array<Version>; current: string }
  >();

  const changeLog = (directory: string) => path.join(directory, CHANGE_LOG_FILE);
  const readChanges = (directory: string) =>
    fs.readFileString(changeLog(directory)).pipe(
      Effect.map(parseChangeLog),
      Effect.orElseSucceed((): ReadonlyArray<SchematicChange> => []),
    );
  /** Adds to the design's change log; a log that cannot be written never fails an edit. */
  const recordChange = Effect.fn("KicadService.recordChange")(function* (
    directory: string,
    by: SchematicChangeAuthor,
    summary: ReadonlyArray<string>,
  ) {
    if (summary.length === 0) return;
    const file = changeLog(directory);
    const at = DateTime.formatIso(yield* DateTime.now);
    yield* Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      const existing = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
      yield* fs.writeFileString(file, appendChange(existing, { at, by, summary: [...summary] }));
    }).pipe(Effect.ignore);
  });

  const schematicChanges = Effect.fn("KicadService.schematicChanges")(function* (
    input: InWorkspace<SchematicChangesInput>,
  ) {
    const { file, relative } = yield* resolveDesign(input.workspaceRoot, input.path, ".kicad_sch");
    const changes = yield* readChanges(path.dirname(file));
    return {
      schematic: relative,
      changes: changes.slice(-Math.min(Math.max(input.limit ?? 30, 1), 200)),
      userChanges: userChangesSinceAgent(changes),
    } satisfies SchematicChangesResult;
  });
  /** The file's history, started over when someone else has saved the file since. */
  const historyOf = (file: string, onDisk: string) => {
    const known = histories.get(file);
    if (known && known.current === onDisk) return known;
    const fresh = { undo: [], redo: [], current: onDisk };
    histories.set(file, fresh);
    return fresh;
  };

  const schematicHistory = Effect.fn("KicadService.schematicHistory")(function* (
    input: InWorkspace<{ readonly path: string; readonly step: SchematicHistoryStep }>,
  ) {
    const { file, relative } = yield* resolveDesign(input.workspaceRoot, input.path, ".kicad_sch");
    const onDisk = yield* fs
      .readFileString(file)
      .pipe(Effect.mapError((cause) => failure("invalid_path", cause.message)));
    const history = historyOf(file, onDisk);
    const [from, to] =
      input.step === "undo" ? [history.undo, history.redo] : [history.redo, history.undo];
    const target = from.pop();
    if (target !== undefined) {
      to.push({ source: onDisk, summary: target.summary });
      history.current = target.source;
      yield* fs
        .writeFileString(file, target.source)
        .pipe(Effect.mapError((cause) => failure("command_failed", cause.message)));
      // Only the designer steps through history, so this is the user's doing.
      yield* recordChange(
        path.dirname(file),
        "user",
        target.summary.map((line) => `${input.step === "undo" ? "Undid" : "Redid"}: ${line}`),
      );
    }
    return {
      schematic: relative,
      applied: target !== undefined,
      undo: history.undo.length,
      redo: history.redo.length,
    } satisfies SchematicHistoryResult;
  });

  const schematicReview = Effect.fn("KicadService.schematicReview")(function* (
    input: InWorkspace<{ readonly path: string; readonly decision: SchematicReviewDecision }>,
  ) {
    const { file, relative } = yield* resolveDesign(input.workspaceRoot, input.path, ".kicad_sch");
    const onDisk = yield* fs
      .readFileString(file)
      .pipe(Effect.mapError((cause) => failure("invalid_path", cause.message)));
    const review = reviews.get(file);
    reviews.delete(file);
    if (!review || review.current !== onDisk) return { schematic: relative, applied: false };
    if (input.decision === "revert") {
      yield* fs
        .writeFileString(file, review.baseline)
        .pipe(Effect.mapError((cause) => failure("command_failed", cause.message)));
      // A revert is one more step of history, so undo brings the agent's work back.
      const history = historyOf(file, onDisk);
      history.undo.push({ source: onDisk, summary: review.summary });
      if (history.undo.length > HISTORY_LIMIT) history.undo.shift();
      history.redo.length = 0;
      history.current = review.baseline;
      yield* recordChange(
        path.dirname(file),
        "user",
        review.summary.map((line) => `Reverted the agent's change: ${line}`),
      );
    }
    return { schematic: relative, applied: true } satisfies SchematicReviewResult;
  });

  const schematicEdit = Effect.fn("KicadService.schematicEdit")(function* (
    input: InWorkspace<SchematicEditInput> & { readonly by?: SchematicChangeAuthor },
  ) {
    const { file, relative } = yield* resolveDesign(input.workspaceRoot, input.path, ".kicad_sch");
    const directory = path.dirname(file);
    const stem = path.basename(file, ".kicad_sch");
    const libraries = {
      jlc: yield* readSymbols(path.join(directory, "lib", "jlc.kicad_sym")),
      power: yield* powerSymbols(),
    };
    const before = yield* fs
      .readFileString(file)
      .pipe(Effect.mapError((cause) => failure("invalid_path", cause.message)));
    // One random id per edit; the items it adds are numbered from it.
    const seed = yield* random.uuidV4();
    let serial = 0;
    const edited = yield* Effect.try({
      try: () =>
        applySchematicEdits(before, input.edits, {
          project: stem,
          uuid: () => `${seed.slice(0, 24)}${(serial++).toString(16).padStart(12, "0")}`,
          symbol: (libId) => {
            const [library = "", name = ""] = libId.split(":");
            return library === "jlc" || library === "power"
              ? libraries[library].get(name)
              : undefined;
          },
        }),
      catch: (cause) =>
        isEditError(cause)
          ? failure("invalid_argument", cause.message)
          : failure("command_failed", `The schematic could not be edited: ${String(cause)}`),
    });

    const author = input.by ?? "agent";
    const io = <A, E extends { readonly message: string }, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError((cause) => failure("command_failed", cause.message)));
    // KiCad reads the agent's result in a scratch copy of the project before the real file
    // changes. Edits by hand are saved at once, so the drawing answers right away; the
    // designer's Check runs KiCad on them.
    const verify = Effect.scoped(
      Effect.gen(function* () {
        const cli = yield* findCli();
        const temp = yield* io(fs.makeTempDirectoryScoped({ prefix: "kitty-sch-" }));
        const candidate = path.join(temp, `${stem}.kicad_sch`);
        yield* io(fs.writeFileString(candidate, edited.source));
        yield* fs
          .copyFile(path.join(directory, `${stem}.kicad_pro`), path.join(temp, `${stem}.kicad_pro`))
          .pipe(Effect.ignore);
        // The design's own libraries, so the check sees what KiCad will see.
        for (const table of ["sym-lib-table", "fp-lib-table"]) {
          yield* fs
            .copyFile(path.join(directory, table), path.join(temp, table))
            .pipe(Effect.ignore);
        }
        yield* fs.symlink(path.join(directory, "lib"), path.join(temp, "lib")).pipe(Effect.ignore);
        const netFile = path.join(temp, "out.net");
        const ercFile = path.join(temp, "erc.json");
        yield* runCli(
          cli,
          ["sch", "export", "netlist", "--format", "kicadsexpr", "-o", netFile, candidate],
          temp,
        ).pipe(
          Effect.mapError((error) =>
            failure(
              "command_failed",
              `KiCad could not read the edited schematic, so nothing was changed.\n${error.message}`,
            ),
          ),
        );
        yield* runCli(
          cli,
          ["sch", "erc", "--format", "json", "--severity-all", "-o", ercFile, candidate],
          temp,
        );
        const netText = yield* io(fs.readFileString(netFile));
        const ercText = yield* io(fs.readFileString(ercFile));
        return {
          netlist: yield* parseOrFail(() => parseNetlist(netText), "netlist"),
          erc: yield* parseOrFail(() => parseErcReport(ercText), "ERC report"),
        };
      }),
    );
    const checked = author === "agent" ? yield* verify : undefined;
    yield* io(fs.writeFileString(file, edited.source));
    const history = historyOf(file, before);
    history.undo.push({ source: before, summary: edited.summary });
    if (history.undo.length > HISTORY_LIMIT) history.undo.shift();
    history.redo.length = 0;
    history.current = edited.source;
    const review = reviews.get(file);
    if (author === "agent") {
      // Edits in a row are reviewed together, against the file before the first of them.
      const open = review && review.current === before ? review : undefined;
      reviews.set(file, {
        baseline: open?.baseline ?? before,
        summary: [...(open?.summary ?? []), ...edited.summary],
        current: edited.source,
      });
    } else {
      // Working on top of the agent's changes keeps them.
      reviews.delete(file);
    }
    // The agent hears what the user changed by hand since it last touched the schematic.
    const userChanges =
      author === "agent" ? userChangesSinceAgent(yield* readChanges(directory)) : [];
    yield* recordChange(directory, author, edited.summary);

    const warnings: Array<string> = [];
    const parts = edited.placed.map((part) => {
      const pins = checked ? componentPins(checked.netlist, part.reference) : [];
      // Power symbols and flags are not parts, so the netlist does not list them.
      const wantedNets = part.reference.startsWith("#") || !checked ? {} : part.nets;
      for (const [number, wanted] of Object.entries(wantedNets)) {
        const actual = pins.find((pin) => pin.pin === number)?.net;
        if (wanted.trim() !== "" && actual !== wanted && actual !== `/${wanted}`) {
          warnings.push(
            `${part.reference} pin ${number} is on ${actual ?? "no net"}, not ${wanted}.`,
          );
        }
      }
      return {
        reference: part.reference,
        symbol: part.symbol,
        at: part.at,
        pins: pins.map((pin) => ({
          number: pin.pin,
          ...(pin.function ? { name: pin.function } : {}),
          ...(pin.connected ? { net: pin.net } : {}),
        })),
      };
    });
    return {
      schematic: relative,
      parts,
      removed: edited.removed,
      warnings,
      erc: {
        errors: checked?.erc.summary.errors ?? 0,
        warnings: checked?.erc.summary.warnings ?? 0,
      },
      checked: checked !== undefined,
      userChanges,
    } satisfies SchematicEditResult;
  });

  return KicadService.of({
    schematicEdit,
    schematicChanges,
    schematicHistory,
    schematicReview,
    boardSync,
    upgradeLibraries,
    boardModel,
    designStamp,
    designSource,
    preview,
    listDesigns,
    openInKicad,
    createBlankDesign,
    erc,
    drc,
    netlist,
    bom,
    fabExport,
    projectInspect,
    pinmapSync,
    pinCheck,
  });
});

export const layer = Layer.effect(KicadService, make());
