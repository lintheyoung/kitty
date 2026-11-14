import {
  HardwareBuildInput,
  HardwareBuildResult,
  HardwareChipInfo,
  HardwareChipInfoInput,
  HardwareDoctorInput,
  HardwareDoctorReport,
  HardwareFlashInput,
  HardwareFlashResult,
  HardwareMonitorReadInput,
  HardwareMonitorReadResult,
  HardwarePortsResult,
  HardwareResetInput,
  HardwareResetResult,
  HardwareProjectCreated,
  HardwareProjectCreateInput,
  HardwareSdkconfigGetInput,
  HardwareSdkconfigGetResult,
  HardwareSdkconfigSetInput,
  HardwareSdkconfigSetResult,
  HardwareSetTargetInput,
  HardwareSetTargetResult,
  HardwareTestFirmwareCreateInput,
  HardwareTestFirmwareCreateResult,
  HardwareTestRunInput,
  HardwareTestRunResult,
  HardwareToolError,
  HardwareProjectNewInput,
  HardwareProjectNewResult,
  HardwarePinCheckInput,
  HardwarePinCheckResult,
  HardwarePinmapSyncInput,
  HardwarePinmapSyncResult,
  HardwareProjectInspectInput,
  HardwareProjectInspectResult,
  SchematicChangesInput,
  SchematicChangesResult,
  DesignEngineInput,
  DesignEngineResult,
  KicadNetlistInput,
  KicadNetlistResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as HardwareService from "../../../hardware/HardwareService.ts";
import * as KicadService from "../../../hardware/KicadService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, HardwareService.HardwareService];
// actsAsCaller resolves the caller's thread; workspace paths resolve through its project.
const callerDependencies = [...dependencies, ThreadManagementService.ThreadManagementService];
const workspaceDependencies = [...callerDependencies, ProjectService.ProjectService, Path.Path];
const kicadDependencies = [
  McpInvocationContext.McpInvocationContext,
  KicadService.KicadService,
  ThreadManagementService.ThreadManagementService,
  ProjectService.ProjectService,
  Path.Path,
];
const HardwareFailure = Schema.Union([HardwareToolError, OrchestratorMcpFailure]);

const HardwareDoctorTool = Tool.make("hw_doctor", {
  description:
    "Check this machine's Kitty hardware toolchain: ESP-IDF (v5.5 supported), its Python env, esptool, KiCad 10 `kicad-cli`, and connected serial ports. Call first when a build, flash, or KiCad step fails or before starting hardware work.",
  parameters: HardwareDoctorInput,
  success: HardwareDoctorReport,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Title, "Check hardware toolchain")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const HardwareChipInfoTool = Tool.make("hw_chip_info", {
  description:
    "Read the connected board's chip, revision, MAC, USB mode and flash size with esptool. Resets the board. Use flashSize for hw_project_create.",
  parameters: HardwareChipInfoInput,
  success: HardwareChipInfo,
  failure: HardwareFailure,
  dependencies: callerDependencies,
})
  .annotate(Tool.Title, "Read board chip info")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const HardwareProjectCreateTool = Tool.make("hw_project_create", {
  description:
    "Create an ESP-IDF project in the workspace from an ESP-IDF example, set its chip target, and set its flash size. Then edit main/ and call hw_build.",
  parameters: HardwareProjectCreateInput,
  success: HardwareProjectCreated,
  failure: HardwareFailure,
  dependencies: workspaceDependencies,
})
  .annotate(Tool.Title, "Create ESP-IDF project")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

const HardwareBuildTool = Tool.make("hw_build", {
  description:
    "Build an ESP-IDF project with idf.py. Returns ok, compiler/linker/CMake diagnostics with file and line, and app size. Fix the first error and build again.",
  parameters: HardwareBuildInput,
  success: HardwareBuildResult,
  failure: HardwareFailure,
  dependencies: workspaceDependencies,
})
  .annotate(Tool.Title, "Build ESP-IDF project")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const HardwareSetTargetTool = Tool.make("hw_set_target", {
  description:
    "Switch an ESP-IDF project to another chip (idf.py set-target). Regenerates sdkconfig from sdkconfig.defaults, so options not recorded there are lost, and clears the build.",
  parameters: HardwareSetTargetInput,
  success: HardwareSetTargetResult,
  failure: HardwareFailure,
  dependencies: workspaceDependencies,
})
  .annotate(Tool.Title, "Set ESP-IDF chip target")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const HardwareSdkconfigGetTool = Tool.make("hw_sdkconfig_get", {
  description:
    "Read an ESP-IDF project's configuration (sdkconfig, as menuconfig shows it) by option names or a search. Up to 100 options per call.",
  parameters: HardwareSdkconfigGetInput,
  success: HardwareSdkconfigGetResult,
  failure: HardwareFailure,
  dependencies: workspaceDependencies,
})
  .annotate(Tool.Title, "Read ESP-IDF configuration")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const HardwareSdkconfigSetTool = Tool.make("hw_sdkconfig_set", {
  description:
    "Set ESP-IDF configuration options (like menuconfig) through Kconfig, which enforces dependencies and ranges. Returns which values were applied and which Kconfig rejected. For a choice, set the wanted entry to true. Rebuild afterwards.",
  parameters: HardwareSdkconfigSetInput,
  success: HardwareSdkconfigSetResult,
  failure: HardwareFailure,
  dependencies: workspaceDependencies,
})
  .annotate(Tool.Title, "Set ESP-IDF configuration")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const HardwarePortsTool = Tool.make("hw_ports", {
  description:
    "List serial ports with what each is (ESP32 native USB, CP210x, CH34x, FTDI), its USB serial number, and who is using it. Use the device as port in other hw_ tools.",
  parameters: Tool.EmptyParams,
  success: HardwarePortsResult,
  failure: HardwareFailure,
  dependencies: callerDependencies,
})
  .annotate(Tool.Title, "List serial ports")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const HardwareMonitorReadTool = Tool.make("hw_monitor_read", {
  description:
    "Read what the board prints on its serial port for a few seconds, by default right after a reset so you see the boot log and app_main output. Pass until to stop at an expected line. Use after hw_flash to check the firmware runs.",
  parameters: HardwareMonitorReadInput,
  success: HardwareMonitorReadResult,
  failure: HardwareFailure,
  dependencies: callerDependencies,
})
  .annotate(Tool.Title, "Read serial log")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

const HardwareResetTool = Tool.make("hw_reset", {
  description: "Reset the board (pulse EN through the serial port), restarting the firmware.",
  parameters: HardwareResetInput,
  success: HardwareResetResult,
  failure: HardwareFailure,
  dependencies: callerDependencies,
})
  .annotate(Tool.Title, "Reset board")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const HardwareFlashTool = Tool.make("hw_flash", {
  description:
    "Build if needed and flash an ESP-IDF project to the board. The user must allow it in Kitty's Hardware panel first, so tell them you are about to flash; the call waits up to 5 minutes for their answer. The first flash of a board saves a full flash backup. Then call hw_monitor_read to check it runs.",
  parameters: HardwareFlashInput,
  success: HardwareFlashResult,
  failure: HardwareFailure,
  dependencies: workspaceDependencies,
})
  .annotate(Tool.Title, "Flash firmware to board")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const DesignEngineTool = Tool.make("copper", {
  description:
    "Design the board with Copper, the KiCad engine Kitty uses from the schematic to the fab files: copper(path, tool, arguments). First read the worked examples of a tool with tool `copper_help`, arguments {tool: 'sch_apply'}. The loop: plan the blocks; draw the whole schematic in one `sch_apply` batch (place parts by `lcsc` number or `spec`, connect pins by name to net names, never by coordinates); fix what its ERC lists; `board_build` with the board's width and height (sync, outline, placement, routing, ground pour and DRC in one call); fix what its report lists with `pcb_place`, `pcb_route_guided` and `pcb_edit`; `verify`; `fab_export`. Tools: copper_status, project_create, project_summary, checkpoint, sch_apply, sch_read, sch_tidy, library, parts_search, parts_get, parts_import, parts_source_bom, parts_alternatives, verify, design_review, render, pcb_read, pcb_sync, pcb_setup, pcb_place, pcb_route, pcb_pour, pcb_edit, pcb_route_plan, pcb_route_guided, fab_export, export, board_build. Every result carries KiCad's ERC and DRC counts and a `fix` for each finding: trust those, not what you assume. Each reply also gives `userChanges` (what the user changed by hand since your last change, in the designer or in KiCad: read it first and do not undo it without asking), `state` (how much is drawn, placed, routed) and `images` (pictures this call saved; read a file to look at the sheet or the board, and call `render` when you need to see it). On the board: when auto placement cannot seat a part (a radio module on a small board), put it by hand with `pcb_place` moves and lock it, antenna end on a board edge, and keep copper out beside the antenna as well as under it; place decoupling at the pins it serves; route what matters first (USB pairs, crystals, supply) by a plan; when nets block each other change the order or rip those nets up; when a corner will not route, move parts or swap interchangeable pins rather than add vias. A clean DRC is not the end: read `pcb_read` with what ['elegance'] and fix its worst points. A footprint whose own holes break the fab rules needs another footprint, not a waiver.",
  parameters: DesignEngineInput,
  success: DesignEngineResult,
  failure: HardwareFailure,
  dependencies: kicadDependencies,
})
  .annotate(Tool.Title, "Copper")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const KicadNetlistTool = Tool.make("kicad_netlist", {
  description:
    "Read a schematic's components and connections. Pass component (e.g. U1) to get that part's pin-to-net table: use it to learn which MCU GPIO connects to which sensor, LED or button before writing firmware.",
  parameters: KicadNetlistInput,
  success: KicadNetlistResult,
  failure: HardwareFailure,
  dependencies: kicadDependencies,
})
  .annotate(Tool.Title, "Read schematic netlist")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const boardTestDependencies = [
  ...callerDependencies,
  ProjectService.ProjectService,
  Path.Path,
  FileSystem.FileSystem,
];

const HardwareTestFirmwareCreateTool = Tool.make("hw_test_firmware_create", {
  description:
    "Create Kitty's standard Board Test Firmware in tests/board-test (chip, flash, heap, I2C scan, IMU WHO_AM_I, GPIO loopback, supply voltage) and a starting tests/test-plan.yaml. I2C pins and devices come from hardware/board.json and pinmap.json. Edit the plan's cases, then run hw_test_run.",
  parameters: HardwareTestFirmwareCreateInput,
  success: HardwareTestFirmwareCreateResult,
  failure: HardwareFailure,
  dependencies: boardTestDependencies,
})
  .annotate(Tool.Title, "Create board test firmware")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

const HardwareTestRunTool = Tool.make("hw_test_run", {
  description:
    'Run a board test plan: build and flash its test firmware (the user must allow the flash in the Hardware panel, so tell them first), reset the board, read its {"kitty":"metric",...} JSON lines, judge every case, and save Markdown and JSON reports in tests/reports/. Returns pass/fail per case with the measured value.',
  parameters: HardwareTestRunInput,
  success: HardwareTestRunResult,
  failure: HardwareFailure,
  dependencies: boardTestDependencies,
})
  .annotate(Tool.Title, "Run board tests")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const HardwareProjectNewTool = Tool.make("hw_hardware_project_new", {
  description:
    "Start a new product as its own git repository, hardware and firmware together: a blank KiCad 10 project in hardware/kicad/, an ESP-IDF firmware for the ESP32-S3 in firmware/, manufacturing/, project.json and hardware/board.json, registered as a new Kitty project. By default it goes next to the current project. Use when the user wants a new board; for firmware only, use hw_project_create.",
  parameters: HardwareProjectNewInput,
  success: HardwareProjectNewResult,
  failure: HardwareFailure,
  dependencies: [
    ...kicadDependencies,
    HardwareService.HardwareService,
    FileSystem.FileSystem,
    SecureRandom.SecureRandom,
  ],
})
  .annotate(Tool.Title, "New hardware project")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

const SchematicChangesTool = Tool.make("sch_changes", {
  description:
    "The schematic's change log: what the user changed by hand in the designer and what you changed with sch_edit, oldest first. `userChanges` lists what the user did since your last edit. Call it before you plan changes to a schematic the user may have touched, and respect what they did.",
  parameters: SchematicChangesInput,
  success: SchematicChangesResult,
  failure: HardwareFailure,
  dependencies: kicadDependencies,
})
  .annotate(Tool.Title, "Schematic change log")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const HardwareProjectInspectTool = Tool.make("hw_project_inspect", {
  description:
    "Start here in a hardware project: finds the KiCad schematic and board, the ESP-IDF firmware, and hardware/board.json, pinmap.json and components.json, with field-level errors and next steps. Returns board.json and pinmap.json when valid.",
  parameters: HardwareProjectInspectInput,
  success: HardwareProjectInspectResult,
  failure: HardwareFailure,
  dependencies: kicadDependencies,
})
  .annotate(Tool.Title, "Inspect hardware project")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const HardwarePinmapSyncTool = Tool.make("hw_pinmap_sync", {
  description:
    "Export hardware/pinmap.json (each MCU GPIO, its net and what else is on it) and hardware/components.json from the schematic. Keeps hand-written function/notes, sources and alternates, and reports which GPIOs changed. Run after the schematic changes.",
  parameters: HardwarePinmapSyncInput,
  success: HardwarePinmapSyncResult,
  failure: HardwareFailure,
  dependencies: kicadDependencies,
})
  .annotate(Tool.Title, "Export pinmap from schematic")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const HardwarePinCheckTool = Tool.make("hw_pin_check", {
  description:
    "Check the firmware's pins against the schematic: GPIOs the firmware uses that are unconnected or not on the MCU, strapping and USB pins, and a pinmap.json that no longer matches the schematic. Run before flashing new pin assignments.",
  parameters: HardwarePinCheckInput,
  success: HardwarePinCheckResult,
  failure: HardwareFailure,
  dependencies: kicadDependencies,
})
  .annotate(Tool.Title, "Check firmware pins")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const HardwareToolkit = Toolkit.make(
  HardwareDoctorTool,
  HardwareChipInfoTool,
  HardwareProjectCreateTool,
  HardwareBuildTool,
  HardwareSetTargetTool,
  HardwareSdkconfigGetTool,
  HardwareSdkconfigSetTool,
  HardwarePortsTool,
  HardwareMonitorReadTool,
  HardwareResetTool,
  HardwareFlashTool,
  DesignEngineTool,
  KicadNetlistTool,
  SchematicChangesTool,
  HardwareProjectNewTool,
  HardwareProjectInspectTool,
  HardwarePinmapSyncTool,
  HardwarePinCheckTool,
  HardwareTestFirmwareCreateTool,
  HardwareTestRunTool,
);
