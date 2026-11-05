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
  HardwareToolError,
  HardwarePinCheckInput,
  HardwarePinCheckResult,
  HardwarePinmapSyncInput,
  HardwarePinmapSyncResult,
  HardwareProjectInspectInput,
  HardwareProjectInspectResult,
  KicadBomInput,
  KicadBomResult,
  KicadDrcInput,
  KicadDrcResult,
  KicadErcInput,
  KicadErcResult,
  KicadFabExportInput,
  KicadFabExportResult,
  KicadNetlistInput,
  KicadNetlistResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
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

const KicadErcTool = Tool.make("kicad_erc", {
  description:
    "Run KiCad's electrical rules check on a schematic. Returns counts per check and the violations (errors first, max 100) with the symbol, pin and position involved.",
  parameters: KicadErcInput,
  success: KicadErcResult,
  failure: HardwareFailure,
  dependencies: kicadDependencies,
})
  .annotate(Tool.Title, "Check schematic (ERC)")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const KicadDrcTool = Tool.make("kicad_drc", {
  description:
    "Run KiCad's design rules check on a board, by default also against the schematic. Returns counts per check, violations (errors first, max 100), unconnected items and board/schematic mismatches.",
  parameters: KicadDrcInput,
  success: KicadDrcResult,
  failure: HardwareFailure,
  dependencies: kicadDependencies,
})
  .annotate(Tool.Title, "Check board (DRC)")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

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

const KicadBomTool = Tool.make("kicad_bom", {
  description:
    "Bill of materials from a schematic, grouped by value and footprint, with LCSC/MPN fields. Lists parts that have no LCSC or MPN.",
  parameters: KicadBomInput,
  success: KicadBomResult,
  failure: HardwareFailure,
  dependencies: kicadDependencies,
})
  .annotate(Tool.Title, "Read bill of materials")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const KicadFabExportTool = Tool.make("kicad_fab_export", {
  description:
    "Export a board's fabrication files: Gerbers for every copper layer plus mask, paste, silkscreen and outline, Excellon drill, a CSV position file, and a zip of Gerbers + drill ready to upload to a PCB fab. Run kicad_drc first.",
  parameters: KicadFabExportInput,
  success: KicadFabExportResult,
  failure: HardwareFailure,
  dependencies: kicadDependencies,
})
  .annotate(Tool.Title, "Export fabrication files")
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
  KicadErcTool,
  KicadDrcTool,
  KicadNetlistTool,
  KicadBomTool,
  KicadFabExportTool,
  HardwareProjectInspectTool,
  HardwarePinmapSyncTool,
  HardwarePinCheckTool,
);
