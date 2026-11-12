import { assert, it } from "vite-plus/test";

import { modelPath, seatModel, wrlExtent } from "./modelPlacement.ts";

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

it("measures a model from above in millimetres", () => {
  const wrl = "coord Coordinate { point [ -1 -2 0, 1 2 0.5,\n 0 0 1 ] }";
  assert.deepEqual(wrlExtent(wrl), { minX: -2.54, maxX: 2.54, minY: -5.08, maxY: 5.08 });
  assert.equal(wrlExtent("#VRML V2.0 utf8"), undefined);
});

it("slides a model onto the body it is the size of", () => {
  // Turned half round the connector lands on y -5..2.8, but its body is drawn on y -2.3..5.1.
  const model = { minX: -4.5, maxX: 4.5, minY: -5, maxY: 2.8 };
  assert.equal(seatModel(footprint(180, "0 0"), model), footprint(180, "0 -2.5"));
  assert.equal(modelPath(footprint(180, "0 0")), "${KIPRJMOD}/lib/jlc.3dshapes/USB-C.wrl");
});

it("leaves alone what sits right or what it cannot tell", () => {
  const model = { minX: -4.5, maxX: 4.5, minY: -5, maxY: 2.8 };
  // Already on its body, already offset by hand, turned sideways, or far bigger than the body.
  assert.equal(seatModel(footprint(0, "0 0", -2.9, 5), model), footprint(0, "0 0", -2.9, 5));
  assert.equal(seatModel(footprint(180, "0 1"), model), footprint(180, "0 1"));
  assert.equal(seatModel(footprint(90, "0 0"), model), footprint(90, "0 0"));
  const leaded = { minX: -9, maxX: 9, minY: -5, maxY: 2.8 };
  assert.equal(seatModel(footprint(180, "0 0"), leaded), footprint(180, "0 0"));
  assert.equal(seatModel(footprint(180, "0 0"), undefined), footprint(180, "0 0"));
  assert.equal(seatModel("(footprint)", model), "(footprint)");
});
