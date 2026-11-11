import { describe, expect, it } from "vite-plus/test";

import { buildBoardScene } from "./boardScene.ts";
import { pickItem, sameNet } from "./pick.ts";
import { buildSchematicScene, schematicSubSheets } from "./schematicScene.ts";

// A resistor between a labelled wire and ground, rotated and mirrored like real sheets.
const lib = `(lib_symbols
  (symbol "Device:R" (pin_numbers (hide yes)) (pin_names (offset 0))
    (symbol "R_0_1" (rectangle (start -1 -2.5) (end 1 2.5) (stroke (width 0.25)) (fill (type none))))
    (symbol "R_1_1"
      (pin passive line (at 0 3.81 270) (length 1.27) (name "~") (number "1"))
      (pin passive line (at 0 -3.81 90) (length 1.27) (name "~") (number "2"))))
  (symbol "power:GND" (power) (pin_names (offset 0) (hide yes))
    (symbol "GND_0_1" (polyline (pts (xy 0 0) (xy 0 -1.27)) (stroke (width 0)) (fill (type none))))
    (symbol "GND_1_1" (pin power_in line (at 0 0 270) (length 0) (hide yes) (name "GND") (number "1"))))
  (symbol "power:PWR_FLAG" (power)
    (symbol "PWR_FLAG_1_1" (pin power_out line (at 0 0 90) (length 0) (name "pwr") (number "1")))))`;

const sheet = (body: string) => `(kicad_sch (version 20250114) ${lib} ${body})`;
const resistor = (ref: string, at: string, extra = "") =>
  `(symbol (lib_id "Device:R") (at ${at}) ${extra} (unit 1) (uuid "${ref}")
     (property "Reference" "${ref}" (at 0 0 0)) (property "Value" "10k" (at 0 0 0)))`;
const pinsOf = (source: string, ref: string) =>
  buildSchematicScene(source)
    .scene.items.find((item) => item.ref === ref)
    ?.pins?.map((pin) => [pin.number, pin.at.x, pin.at.y, pin.net]);

describe("buildSchematicScene", () => {
  it("places pins by rotating first, then mirroring", () => {
    // Unrotated: library Y points up, so pin 1 (y = 3.81) sits above the origin.
    expect(pinsOf(sheet(resistor("R1", "100 50 0")), "R1")).toEqual([
      ["1", 100, 46.19, "Net-(R1-1)"],
      ["2", 100, 53.81, "Net-(R1-2)"],
    ]);
    // 90° turns it counter-clockwise on screen: pin 1 points left.
    expect(pinsOf(sheet(resistor("R1", "100 50 90")), "R1")?.[0]).toEqual([
      "1",
      96.19,
      50,
      "Net-(R1-1)",
    ]);
    // Mirroring about the Y axis afterwards flips it to the right.
    expect(pinsOf(sheet(resistor("R1", "100 50 90", "(mirror y)")), "R1")?.[0]).toEqual([
      "1",
      103.81,
      50,
      "Net-(R1-1)",
    ]);
  });

  it("names nets from labels and power symbols, and joins wires that touch", () => {
    const source = sheet(`
      ${resistor("R1", "100 50 0")}
      (wire (pts (xy 100 46.19) (xy 100 40)) (uuid "w1"))
      (wire (pts (xy 90 40) (xy 110 40)) (uuid "w2"))
      (label "SDA" (at 95 40 0) (uuid "l1"))
      (wire (pts (xy 100 53.81) (xy 100 60)) (uuid "w3"))
      (symbol (lib_id "power:GND") (at 100 60 0) (unit 1) (uuid "g1")
        (property "Reference" "#PWR01" (at 0 0 0)) (property "Value" "GND" (at 0 0 0)))`);
    const scene = buildSchematicScene(source).scene;
    expect(pinsOf(source, "R1")?.map((pin) => pin[3])).toEqual(["SDA", "GND"]);
    // w1 ends in the middle of w2, which is enough to join them.
    expect(scene.items.find((item) => item.id === "w1")?.net).toBe("SDA");
    expect(scene.items.find((item) => item.id === "w3")?.net).toBe("GND");
  });

  it("keeps crossing wires apart unless a junction joins them", () => {
    const crossing = (junction: string) =>
      sheet(`
        (wire (pts (xy 0 10) (xy 20 10)) (uuid "h"))
        (wire (pts (xy 10 0) (xy 10 20)) (uuid "v"))
        (label "A" (at 0 10 0) (uuid "la")) (label "B" (at 10 0 0) (uuid "lb")) ${junction}`);
    const net = (source: string, id: string) =>
      buildSchematicScene(source).scene.items.find((item) => item.id === id)?.net;
    expect([net(crossing(""), "h"), net(crossing(""), "v")]).toEqual(["A", "B"]);
    const joined = crossing(`(junction (at 10 10) (uuid "j"))`);
    expect(net(joined, "h")).toBe(net(joined, "v"));
  });

  it("does not let power flags merge the nets they sit on", () => {
    const flag = (at: string, id: string) =>
      `(symbol (lib_id "power:PWR_FLAG") (at ${at}) (unit 1) (uuid "${id}")
         (property "Reference" "#FLG${id}" (at 0 0 0)) (property "Value" "PWR_FLAG" (at 0 0 0)))`;
    const source = sheet(`
      (wire (pts (xy 0 0) (xy 10 0)) (uuid "a")) (label "VIN" (at 0 0 0) (uuid "la"))
      (wire (pts (xy 0 20) (xy 10 20)) (uuid "b")) (label "VBAT" (at 0 20 0) (uuid "lb"))
      ${flag("10 0 0", "1")} ${flag("10 20 0", "2")}`);
    const scene = buildSchematicScene(source).scene;
    expect(scene.items.find((item) => item.id === "a")?.net).toBe("VIN");
    expect(scene.items.find((item) => item.id === "b")?.net).toBe("VBAT");
  });

  it("lists sub-sheets and rejects other files", () => {
    const source = `(kicad_sch (sheet (at 0 0) (size 20 10) (uuid "s")
      (property "Sheetname" "Power") (property "Sheetfile" "power.kicad_sch")))`;
    expect(schematicSubSheets(source)).toEqual([{ name: "Power", file: "power.kicad_sch" }]);
    expect(() => buildSchematicScene("(kicad_pcb)")).toThrow("Not a KiCad schematic");
  });
});

