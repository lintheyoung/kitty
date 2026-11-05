import { describe, expect, it } from "vite-plus/test";

import {
  buildBom,
  componentPins,
  parseDrcReport,
  parseErcReport,
  parseNetlist,
  unescapeKicad,
} from "./kicadReports.ts";
import { parseSexpr } from "./sexpr.ts";

// Trimmed from real KiCad 10.0.7 reports (UI language: Chinese).
const ERC = JSON.stringify({
  $schema: "https://schemas.kicad.org/erc.v1.json",
  kicad_version: "10.0.7",
  sheets: [
    {
      path: "/",
      violations: [
        {
          description: "Pin not connected",
          items: [
            {
              description: "Symbol U1 引脚 2 [EN, 输入, 图线]",
              pos: { x: 104.14, y: 69.85 },
              uuid: "f654b2e2",
            },
          ],
          severity: "error",
          type: "pin_not_connected",
        },
        {
          description: "Label not connected",
          items: [{ description: "Label SDA", pos: { x: 1, y: 2 } }],
          severity: "warning",
          type: "label_dangling",
        },
        {
          description: "Pin not connected",
          items: [{ description: "Symbol U1 引脚 18 [IO0]", pos: { x: 3, y: 4 } }],
          severity: "error",
          type: "pin_not_connected",
        },
      ],
    },
  ],
});

const DRC = JSON.stringify({
  $schema: "https://schemas.kicad.org/drc.v1.json",
  kicad_version: "10.0.7",
  schematic_parity: [
    {
      description: "缺失的封装 U1 (ESP32-C3-WROOM-02)",
      items: [],
      severity: "warning",
      type: "missing_footprint",
    },
  ],
  unconnected_items: [],
  violations: [
    {
      description: "间距违规 ( 间距 0.2032 mm; 实际 0.1616 mm)",
      items: [
        { description: "走线 [CC1] (Bottom Layer), 长度: 2.4656 mm", pos: { x: -6.48, y: -40.5 } },
        { description: "Bottom Layer 上 R2 的焊盘 2 [GND]", pos: { x: -8.43, y: -39.94 } },
      ],
      severity: "error",
      type: "clearance",
    },
    { description: "丝印与铜皮重叠", items: [], severity: "warning", type: "silk_over_copper" },
  ],
});

// Shape of `kicad-cli sch export netlist --format kicadsexpr` (version "E").
const NETLIST = `(export
	(version "E")
	(components
		(comp
			(ref "U1")
			(value "ESP32-C3-WROOM-02")
			(footprint "RF_Module:ESP32-C3-WROOM-02")
			(fields
				(field
					(name "Footprint") "RF_Module:ESP32-C3-WROOM-02")
				(field
					(name "LCSC") "C2934560"))
			(property
				(name "Sheetname")
				(value "Demo"))
			(tstamps "9a8cf27f"))
		(comp
			(ref "R10")
			(value "10k")
			(footprint "Resistor_SMD:R_0402_1005Metric")
			(fields
				(field
					(name "LCSC Part #") "C25744")))
		(comp
			(ref "R2")
			(value "10k")
			(footprint "Resistor_SMD:R_0402_1005Metric")
			(fields
				(field
					(name "LCSC Part #") "C25744")))
		(comp
			(ref "R3")
			(value "4.7k")
			(footprint "Resistor_SMD:R_0402_1005Metric")
			(property
				(name "dnp")))
		(comp
			(ref "C1")
			(value "100n")
			(footprint "Capacitor_SMD:C_0402_1005Metric"))
		(comp
			(ref "TP1")
			(value "TestPoint")
			(property
				(name "exclude_from_bom"))))
	(nets
		(net
			(code "1")
			(name "GND")
			(class "Default")
			(node
				(ref "U1")
				(pin "19")
				(pinfunction "GND_19")
				(pintype "passive"))
			(node
				(ref "C1")
				(pin "2")
				(pintype "passive")))
		(net
			(code "2")
			(name "/LED")
			(node
				(ref "U1")
				(pin "3")
				(pinfunction "IO4")
				(pintype "bidirectional"))
			(node
				(ref "R2")
				(pin "1")
				(pintype "passive")))
		(net
			(code "3")
			(name "unconnected-(U1-IO20{slash}RXD-Pad11)")
			(node
				(ref "U1")
				(pin "11")
				(pinfunction "IO20{slash}RXD")
				(pintype "bidirectional")))))
`;

describe("parseSexpr", () => {
  it("reads lists, atoms and escaped strings", () => {
    expect(parseSexpr('(a (b "x \\"y\\"") c 1.5)')).toEqual(["a", ["b", 'x "y"'], "c", "1.5"]);
    expect(() => parseSexpr("(a (b)")).toThrow();
  });
});

