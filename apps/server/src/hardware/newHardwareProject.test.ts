import { expect, it } from "vite-plus/test";

import { hardwareProjectRoot, slugify } from "./newHardwareProject.ts";

it("names files after the board", () => {
  expect(slugify("KeyCAP v1")).toBe("keycap_v1");
  expect(slugify("  Blank Board!  ")).toBe("blank_board");
  expect(slugify("键帽")).toBe("board");
});

it("finds the hardware project a KiCad project belongs to", () => {
  expect(hardwareProjectRoot("keycap/hardware/kicad/keycap.kicad_pro")).toBe("keycap");
  expect(hardwareProjectRoot("hardware/kicad/keycap.kicad_pro")).toBe(".");
  expect(hardwareProjectRoot("kicad/openmicro/openmicro.kicad_pro")).toBe("kicad/openmicro");
});
