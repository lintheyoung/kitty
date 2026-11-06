import {
  CommandId,
  HardwareToolError,
  KITTY_PROJECT_SCHEMA_VERSION,
  ProjectId,
  type HardwareProjectNewInput,
  type HardwareProjectNewResult,
  type KittyBoard,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ProjectService from "../project/ProjectService.ts";
import * as HardwareService from "./HardwareService.ts";
import * as KicadService from "./KicadService.ts";

/** `KeyCAP v1` → `keycap-v1`, for the repository folder. */
export const folderName = (name: string) => slugify(name).replaceAll("_", "-");

/** `KeyCAP v1` → `keycap_v1`, for file names and ids. */
export function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || "board";
}

const GITIGNORE = `# Kitty hardware project
firmware/build/
firmware/managed_components/
firmware/sdkconfig.old
tests/*/build/
tests/*/managed_components/
tests/*/sdkconfig.old
hardware/kicad/*-backups/
hardware/kicad/fab/
hardware/kicad/*.lck
hardware/kicad/fp-info-cache
hardware/kicad/*.kicad_prl
.hardware/
.DS_Store
`;

/** KiCad files are text, but their diffs are machine noise; Gerber zips are binary. */
const GITATTRIBUTES = `*.kicad_sch text eol=lf linguist-generated
*.kicad_pcb text eol=lf linguist-generated
*.kicad_pro text eol=lf
*.kicad_sym text eol=lf
*.kicad_mod text eol=lf
*.zip binary
`;

const readme = (name: string, slug: string) => `# ${name}

ESP32-S3 hardware project created by Kitty.

| Path | What |
| --- | --- |
| \`hardware/kicad/${slug}.kicad_sch\` / \`.kicad_pcb\` | Schematic and board (KiCad 10). The schematic is the source of truth. |
| \`hardware/board.json\` | MCU, buses and peripherals, for the agent. |
| \`hardware/pinmap.json\` | GPIO to net, exported from the schematic (\`hw_pinmap_sync\`). |
| \`firmware/\` | ESP-IDF project. |
| \`manufacturing/\` | Gerber, drill, BOM and position files for the fab. |
| \`docs/\`, \`tests/\` | Notes and hardware tests. |
`;

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function projectJson(name: string, slug: string): string {
  return json({
    schema_version: KITTY_PROJECT_SCHEMA_VERSION,
    id: slug,
    name,
    target: "esp32s3",
    toolchain: { esp_idf: "5.5", kicad: "10" },
    paths: {
      schematic: `hardware/kicad/${slug}.kicad_sch`,
      board: `hardware/kicad/${slug}.kicad_pcb`,
      firmware: "firmware",
    },
  });
}

const boardJson = (board: KittyBoard) => json(board);

/**
 * Creates a product repository in the layout of PRD §6, hardware and
 * firmware side by side: a blank KiCad project, an ESP-IDF firmware for the
 * ESP32-S3, and the project files. `root` is absolute and must not exist.
 */
