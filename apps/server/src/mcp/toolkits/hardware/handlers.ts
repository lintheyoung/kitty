import * as Effect from "effect/Effect";

import * as HardwareService from "../../../hardware/HardwareService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { HardwareToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(HardwareToolkit, {
  hw_doctor: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const hardware = yield* HardwareService.HardwareService;
      return yield* hardware.doctor(input);
    }),
  ),
});
