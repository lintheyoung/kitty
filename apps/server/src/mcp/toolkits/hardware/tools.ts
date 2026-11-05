import {
  HardwareBuildInput,
  HardwareBuildResult,
  HardwareChipInfo,
  HardwareChipInfoInput,
  HardwareDoctorInput,
  HardwareDoctorReport,
  HardwareProjectCreated,
  HardwareProjectCreateInput,
  HardwareSdkconfigGetInput,
  HardwareSdkconfigGetResult,
  HardwareSdkconfigSetInput,
  HardwareSdkconfigSetResult,
  HardwareSetTargetInput,
  HardwareSetTargetResult,
  HardwareToolError,
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

export const HardwareToolkit = Toolkit.make(
  HardwareDoctorTool,
  HardwareChipInfoTool,
  HardwareProjectCreateTool,
  HardwareBuildTool,
  HardwareSetTargetTool,
  HardwareSdkconfigGetTool,
  HardwareSdkconfigSetTool,
  KicadErcTool,
  KicadDrcTool,
  KicadNetlistTool,
  KicadBomTool,
  KicadFabExportTool,
);
