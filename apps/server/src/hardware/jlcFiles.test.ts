import { assert, it } from "vite-plus/test";

import { jlcBomCsv, jlcCplCsv, orderBlockers } from "./jlcFiles.ts";

it("writes the BOM in JLC's columns and leaves out unfitted parts", () => {
  const csv = jlcBomCsv([
    {
      refs: ["R1", "R2"],
      quantity: 2,
      value: '10k "1%"',
      footprint: "jlc:R0603",
      lcsc: "C25804",
      dnp: false,
    },
    { refs: ["J1"], quantity: 1, value: "Header", dnp: false },
    { refs: ["R9"], quantity: 1, value: "0R", footprint: "jlc:R0603", dnp: true },
  ]);
  assert.equal(
    csv,
    [
      "Comment,Designator,Footprint,LCSC Part #",
      '"10k ""1%""","R1,R2","R0603","C25804"',
      '"Header","J1","",""',
      "",
    ].join("\n"),
  );
});

it("turns KiCad's position file into JLC's placement file", () => {
  const kicad = [
    "Ref,Val,Package,PosX,PosY,Rot,Side",
    '"R1","2.2k","R0603",105.000000,-80.000000,90.000000,top',
    '"U3","A, B","SOT-23",12.5,-3.25,270.000000,bottom',
    "",
  ].join("\n");
  assert.equal(
    jlcCplCsv(kicad),
    [
      "Designator,Mid X,Mid Y,Layer,Rotation",
      '"R1","105.0000mm","-80.0000mm","Top","90"',
      '"U3","12.5000mm","-3.2500mm","Bottom","270"',
      "",
    ].join("\n"),
  );
});

it("says what keeps a board from being ordered", () => {
  assert.deepEqual(orderBlockers({ errors: 0, unconnected: 0 }), []);
  assert.deepEqual(orderBlockers({ errors: 2, unconnected: 1 }), [
    "1 connection is not routed",
    "2 DRC errors",
  ]);
});
