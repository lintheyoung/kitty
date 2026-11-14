import { describe, expect, it } from "vite-plus/test";

import { describeDesignerView, designerViewNote, rememberDesignerView } from "./designerView.ts";

const view = {
  project: "hardware/kicad",
  drawing: "board" as const,
  file: "hardware/kicad/led.kicad_pcb",
  selection: { ref: "R5", value: "10k", net: "LED_PWM" },
  steps: ["Routing: 2 connections left"],
  problemCount: 10,
  problems: Array.from({ length: 10 }, (_, index) => `error: clearance, C${index}`),
};

describe("describeDesignerView", () => {
  it("names the drawing, the selection, the steps and the first problems", () => {
    const note = describeDesignerView(view);
    expect(note).toContain("the board of hardware/kicad (hardware/kicad/led.kicad_pcb)");
    expect(note).toContain("Selected: R5 (10k), net LED_PWM.");
    expect(note).toContain("Steps: Routing: 2 connections left.");
    expect(note).toContain("Problems listed (10):");
    expect(note).toContain("- error: clearance, C7");
    expect(note).not.toContain("C8");
    expect(note).toContain("- and 2 more");
  });

  it("says so when nothing is selected and nothing is wrong", () => {
    const note = describeDesignerView({
      project: "hw",
      drawing: "schematic",
      steps: [],
      problemCount: 0,
      problems: [],
    });
    expect(note).toContain("Nothing is selected.");
    expect(note).toContain("The checks list no problems.");
  });
});

describe("designerViewNote", () => {
  it("gives the thread's view until it is cleared or grows stale", () => {
    rememberDesignerView("thread-a", view, 1_000);
    expect(designerViewNote("thread-a", 2_000)).toContain("<designer_view>");
    expect(designerViewNote("thread-b", 2_000)).toBeUndefined();
    expect(designerViewNote("thread-a", 1_000 + 31 * 60 * 1000)).toBeUndefined();
    rememberDesignerView("thread-a", null, 3_000);
    expect(designerViewNote("thread-a", 3_500)).toBeUndefined();
  });
});
