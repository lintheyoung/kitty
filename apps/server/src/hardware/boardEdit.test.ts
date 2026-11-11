import { assert, it } from "vite-plus/test";

import { boardEditJob, parseBoardReport } from "./boardEdit.ts";

const part = (reference: string) => ({
  reference,
  value: "10k",
  at: { x: 1, y: 2 },
  rotation: 0,
  side: "front" as const,
  width: 3,
  height: 1.5,
  pads: 2,
  group: "",
  inside: true,
});

it("reads the board the script reports", () => {
  const report = {
    summary: ["Moved R1"],
    outline: null,
    parts: [part("R10"), part("R2")],
    overlaps: [["R2", "R10"]],
  };
  const parsed = parseBoardReport(`noise\nKITTY_BOARD ${JSON.stringify(report)}\n`);
  assert.deepEqual(parsed, {
    summary: ["Moved R1"],
    parts: [part("R2"), part("R10")],
    overlaps: [["R2", "R10"]],
  });
  assert.deepEqual(parseBoardReport('KITTY_BOARD {"error":"U9 is not on the board."}'), {
    error: "U9 is not on the board.",
  });
  assert.equal(parseBoardReport("Traceback"), undefined);
});

it("writes the job for the script", () => {
  assert.equal(
    boardEditJob("/b.kicad_pcb", [{ op: "move", reference: "R1", by: { x: 1, y: 0 } }]),
    '{"board":"/b.kicad_pcb","edits":[{"op":"move","reference":"R1","by":{"x":1,"y":0}}]}',
  );
});
