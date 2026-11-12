import { describe, expect, it } from "vite-plus/test";

import { currentStep, designSteps } from "./designSteps.ts";

const at = (facts: Parameters<typeof designSteps>[0]) =>
  currentStep(designSteps(facts, "hw/board.kicad_pro"))?.id;

describe("designSteps", () => {
  it("starts at the requirements and moves on as the design fills in", () => {
    expect(at({ parts: 0, footprints: 0, tracks: 0 })).toBe("requirements");
    expect(at({ parts: 5, footprints: 0, tracks: 0 })).toBe("placement");
    expect(at({ parts: 5, footprints: 3, tracks: 0 })).toBe("placement");
    // Parts beside the board, or a board with no outline, are not placed yet.
    expect(at({ parts: 5, footprints: 5, tracks: 0 })).toBe("placement");
    expect(at({ parts: 5, footprints: 5, inside: 2, tracks: 0 })).toBe("placement");
    const placed = { parts: 5, footprints: 5, inside: 5 };
    expect(at({ ...placed, tracks: 0 })).toBe("routing");
    expect(at({ ...placed, tracks: 9, unrouted: 2 })).toBe("routing");
    expect(at({ ...placed, tracks: 9 })).toBe("checks");
    expect(at({ ...placed, tracks: 9, errors: 3 })).toBe("checks");
    expect(at({ ...placed, tracks: 9, unrouted: 0, errors: 0 })).toBe("order");
  });

  it("says where each step stands", () => {
    const steps = designSteps({ parts: 5, footprints: 3, tracks: 4, unrouted: 1, errors: 2 }, "x");
    expect(steps.map((step) => step.status)).toEqual([
      "Say what the board should do",
      "5 parts",
      "3 of 5 on the board",
      "1 connection left",
      "2 errors",
      "Files for JLC",
    ]);
    expect(steps.every((step) => step.prompt)).toBe(true);
    const waiting = designSteps({ parts: 5, footprints: 5, tracks: 0 }, "x");
    expect(waiting[2]?.status).toBe("No board outline yet");
  });
});
