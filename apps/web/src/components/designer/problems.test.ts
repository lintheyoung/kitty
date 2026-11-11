import type { KicadDrcResult, KicadErcResult, KicadViolation } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boardProblems, countProblems, sheetProblems } from "./problems.ts";

const violation = (over: Partial<KicadViolation>): KicadViolation => ({
  type: "pin_not_connected",
  severity: "error",
  description: "Pin not connected",
  items: [{ description: "U1 pin 2", x: 10, y: 20 }],
  ...over,
});
const summary = { errors: 0, warnings: 0, byType: [] };

describe("sheetProblems", () => {
  const erc: KicadErcResult = {
    schematic: "a.kicad_sch",
    summary,
    truncated: false,
    violations: [
      violation({ sheet: "/" }),
      violation({ sheet: "/power/", severity: "warning", type: "unknown_check", items: [] }),
      violation({ sheet: "/", severity: "exclusion" }),
    ],
  };

  it("keeps each sheet's problems on that sheet and drops exclusions", () => {
    const root = sheetProblems(erc, "Schematic", true);
    expect(root).toHaveLength(1);
    expect(root[0]).toMatchObject({ severity: "error", subject: "U1 pin 2", x: 10, y: 20 });
    expect(root[0]?.hint).toContain("not wired");
    const power = sheetProblems(erc, "power", false);
    // An unknown check has no hint, and a problem without a position has no marker.
    expect(power).toHaveLength(1);
    expect(power[0]?.hint).toBeUndefined();
    expect(power[0]?.x).toBeUndefined();
    expect(sheetProblems(undefined, "Schematic", true)).toEqual([]);
  });
});

describe("boardProblems", () => {
  it("lists rule violations, unrouted nets and schematic mismatches together", () => {
    const drc: KicadDrcResult = {
      board: "a.kicad_pcb",
      summary,
      truncated: false,
      violations: [violation({ type: "clearance" })],
      unconnected: [violation({ type: "unconnected_items" })],
      schematicParity: [violation({ type: "missing_footprint", severity: "warning", items: [] })],
    };
    const problems = boardProblems(drc);
    expect(problems.map((problem) => problem.key)).toEqual(["drc:0", "unconnected:0", "parity:0"]);
    expect(countProblems(problems)).toEqual({ errors: 2, warnings: 1 });
  });
});
