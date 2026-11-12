import { assert, it } from "vite-plus/test";

import {
  boardModelPaths,
  modelPath,
  seatBoardModels,
  seatModel,
  stepExtent,
  wrlExtent,
} from "./modelPlacement.ts";

const footprint = (
  angle: number,
  offset: string,
  yardTop = -2.3,
  yardBottom = 5.1,
) => `(footprint "USB-C"
  (fp_line (start -4.5 ${yardTop}) (end 4.5 ${yardTop}) (layer "F.CrtYd"))
  (fp_line (start 4.5 ${yardTop}) (end 4.5 ${yardBottom}) (layer "F.CrtYd"))
  (fp_line (start -9 -9) (end 9 9) (layer "F.Fab"))
  (model "\${KIPRJMOD}/lib/jlc.3dshapes/USB-C.wrl"
    (offset (xyz ${offset} 0))
    (scale (xyz 1 1 1))
    (rotate (xyz 0 0 ${angle}))))`;

const mesh = { minX: -4.5, maxX: 4.5, minY: -5, maxY: 2.8, minZ: 0 };

it("measures a model in millimetres", () => {
  const wrl = "coord Coordinate { point [ -1 -2 0, 1 2 0.5,\n 0 0 1 ] }";
  assert.deepEqual(wrlExtent(wrl), { minX: -2.54, maxX: 2.54, minY: -5.08, maxY: 5.08, minZ: 0 });
  assert.equal(wrlExtent("#VRML V2.0 utf8"), undefined);
  const step = `#1 = CARTESIAN_POINT('', (-9., -12.75, -0.4));
#2 = CARTESIAN_POINT('', (9., 12.75, 3.));
#3 = CARTESIAN_POINT('', (99., 99., 99.));
#4 = VERTEX_POINT('', #1);
#5 = VERTEX_POINT('', #2);`;
  assert.deepEqual(stepExtent(step), { minX: -9, maxX: 9, minY: -12.75, maxY: 12.75, minZ: -0.4 });
  assert.equal(stepExtent(`${step}\n#6 = ITEM_DEFINED_TRANSFORMATION('', '', #1, #2);`), undefined);
});

it("slides a model onto the body it is the size of", () => {
  // Turned half round the connector lands on y -5..2.8, but its body is drawn on y -2.3..5.1.
  assert.equal(seatModel(footprint(180, "0 0"), { wrl: mesh }), footprint(180, "0 -2.5"));
  assert.equal(modelPath(footprint(180, "0 0")), "${KIPRJMOD}/lib/jlc.3dshapes/USB-C.wrl");
});

it("shows the solid where the converter put the mesh", () => {
  // The solid is centred on itself and half sunk; the mesh sits 3.7 mm up the footprint.
  const module = { minX: -9, maxX: 9, minY: -9.05, maxY: 16.45, minZ: 0 };
  const solid = { minX: -9, maxX: 9, minY: -12.75, maxY: 12.75, minZ: -0.4 };
  const before = footprint(0, "0 0", -16.45, 9.05);
  const after = before.replace("USB-C.wrl", "USB-C.step").replace("(xyz 0 0 0)", "(xyz 0 3.7 0.4)");
  assert.equal(seatModel(before, { wrl: module, step: solid }), after);
  // Seated once, it is no longer the converter's mesh and is left alone.
  assert.equal(seatModel(after, { wrl: module, step: solid }), after);
});

it("leaves alone what sits right or what it cannot tell", () => {
  // Already on its body, turned sideways, far bigger than the body, or not measured.
  assert.equal(
    seatModel(footprint(0, "0 0", -2.9, 5), { wrl: mesh }),
    footprint(0, "0 0", -2.9, 5),
  );
  assert.equal(seatModel(footprint(180, "0 -2.5"), { wrl: mesh }), footprint(180, "0 -2.5"));
  assert.equal(seatModel(footprint(90, "0 0"), { wrl: mesh }), footprint(90, "0 0"));
  const leaded = { ...mesh, minX: -9, maxX: 9 };
  assert.equal(seatModel(footprint(180, "0 0"), { wrl: leaded }), footprint(180, "0 0"));
  assert.equal(seatModel(footprint(180, "0 0"), {}), footprint(180, "0 0"));
  assert.equal(seatModel("(footprint)", { wrl: mesh }), "(footprint)");
});

it("seats the models of the parts already on a board", () => {
  const part = (offset: string, layer = "F.Cu") =>
    footprint(180, offset).replace('(footprint "USB-C"', `(footprint "USB-C" (layer "${layer}")`);
  const board = (...parts: ReadonlyArray<string>) =>
    `(kicad_pcb (gr_text "a (b" (at 1 2))\n  ${parts.join("\n  ")}\n  (segment (start 0 0)))`;
  const before = board(part("0 0"), part("0 0", "B.Cu"));
  assert.deepEqual(boardModelPaths(before), ["\${KIPRJMOD}/lib/jlc.3dshapes/USB-C.wrl"]);
  assert.equal(
    seatBoardModels(before, () => ({ wrl: mesh })),
    board(part("0 -2.5"), part("0 0", "B.Cu")),
  );
  assert.equal(
    seatBoardModels(before, () => ({})),
    before,
  );
});
