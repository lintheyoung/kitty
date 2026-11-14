import { describe, expect, it } from "vite-plus/test";

import { designerView } from "./designerView.ts";
import { designSteps } from "./designSteps.ts";

describe("designerView", () => {
  it("carries the selection, the step states and where each problem is", () => {
    const view = designerView({
      project: "hardware/kicad",
      drawing: "board",
      file: "hardware/kicad/led.kicad_pcb",
      selection: { ref: "R5", net: "/LED_PWM" },
      value: "10k",
      steps: designSteps({ parts: 12, footprints: 12, inside: 12, tracks: 40, unrouted: 2 }, "led"),
      problems: [
        {
          key: "a",
          severity: "error",
          title: "Clearance violation",
          subject: "C1",
          x: 10,
          y: 20.25,
        },
      ],
    });
    expect(view.selection).toEqual({ ref: "R5", value: "10k", net: "/LED_PWM" });
    expect(view.steps).toContain("Routing: 2 connections left");
    expect(view.steps.some((step) => step.startsWith("Requirements"))).toBe(false);
    expect(view.problems).toEqual(["error: Clearance violation, C1 at (10.0, 20.3)"]);
    expect(view.problemCount).toBe(1);
  });

  it("leaves the selection out when nothing is picked", () => {
    const view = designerView({ project: "hw", drawing: "schematic", steps: [], problems: [] });
    expect(view.selection).toBeUndefined();
    expect(view.file).toBeUndefined();
  });
});
