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
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

import * as ProcessRunner from "../processRunner.ts";
import { logTail } from "./buildOutput.ts";
import {
  buildBom,
  componentPins,
  parseDrcReport,
  parseErcReport,
  parseNetlist,
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
    /** Checks firmware pins and pinmap.json against the schematic. */
    readonly pinCheck: (
      input: InWorkspace<HardwarePinCheckInput>,
    ) => Effect.Effect<HardwarePinCheckResult, HardwareToolError>;
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

  return KicadService.of({
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
