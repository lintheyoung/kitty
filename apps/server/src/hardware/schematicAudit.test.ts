import { describe, expect, it } from "vite-plus/test";

import { auditSchematic } from "./schematicAudit.ts";

const part = (ref: string, value: string) => ({
  ref,
  value,
  fields: {},
  dnp: false,
  excludeFromBom: false,
});
const net = (name: string, ...nodes: ReadonlyArray<string>) => ({
  name,
  nodes: nodes.map((node) => {
    const [ref = "", pin = "", type] = node.split(".");
    return { ref, pin, ...(type ? { type } : {}) };
  }),
});

describe("auditSchematic", () => {
  it("passes chips that each have a capacitor on their supply", () => {
    const points = auditSchematic({
      components: [
        part("U1", "ESP32"),
        part("U2", "AMS1117"),
        part("C1", "100n"),
        part("C2", "10u"),
      ],
      nets: [
        net("+3V3", "U1.2.power_in", "U2.2.power_out", "C1.1", "C2.1"),
        net("GND", "U1.1.power_in", "U2.1.power_in", "C1.2", "C2.2"),
      ],
    });
    expect(points).toEqual([]);
  });

  it("names a supply with fewer capacitors than chips", () => {
    const points = auditSchematic({
      components: [part("U1", "ESP32"), part("U2", "AMS1117"), part("C1", "100n")],
      nets: [
        net("/+3V3", "U1.2.power_in", "U2.2.power_out", "C1.1"),
        net("GND", "U1.1.power_in", "U2.1.power_in", "C1.2"),
        net("VBUS", "U2.3.power_in", "J1.1"),
      ],
    });
    expect(points.map((point) => point.description)).toEqual([
      "2 chips (U1, U2) share +3V3 with 1 decoupling capacitor",
      "No decoupling capacitor on VBUS, which supplies U2",
    ]);
  });

  it("checks a crystal's load capacitors are there and alike", () => {
    const crystal = (c2: string, withC2 = true) =>
      auditSchematic({
        components: [part("Y1", "40MHz"), part("C1", "22pF"), part("C2", c2)],
        nets: [
          net("XTAL_P", "Y1.1", "U1.5", "C1.1"),
          net("XTAL_N", "Y1.3", "U1.6", ...(withC2 ? ["C2.1"] : [])),
          net("GND", "Y1.2", "Y1.4", "C1.2", "C2.2"),
        ],
      }).map((point) => point.description);
    expect(crystal("22p")).toEqual([]);
    expect(crystal("18p")).toEqual(["The load capacitors of Y1 differ: C1 is 22pF, C2 is 18p"]);
    expect(crystal("22p", false)).toEqual(["Y1 has no load capacitor on XTAL_N"]);
  });
});
