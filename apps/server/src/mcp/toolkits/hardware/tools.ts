import {
  HardwareDoctorInput,
  HardwareDoctorReport,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as HardwareService from "../../../hardware/HardwareService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const HardwareDoctorTool = Tool.make("hw_doctor", {
  description:
    "Check this machine's Kitty hardware toolchain: ESP-IDF (v5.5 supported), its Python env, esptool, KiCad 10 `kicad-cli`, and connected serial ports. Call first when a build, flash, or KiCad step fails or before starting hardware work.",
  parameters: HardwareDoctorInput,
  success: HardwareDoctorReport,
  failure: OrchestratorMcpFailure,
  dependencies: [McpInvocationContext.McpInvocationContext, HardwareService.HardwareService],
})
  .annotate(Tool.Title, "Check hardware toolchain")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const HardwareToolkit = Toolkit.make(HardwareDoctorTool);
