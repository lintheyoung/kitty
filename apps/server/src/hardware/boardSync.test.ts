import { assert, it } from "vite-plus/test";

import {
  boardSyncPlan,
  footprintLibraries,
  kicadPythonCandidates,
  parseSyncReport,
} from "./boardSync.ts";

const comp = (ref: string, footprint: string, id: string, group?: string) => `
    (comp (ref "${ref}") (value "10k") ${footprint ? `(footprint "${footprint}")` : ""}
      (fields (field (name "LCSC Part") "C25804") (field (name "Footprint") "x")
        ${group ? `(field (name "Group") "${group}")` : ""})
      (sheetpath (names "/") (tstamps "/"))
      (tstamps "${id}"))`;

const NETLIST = `(export (version "E")
  (components
    ${comp("R10", "jlc:R0603", "aaa", "Power")}
    ${comp("U1", "jlc:SOT-223", "bbb", "MCU")}
    ${comp("R2", "jlc:R0603", "ccc", "Power")}
    ${comp("TP1", "", "ddd")})
  (nets
    (net (code "1") (name "+3V3") (node (ref "R2") (pin "1")) (node (ref "U1") (pin "2")))
    (net (code "2") (name "/SDA") (node (ref "R2") (pin "2")))))`;

it("plans the board from a netlist, block by block", () => {
  const plan = boardSyncPlan(NETLIST);
  assert.deepEqual(
    plan.components.map((part) => part.ref),
    ["U1", "R2", "R10"],
  );
  assert.deepEqual(plan.components[1], {
    ref: "R2",
    value: "10k",
    footprint: "jlc:R0603",
    path: "/ccc",
    pads: { "1": "+3V3", "2": "/SDA" },
    fields: { "LCSC Part": "C25804", Group: "Power" },
  });
  assert.deepEqual(plan.withoutFootprint, ["TP1"]);
});

it("finds footprint libraries in the design first, then in KiCad", () => {
  const table = `(fp_lib_table (version 7)
    (lib (name "jlc")(type "KiCad")(uri "\${KIPRJMOD}/lib/jlc.pretty")(options "")(descr "")))`;
  assert.deepEqual(footprintLibraries(table, "/work/hw", ["jlc", "Resistor_SMD"], ["/kicad/fp"]), {
    jlc: ["/work/hw/lib/jlc.pretty", "/kicad/fp/jlc.pretty"],
    Resistor_SMD: ["/kicad/fp/Resistor_SMD.pretty"],
  });
  assert.deepEqual(footprintLibraries("not a table (", "/work/hw", ["jlc"], []), { jlc: [] });
});

it("looks for KiCad's Python beside its CLI", () => {
  assert.deepEqual(
    kicadPythonCandidates(
      { KITTY_KICAD_PYTHON: "/opt/py" },
      "/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli",
    ),
    [
      "/opt/py",
      "/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/Current/bin/python3",
      "python3",
    ],
  );
  assert.deepEqual(kicadPythonCandidates({}, "kicad-cli"), ["python3"]);
});

it("reads the report the script ends with", () => {
  const out = `some assert noise\nKITTY_SYNC {"added":["R10","R2"],"updated":[],"removed":["C1"],"missing":[{"ref":"U9","footprint":"x:y"}]}\n`;
  assert.deepEqual(parseSyncReport(out), {
    added: ["R2", "R10"],
    updated: [],
    removed: ["C1"],
    missing: [{ ref: "U9", footprint: "x:y" }],
  });
  assert.equal(parseSyncReport("Traceback (most recent call last):"), undefined);
});
