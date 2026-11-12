import { assert, it } from "vite-plus/test";

import { boardEditJob, boardRouting, parseBoardReport } from "./boardEdit.ts";

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
    keepouts: [],
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

const pad = (number: number, x: number, net: string) =>
  `(pad "${number}" smd rect (at ${x} 0) (size 1 1) (layers "F.Cu") (net "${net}"))`;
const boardWith = (...copper: ReadonlyArray<string>) => `(kicad_pcb (version 20241229)
  (footprint "R" (layer "F.Cu") (at 10 10) (property "Reference" "R1")
    ${pad(1, 0, "/SDA")} ${pad(2, 4, "GND")})
  (footprint "R" (layer "F.Cu") (at 30 10) (property "Reference" "R2")
    ${pad(1, 0, "/SDA")} ${pad(2, 4, "GND")})
  ${copper.join("\n  ")})`;

it("lists what is left to route and describes the nets asked about", () => {
  const open = boardRouting(boardWith(), ["SDA"]);
  assert.deepEqual(open.toRoute, [
    { net: "/SDA", from: "R1.1", to: "R2.1" },
    { net: "GND", from: "R1.2", to: "R2.2" },
  ]);
  assert.equal(open.unrouted, 2);
  assert.deepEqual(open.nets, [
    {
      net: "SDA",
      pads: [
        { pad: "R1.1", at: { x: 10, y: 10 }, side: "front" },
        { pad: "R2.1", at: { x: 30, y: 10 }, side: "front" },
      ],
      tracks: [],
      vias: [],
    },
  ]);

  const routed = boardRouting(
    boardWith(
      '(segment (start 10 10) (end 30 10) (width 0.2) (layer "F.Cu") (net "/SDA") (uuid "t1"))',
    ),
    ["/SDA"],
  );
  assert.deepEqual(routed.toRoute, [{ net: "GND", from: "R1.2", to: "R2.2" }]);
  assert.deepEqual(routed.nets[0]?.tracks, [
    { id: "t1", layer: "F.Cu", width: 0.2, from: { x: 10, y: 10 }, to: { x: 30, y: 10 } },
  ]);
});
