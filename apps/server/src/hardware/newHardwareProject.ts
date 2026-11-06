import {
  HardwareToolError,
  KITTY_PROJECT_SCHEMA_VERSION,
  type HardwareProjectNewInput,
  type HardwareProjectNewResult,
  type KittyBoard,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as HardwareService from "./HardwareService.ts";
import * as KicadService from "./KicadService.ts";
import { resolveInWorkspace } from "./workspacePath.ts";

/**
 * The hardware project a KiCad project belongs to: the directory above
 * `hardware/` for Kitty's layout, else the KiCad project's own directory.
 */
export function hardwareProjectRoot(kicadProject: string): string {
  const parts = kicadProject.split("/");
  const index = parts.lastIndexOf("hardware");
  if (index >= 0) return parts.slice(0, index).join("/") || ".";
  return parts.slice(0, -1).join("/") || ".";
}

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
hardware/kicad/*-backups/
hardware/kicad/fab/
hardware/kicad/*.lck
hardware/kicad/fp-info-cache
.hardware/
`;

const readme = (name: string, slug: string) => `# ${name}

ESP32-S3 hardware project created by Kitty.

| Path | What |
| --- | --- |
| \`hardware/kicad/${slug}.kicad_sch\` / \`.kicad_pcb\` | Schematic and board (KiCad 10). The schematic is the source of truth. |
| \`hardware/board.json\` | MCU, buses and peripherals, for the agent. |
| \`hardware/pinmap.json\` | GPIO to net, exported from the schematic (\`hw_pinmap_sync\`). |
| \`firmware/\` | ESP-IDF project. |
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
 * Creates an empty hardware project in the layout of PRD §6: a blank KiCad
 * project, an ESP-IDF firmware for the ESP32-S3, and the project files.
 */
export const createHardwareProject = Effect.fn("createHardwareProject")(function* (
  input: HardwareProjectNewInput & { readonly workspaceRoot: string },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hardware = yield* HardwareService.HardwareService;
  const kicad = yield* KicadService.KicadService;
  const failure = (code: HardwareToolError["code"], message: string) =>
    new HardwareToolError({ code, message });

  const root = yield* resolveInWorkspace(input.workspaceRoot, input.path);
  if (yield* fs.exists(root).pipe(Effect.orElseSucceed(() => false))) {
    return yield* failure("already_exists", `${input.path} already exists.`);
  }
  const name = input.name?.trim() || path.basename(root);
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
    yield* write("README.md", readme(name, slug));
    yield* write("docs/.gitkeep", "");
    yield* write("tests/.gitkeep", "");
    yield* kicad.createBlankDesign(path.join(root, "hardware", "kicad"), slug, name);
    yield* hardware.createProject({
      path: path.join(input.path, "firmware"),
      directory: path.join(root, "firmware"),
    });
  }).pipe(
    // A half-made project would block a retry with "already exists".
    Effect.tapError(() => fs.remove(root, { recursive: true }).pipe(Effect.ignore)),
  );

  const rel = (relative: string) => path.relative(input.workspaceRoot, path.join(root, relative));
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
    root: rel("."),
    schematic: rel(`hardware/kicad/${slug}.kicad_sch`),
    board: rel(`hardware/kicad/${slug}.kicad_pcb`),
    firmware: rel("firmware"),
    files,
    next_steps: [
      "Draw the schematic in KiCad (open the .kicad_pro), then run hw_pinmap_sync.",
      "Draw the board outline on Edge.Cuts in the PCB editor; until then DRC reports invalid_outline.",
      "Fill hardware/board.json with the buses and peripherals.",
      "Run hw_chip_info with the board connected, then hw_sdkconfig_set ESPTOOLPY_FLASHSIZE_<size> to match it.",
    ],
  } satisfies HardwareProjectNewResult;
});
