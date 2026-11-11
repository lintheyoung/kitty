import { expect, it } from "vite-plus/test";

import { boardSyncSummary } from "./boardSyncSummary.ts";

const result = {
  board: "b.kicad_pcb",
  added: [],
  updated: [],
  removed: [],
  missing: [],
  withoutFootprint: [],
  parts: 3,
};

it("says what an update from the schematic did", () => {
  expect(boardSyncSummary(result)).toBe("The board already matches the schematic.");
  expect(
    boardSyncSummary({
      ...result,
      added: ["R1", "R2"],
      removed: ["C1"],
      missing: [{ ref: "U3", footprint: "x:y" }],
      withoutFootprint: ["TP1"],
    }),
  ).toBe(
    "Board updated: added 2 parts, removed 1 part. No footprint found for U3. No footprint chosen for TP1.",
  );
});