const scaffoldHardwareProject = Effect.fn("scaffoldHardwareProject")(function* (
  root: string,
  name: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hardware = yield* HardwareService.HardwareService;
  const kicad = yield* KicadService.KicadService;
  const failure = (code: HardwareToolError["code"], message: string) =>
    new HardwareToolError({ code, message });

  if (yield* fs.exists(root).pipe(Effect.orElseSucceed(() => false))) {
    return yield* failure("already_exists", `${root} already exists.`);
  }
  const slug = slugify(name);
  const write = (relative: string, text: string) =>
    fs.makeDirectory(path.dirname(path.join(root, relative)), { recursive: true }).pipe(
      Effect.andThen(fs.writeFileString(path.join(root, relative), text)),
      Effect.mapError((cause) => failure("command_failed", cause.message)),
    );

  yield* Effect.gen(function* () {
    const board: KittyBoard = {
      schema_version: KITTY_PROJECT_SCHEMA_VERSION,
      board_id: slug,
      name,
      mcu: { vendor: "Espressif", model: "ESP32-S3" },
      interfaces: {},
      peripherals: [],
    };
    yield* write("project.json", projectJson(name, slug));
    yield* write("hardware/board.json", boardJson(board));
    yield* write(".gitignore", GITIGNORE);
    yield* write(".gitattributes", GITATTRIBUTES);
    yield* write("README.md", readme(name, slug));
    yield* write("docs/.gitkeep", "");
    yield* write("tests/.gitkeep", "");
    yield* write("manufacturing/.gitkeep", "");
    yield* kicad.createBlankDesign(path.join(root, "hardware", "kicad"), slug, name);
    yield* hardware.createProject({ path: "firmware", directory: path.join(root, "firmware") });
  }).pipe(
    // A half-made project would block a retry with "already exists".
    Effect.tapError(() => fs.remove(root, { recursive: true }).pipe(Effect.ignore)),
  );

  const files = (yield* fs
    .readDirectory(root, { recursive: true })
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => [])))
    .filter(
      (file) =>
        !file.startsWith("firmware/build") &&
        !file.startsWith("firmware/main/") &&
        !file.endsWith(".gitkeep") &&
        file.includes("."),
    )
    .toSorted();
  return {
    schematic: `hardware/kicad/${slug}.kicad_sch`,
    board: `hardware/kicad/${slug}.kicad_pcb`,
    firmware: "firmware",
    files,
  };
});

/**
 * A new product: its own git repository holding hardware and firmware (a
 * monorepo), registered as a Kitty project so threads can work in it.
 */
export const createHardwareRepo = Effect.fn("createHardwareRepo")(function* (
  input: HardwareProjectNewInput & {
    /** The current project's root; without `location` the new repository goes beside it. */
    readonly nextTo: string;
  },
) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const projects = yield* ProjectService.ProjectService;
  const random = yield* SecureRandom.SecureRandom;
  const failure = (code: HardwareToolError["code"], message: string) =>
    new HardwareToolError({ code, message });

  const name = input.name.trim();
  if (!name) return yield* failure("invalid_argument", "Give the product a name.");
  const location = input.location?.trim() || path.dirname(input.nextTo);
  if (!path.isAbsolute(location)) {
    return yield* failure("invalid_path", `location must be an absolute path, not ${location}.`);
  }
  const info = yield* fs.stat(location).pipe(Effect.option);
  if (info._tag === "None" || info.value.type !== "Directory") {
    return yield* failure("invalid_path", `${location} is not a directory.`);
  }
  const root = path.join(location, folderName(name));
  const scaffold = yield* scaffoldHardwareProject(root, name);
  const committed = yield* (yield* HardwareService.HardwareService).initRepository(
    root,
    "Start the hardware project with Kitty",
  );
  const id = yield* random
    .uuidV4()
    .pipe(Effect.mapError((cause) => failure("command_failed", String(cause))));
  const registered = yield* projects
    .bootstrap({
      commandId: CommandId.make(`kitty-hardware-project:${id}`),
      projectId: ProjectId.make(id),
      title: name,
      workspaceRoot: root,
    })
    .pipe(
      Effect.mapError((cause) =>
        failure(
          "command_failed",
          `Created ${root}, but could not add it to Kitty: ${cause.message}`,
        ),
      ),
    );
  return {
    root,
    projectId: registered.project.id,
    ...scaffold,
    committed,
    next_steps: [
      "Open the new project in Kitty and start a thread there.",
      "Draw the schematic in KiCad (open the .kicad_pro), then run hw_pinmap_sync.",
      "Draw the board outline on Edge.Cuts in the PCB editor; until then DRC reports invalid_outline.",
      "Fill hardware/board.json with the buses and peripherals.",
      "Run hw_chip_info with the board connected, then hw_sdkconfig_set ESPTOOLPY_FLASHSIZE_<size> to match it.",
    ],
  } satisfies HardwareProjectNewResult;
});