describe("parseErcReport", () => {
  it("counts by check and lists errors first", () => {
    const report = parseErcReport(ERC);
    expect(report.kicadVersion).toBe("10.0.7");
    expect(report.summary).toEqual({
      errors: 2,
      warnings: 1,
      byType: [
        { type: "pin_not_connected", count: 2 },
        { type: "label_dangling", count: 1 },
      ],
    });
    expect(report.violations.map((violation) => violation.severity)).toEqual([
      "error",
      "error",
      "warning",
    ]);
    expect(report.violations[0]).toEqual({
      type: "pin_not_connected",
      severity: "error",
      description: "Pin not connected",
      sheet: "/",
      items: [{ description: "Symbol U1 引脚 2 [EN, 输入, 图线]", x: 104.14, y: 69.85 }],
    });
    expect(report.truncated).toBe(false);
  });

  it("caps the list at 100 but counts everything", () => {
    const violation = { description: "d", items: [], severity: "warning", type: "t" };
    const many = JSON.stringify({
      sheets: [{ path: "/", violations: Array(150).fill(violation) }],
    });
    const report = parseErcReport(many);
    expect(report.violations).toHaveLength(100);
    expect(report.summary.warnings).toBe(150);
    expect(report.truncated).toBe(true);
  });
});

it("parseDrcReport separates violations, unconnected items and schematic parity", () => {
  const report = parseDrcReport(DRC);
  expect(report.violations.map((violation) => violation.type)).toEqual([
    "clearance",
    "silk_over_copper",
  ]);
  expect(report.violations[0]?.items[1]).toEqual({
    description: "Bottom Layer 上 R2 的焊盘 2 [GND]",
    x: -8.43,
    y: -39.94,
  });
  expect(report.schematicParity.map((issue) => issue.type)).toEqual(["missing_footprint"]);
  expect(report.summary.errors).toBe(1);
  expect(report.summary.warnings).toBe(2);
});

describe("netlist", () => {
  const netlist = parseNetlist(NETLIST);

  it("reads components with user fields and flags", () => {
    expect(netlist.components[0]).toEqual({
      ref: "U1",
      value: "ESP32-C3-WROOM-02",
      footprint: "RF_Module:ESP32-C3-WROOM-02",
      fields: { LCSC: "C2934560" },
      dnp: false,
      excludeFromBom: false,
    });
    expect(netlist.components.find((component) => component.ref === "R3")?.dnp).toBe(true);
    expect(netlist.components.find((component) => component.ref === "TP1")?.excludeFromBom).toBe(
      true,
    );
  });

  it("maps a component's pins to nets", () => {
    expect(componentPins(netlist, "U1")).toEqual([
      {
        pin: "3",
        function: "IO4",
        type: "bidirectional",
        net: "/LED",
        connected: true,
        others: ["R2.1"],
      },
      {
        pin: "11",
        function: "IO20/RXD",
        type: "bidirectional",
        net: "unconnected-(U1-IO20/RXD-Pad11)",
        connected: false,
        others: [],
      },
      {
        pin: "19",
        function: "GND_19",
        type: "passive",
        net: "GND",
        connected: true,
        others: ["C1.2"],
      },
    ]);
  });

  it("groups the BOM and flags parts without a source", () => {
    const bom = buildBom(netlist.components, false);
    expect(bom.lines).toEqual([
      {
        refs: ["C1"],
        quantity: 1,
        value: "100n",
        footprint: "Capacitor_SMD:C_0402_1005Metric",
        dnp: false,
      },
      {
        refs: ["R2", "R10"],
        quantity: 2,
        value: "10k",
        footprint: "Resistor_SMD:R_0402_1005Metric",
        lcsc: "C25744",
        dnp: false,
      },
      {
        refs: ["U1"],
        quantity: 1,
        value: "ESP32-C3-WROOM-02",
        footprint: "RF_Module:ESP32-C3-WROOM-02",
        lcsc: "C2934560",
        dnp: false,
      },
    ]);
    expect(bom.totalParts).toBe(4);
    expect(bom.unsourced).toEqual(["C1"]);
    expect(buildBom(netlist.components, true).totalParts).toBe(5);
  });
});

it("drops KiCad 10's pin-number suffix only when a component uses it on every pin", () => {
  const text = (fn19: string, fn3: string) => `(export (components) (nets
    (net (name "GND") (node (ref "U1") (pin "19") (pinfunction "${fn19}")))
    (net (name "LED") (node (ref "U1") (pin "3") (pinfunction "${fn3}")))))`;
  const functions = (netlist: ReturnType<typeof parseNetlist>) =>
    netlist.nets.flatMap((net) => net.nodes.map((node) => node.function));
  expect(functions(parseNetlist(text("GND_19", "IO4_3")))).toEqual(["GND", "IO4"]);
  expect(functions(parseNetlist(text("GND", "GPIO_3")))).toEqual(["GND", "GPIO_3"]);
});

it("unescapes KiCad names", () => {
  expect(unescapeKicad("IO20{slash}RXD{colon}x{nope}")).toBe("IO20/RXD:x{nope}");
});