const board = `(kicad_pcb (version 20241229)
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (5 "F.SilkS" user) (25 "Edge.Cuts" user))
  (net 0 "") (net 1 "GND") (net 2 "/SDA")
  (footprint "Resistor_SMD:R_0603" (layer "F.Cu") (uuid "fp1") (at 10 10 90)
    (property "Reference" "R1" (at 0 -1.5 90) (layer "F.SilkS") (effects (font (size 1 1))))
    (property "Value" "10k" (at 0 1.5 90) (layer "F.Fab") (hide yes))
    (property "Description" "Resistor" (at 0 0 0) (hide yes))
    (pad "1" smd roundrect (at -0.8 0 90) (size 0.8 0.9) (layers "F.Cu" "F.Mask") (roundrect_rratio 0.25) (net 2 "/SDA") (uuid "p1"))
    (pad "2" smd roundrect (at 0.8 0 90) (size 0.8 0.9) (layers "F.Cu" "F.Mask") (net 1 "GND") (uuid "p2")))
  (segment (start 10 10.8) (end 10 20) (width 0.25) (layer "F.Cu") (net 2) (uuid "t1"))
  (via (at 10 20) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 2) (uuid "v1"))
  (zone (net 1) (net_name "GND") (layer "B.Cu") (uuid "z1")
    (polygon (pts (xy 0 0) (xy 30 0) (xy 30 30) (xy 0 30)))
    (filled_polygon (layer "B.Cu") (pts (xy 0 0) (xy 30 0) (xy 30 30) (xy 0 30))))
  (gr_rect (start 0 0) (end 30 30) (stroke (width 0.1)) (layer "Edge.Cuts") (uuid "e1")))`;

describe("buildBoardScene", () => {
  const scene = buildBoardScene(board);
  const item = (id: string) => scene.items.find((entry) => entry.id === id);

  it("places pads by the footprint's rotation and resolves their nets", () => {
    // The footprint is turned 90° counter-clockwise, so the pad at x = -0.8 ends up below it.
    const pad = item("p1");
    expect(pad?.net).toBe("/SDA");
    expect([(pad!.box.minX + pad!.box.maxX) / 2, (pad!.box.minY + pad!.box.maxY) / 2]).toEqual([
      10,
      expect.closeTo(10.8, 6),
    ]);
    expect(item("t1")?.net).toBe("/SDA");
    expect(item("z1")?.net).toBe("GND");
  });

  it("draws only fields that have a layer and are not hidden", () => {
    const texts = item("fp1")?.shapes.filter((shape) => shape.kind === "text");
    expect(texts?.map((shape) => (shape.kind === "text" ? shape.text : ""))).toEqual(["R1"]);
    expect(item("fp1")?.value).toBe("10k");
  });

  it("frames the board by its outline", () => {
    expect(scene.bounds).toMatchObject({ minX: -0.05, maxX: 30.05 });
    expect(scene.layers).toEqual(["F.Cu", "B.Cu", "F.SilkS", "Edge.Cuts"]);
  });

  it("picks the smallest precise thing under the pointer", () => {
    // Over the pad: the pad wins over its footprint and the zone below.
    expect(pickItem(scene, { x: 10, y: 10.8 }, 0.1)?.id).toBe("p1");
    expect(pickItem(scene, { x: 10, y: 15 }, 0.1)?.id).toBe("t1");
    expect(pickItem(scene, { x: 10, y: 20 }, 0.1)?.id).toBe("v1");
    expect(pickItem(scene, { x: 25, y: 25 }, 0.1)?.id).toBe("z1");
    // With back copper hidden, empty board picks nothing.
    const front = (entry: { layer?: string }) => entry.layer !== "B.Cu";
    expect(pickItem(scene, { x: 25, y: 25 }, 0.1, front)).toBeUndefined();
  });
});

describe("sameNet", () => {
  it("matches schematic names to the board's sheet-prefixed names", () => {
    expect(sameNet("SDA", "/SDA")).toBe(true);
    expect(sameNet("GND", "GND")).toBe(true);
    expect(sameNet("EN", "/power/EN")).toBe(true);
    expect(sameNet("VPP{slash}MCLR", "/VPP{slash}MCLR")).toBe(true);
    expect(sameNet("SDA", "/SDA2")).toBe(false);
    expect(sameNet("DA", "/SDA")).toBe(false);
  });
});
