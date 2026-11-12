import { describe, expect, it } from "vite-plus/test";

import { applySchematicEdits, type EditContext, SchematicEditError } from "./schematicEdit.ts";
import { buildSchematicScene } from "./schematicScene.ts";
import { type Node, parseDoc } from "./sexprDoc.ts";
import { librarySymbols } from "./symbolLibrary.ts";

const pin = (number: string, name: string, x: number, angle: number) => `
      (pin passive line (at ${x} 0 ${angle}) (length 2.54)
        (name "${name}") (number "${number}"))`;

// A two-pin part lying along X, and KiCad-style ground and supply symbols.
const LIBRARY = `(kicad_symbol_lib
  (symbol "R"
    (in_bom yes) (on_board yes)
    (property "Reference" "R" (at 0 2.54 0))
    (property "Value" "R" (at 0 -2.54 0))
    (property "LCSC Part" "C25804" (at 0 0 0) (hide yes))
    (property "ki_keywords" "res" (at 0 0 0) (hide yes))
    (symbol "R_0_1"
      (rectangle (start -2.54 1.016) (end 2.54 -1.016))${pin("1", "A", -5.08, 0)}${pin("2", "B", 5.08, 180)}
    )
  )
  (symbol "SW"
    (in_bom yes) (on_board yes)
    (property "Reference" "SW" (at 0 5.08 0))
    (property "Value" "SW" (at 0 -5.08 0))
    (symbol "SW_0_1"
      (rectangle (start -2.54 2.54) (end 2.54 -2.54))
      (pin passive line (at -5.08 1.27 0) (length 2.54) (name "A") (number "1"))
      (pin passive line (at 5.08 1.27 180) (length 2.54) (name "B") (number "2"))
      (pin passive line (at -5.08 -1.27 0) (length 2.54) (name "C") (number "3"))
      (pin passive line (at 5.08 -1.27 180) (length 2.54) (name "D") (number "4"))
    )
  )
  (symbol "GND"
    (power global)
    (property "Reference" "#PWR" (at 0 -6.35 0) (hide yes))
    (property "Value" "GND" (at 0 -3.81 0))
    (symbol "GND_1_1"
      (pin power_in line (at 0 0 270) (length 0) (name "") (number "1"))
    )
  )
  (symbol "+3V3"
    (power global)
    (property "Reference" "#PWR" (at 0 -3.81 0) (hide yes))
    (property "Value" "+3V3" (at 0 3.556 0))
    (symbol "+3V3_1_1"
      (pin power_in line (at 0 0 90) (length 0) (name "") (number "1"))
    )
  )
)`;

const BLANK = `(kicad_sch
\t(version 20260306)
\t(generator "eeschema")
\t(uuid "11111111-2222-3333-4444-555555555555")
\t(paper "A4")
\t(lib_symbols)
\t(sheet_instances
\t\t(path "/"
\t\t\t(page "1")
\t\t)
\t)
)
`;

function context(): EditContext {
  const symbols = new Map(
    librarySymbols(parseDoc(LIBRARY)).map((symbol) => [String(symbol[1]).slice(1, -1), symbol]),
  );
  let next = 0;
  return {
    project: "demo",
    uuid: () => `00000000-0000-0000-0000-${String(++next).padStart(12, "0")}`,
    symbol: (libId): ReadonlyArray<Node> | undefined => {
      const [library, name = ""] = libId.split(":");
      if (library === "jlc") return name === "R" || name === "SW" ? symbols.get(name) : undefined;
      return library === "power" && name !== "R" ? symbols.get(name) : undefined;
    },
  };
}

/** Net of each pin, as the designer's own connectivity resolves it. */
function netsOf(source: string): Record<string, string | undefined> {
  const nets: Record<string, string | undefined> = {};
  for (const item of buildSchematicScene(source).scene.items) {
    if (item.kind !== "symbol" || item.ref?.startsWith("#")) continue;
    for (const part of item.pins ?? []) nets[`${item.ref}.${part.number}`] = part.net;
  }
  return nets;
}

describe("schematic edits", () => {
  it("places parts and connects pins that share a net name", () => {
    const result = applySchematicEdits(
      BLANK,
      [
        { op: "place", symbol: "jlc:R", value: "10k", nets: { "1": "+3V3", "2": "EN" } },
        { op: "place", symbol: "jlc:R", rotation: 90, nets: { "1": "EN", "2": "GND" } },
      ],
      context(),
    );
    expect(result.placed.map((part) => part.reference)).toEqual(["R1", "R2"]);
    expect(netsOf(result.source)).toEqual({
      "R1.1": "+3V3",
      "R1.2": "EN",
      "R2.1": "EN",
      "R2.2": "GND",
    });
    expect(result.source).toContain('(lib_id "jlc:R")');
    expect(result.source).toContain('(property "Value" "10k"');
    expect(result.source).toContain('(property "LCSC Part" "C25804"');
    // Library-only fields stay in the embedded library symbol.
    expect(result.source.split("ki_keywords").length - 1).toBe(1);
    expect(result.source).toContain('(path "/11111111-2222-3333-4444-555555555555"');
    // Power symbols are numbered separately from parts.
    expect(result.source).toContain('(reference "#PWR02")');
  });

  it("keeps new parts clear of the ones already there", () => {
    const edits = Array.from({ length: 6 }, () => ({
      op: "place" as const,
      symbol: "jlc:R",
      nets: { "1": "A_LONG_NET_NAME", "2": "GND" },
    }));
    const { placed } = applySchematicEdits(BLANK, edits, context());
    for (const [index, part] of placed.entries()) {
      for (const other of placed.slice(index + 1)) {
        const apart =
          Math.abs(part.at.x - other.at.x) >= 20 || Math.abs(part.at.y - other.at.y) >= 10;
        expect(apart).toBe(true);
      }
    }
  });

  it("keeps the parts of a block together and the blocks apart", () => {
    const part = (group: string) => ({
      op: "place" as const,
      symbol: "jlc:R",
      group,
      nets: { "1": "+3V3", "2": "GND" },
    });
    const first = applySchematicEdits(BLANK, [part("Power"), part("MCU")], context());
    // More parts arrive later, in any order; each joins its own block.
    const result = applySchematicEdits(
      first.source,
      [part("Power"), part("MCU"), part("Power"), part("MCU")],
      {
        ...context(),
        uuid: (
          (n) => () =>
            `00000000-0000-0000-0001-${String(++n).padStart(12, "0")}`
        )(0),
      },
    );
    const at = Object.fromEntries(
      [...first.placed, ...result.placed].map((placed) => [placed.reference, placed.at]),
    );
    const far = (a: string, b: string) =>
      Math.hypot((at[a]?.x ?? 0) - (at[b]?.x ?? 0), (at[a]?.y ?? 0) - (at[b]?.y ?? 0));
    const power = ["R1", "R3", "R5"];
    const mcu = ["R2", "R4", "R6"];
    for (const a of power) {
      const nearestOwn = Math.min(...power.filter((b) => b !== a).map((b) => far(a, b)));
      const nearestOther = Math.min(...mcu.map((b) => far(a, b)));
      expect(nearestOwn).toBeLessThan(nearestOther);
    }
    // Each block is named once on the sheet, and every part remembers its block.
    expect(result.source.split('(text "Power"').length - 1).toBe(1);
    expect(result.source.split('(text "MCU"').length - 1).toBe(1);
    expect(result.source.split('(property "Group" "Power"').length - 1).toBe(3);
  });

  it("tidies the sheet into framed blocks without changing a connection", () => {
    const part = (group: string, nets: Record<string, string>) => ({
      op: "place" as const,
      symbol: "jlc:R",
      group,
      nets,
    });
    const drawn = applySchematicEdits(
      BLANK,
      [
        part("LED", { "1": "LED", "2": "LED_A" }),
        part("MCU", { "1": "+3V3", "2": "GND" }),
        part("Power", { "1": "EN", "2": "GND" }),
        part("Power", { "1": "+3V3", "2": "EN" }),
      ],
      context(),
    );
    const again = () => ({
      ...context(),
      uuid: (
        (n) => () =>
          `00000000-0000-0000-0002-${String(++n).padStart(12, "0")}`
      )(0),
    });
    const tidied = applySchematicEdits(drawn.source, [{ op: "tidy" }], again());
    expect(netsOf(tidied.source)).toEqual(netsOf(drawn.source));
    expect(tidied.summary).toEqual([
      "Tidied the schematic: 3 blocks framed and set in order, 4 parts aligned, on an A4 sheet",
    ]);
    // Blocks read from power in, through the controller, to what it drives.
    expect(tidied.source.split("(type dash)").length - 1).toBe(3);
    const titleAt = (name: string) =>
      Number(new RegExp(`\\(text "${name}"[\\s\\S]*?\\(at (\\S+) `).exec(tidied.source)?.[1]);
    expect(titleAt("Power")).toBeLessThan(titleAt("MCU"));
    expect(titleAt("MCU")).toBeLessThan(titleAt("LED"));
    // A part between a rail and ground stands with the rail up; one between signals lies flat.
    const turn = Object.fromEntries(tidied.placed.map((placed) => [placed.reference, placed]));
    expect(turn.R1?.rotation).toBe(0);
    expect(turn.R2?.rotation === 90 || turn.R2?.rotation === 270).toBe(true);
    // Tidying again changes nothing but the ids of what it redraws.
    const twice = applySchematicEdits(tidied.source, [{ op: "tidy" }], again());
    expect(twice.source).toBe(tidied.source);
  });

  it("leaves a block with wires drawn by hand as it is", () => {
    const drawn = applySchematicEdits(
      BLANK,
      [
        { op: "place", symbol: "jlc:R", group: "Hand", at: { x: 50.8, y: 50.8 } },
        {
          op: "wire",
          points: [
            { x: 55.88, y: 50.8 },
            { x: 76.2, y: 50.8 },
          ],
        },
        { op: "place", symbol: "jlc:R", group: "Auto", nets: { "1": "+3V3", "2": "GND" } },
      ],
      context(),
    );
    const tidied = applySchematicEdits(drawn.source, [{ op: "tidy" }], context());
    expect(tidied.summary.at(-1)).toBe(
      "Left Hand as drawn: wires drawn by hand would be pulled apart",
    );
    expect(tidied.placed.map((placed) => placed.reference)).toEqual(["R2"]);
    expect(() =>
      applySchematicEdits(
        applySchematicEdits(drawn.source, [{ op: "remove", reference: "R2" }], context()).source,
        [{ op: "tidy" }],
        context(),
      ),
    ).toThrow(SchematicEditError);
  });

  it("wires the small parts of a block together where they share a net", () => {
    const part = (group: string, nets: Record<string, string>) => ({
      op: "place" as const,
      symbol: "jlc:R",
      group,
      nets,
    });
    const drawn = applySchematicEdits(
      BLANK,
      [
        part("Buttons", { "1": "+3V3", "2": "EN" }),
        part("Buttons", { "1": "EN", "2": "GND" }),
        part("Buttons", { "1": "GND", "2": "EN" }),
        part("MCU", { "1": "+3V3", "2": "GND" }),
        part("MCU", { "1": "GND", "2": "+3V3" }),
        part("MCU", { "1": "IO4", "2": "IO5" }),
      ],
      context(),
    );
    const again = () => ({
      ...context(),
      uuid: (
        (n) => () =>
          `00000000-0000-0000-0003-${String(++n).padStart(12, "0")}`
      )(0),
    });
    const count = (text: string, token: string) => text.split(token).length - 1;
    const tidied = applySchematicEdits(drawn.source, [{ op: "tidy" }], again());
    expect(netsOf(tidied.source)).toEqual(netsOf(drawn.source));
    // One name for each shared net, where every pin had its own before.
    expect(count(drawn.source, '(label "EN"')).toBe(3);
    expect(count(tidied.source, '(label "EN"')).toBe(1);
    // Buttons: a rail above R1 and one ground under R2 and R3. MCU: one of each for the bank.
    expect(count(tidied.source, '(lib_id "power:+3V3")')).toBe(2);
    expect(count(tidied.source, '(lib_id "power:GND")')).toBe(2);
    expect(count(tidied.source, "(junction")).toBeGreaterThan(0);
    // The rail end of each part points up, whichever pin it is on.
    const turn = Object.fromEntries(tidied.placed.map((placed) => [placed.reference, placed]));
    expect(turn.R4?.rotation).not.toBe(turn.R5?.rotation);
    expect(turn.R6?.rotation).toBe(0);
    // Wires it drew itself are no reason to leave a block alone the next time.
    const twice = applySchematicEdits(tidied.source, [{ op: "tidy" }], again());
    expect(twice.source).toBe(tidied.source);

    // A part taken off its line keeps its nets, and so do the parts left on it.
    const moved = applySchematicEdits(
      tidied.source,
      [{ op: "move", reference: "R2", at: { x: 200, y: 150 } }],
      again(),
    );
    expect(netsOf(moved.source)).toEqual(netsOf(drawn.source));
    const removed = applySchematicEdits(
      tidied.source,
      [{ op: "remove", reference: "R4" }],
      again(),
    );
    const { "R4.1": _one, "R4.2": _two, ...rest } = netsOf(drawn.source);
    expect(netsOf(removed.source)).toEqual(rest);
  });

  it("wires a part with pins on its sides between the lines of its two nets", () => {
    const drawn = applySchematicEdits(
      BLANK,
      [
        { op: "place", symbol: "jlc:R", group: "Buttons", nets: { "1": "+3V3", "2": "EN" } },
        {
          op: "place",
          symbol: "jlc:SW",
          group: "Buttons",
          nets: { "1": "GND", "2": "GND", "3": "EN", "4": "EN" },
        },
      ],
      context(),
    );
    const tidied = applySchematicEdits(drawn.source, [{ op: "tidy" }], context());
    expect(netsOf(tidied.source)).toEqual(netsOf(drawn.source));
    const count = (text: string, token: string) => text.split(token).length - 1;
    // Both pins of each net reach one line, so each net is named once.
    expect(count(tidied.source, '(label "EN"')).toBe(1);
    expect(count(tidied.source, '(lib_id "power:GND")')).toBe(1);
    // The switch is turned over so that its EN pins are the upper ones.
    const turn = Object.fromEntries(tidied.placed.map((placed) => [placed.reference, placed]));
    expect(turn.SW1?.rotation).toBe(180);
    const twice = applySchematicEdits(tidied.source, [{ op: "tidy" }], context());
    expect(netsOf(twice.source)).toEqual(netsOf(drawn.source));
    expect(twice.placed).toEqual(tidied.placed);
  });

  it("moves a part with its connections and removes them with the part", () => {
    const placed = applySchematicEdits(
      BLANK,
      [
        { op: "place", symbol: "jlc:R", nets: { "1": "+3V3", "2": "SDA" } },
        { op: "place", symbol: "jlc:R", nets: { "1": "SDA", "2": "GND" }, noConnect: [] },
      ],
      context(),
    ).source;
    const moved = applySchematicEdits(
      placed,
      [{ op: "move", reference: "r1", at: { x: 150, y: 100 }, rotation: 90 }],
      context(),
    );
    expect(moved.placed[0]?.at).toEqual({ x: 149.86, y: 100.33 });
    expect(netsOf(moved.source)).toEqual(netsOf(placed));

    const removed = applySchematicEdits(
      moved.source,
      [{ op: "remove", reference: "R1" }],
      context(),
    );
    expect(removed.removed).toEqual(["R1"]);
    expect(netsOf(removed.source)).toEqual({ "R2.1": "SDA", "R2.2": "GND" });
    // R1's wires, label and power symbol went with it.
    const count = (text: string, token: string) => text.split(token).length - 1;
    expect(count(removed.source, "(wire")).toBe(2);
    expect(count(removed.source, '(lib_id "power:+3V3")')).toBe(0);
  });

  it("changes nets, values and references of a part on the sheet", () => {
    const placed = applySchematicEdits(
      BLANK,
      [{ op: "place", symbol: "jlc:R", nets: { "1": "+3V3", "2": "SDA" } }],
      context(),
    ).source;
    const result = applySchematicEdits(
      placed,
      [
        { op: "connect", reference: "R1", nets: { "2": "SCL" } },
        { op: "set", reference: "R1", property: "Value", value: "4.7k" },
        { op: "set", reference: "R1", property: "Reference", value: "R7" },
      ],
      context(),
    );
    expect(netsOf(result.source)).toEqual({ "R7.1": "+3V3", "R7.2": "SCL" });
    expect(result.source).toContain('(property "Value" "4.7k"');
    expect(result.source).toContain('(reference "R7")');
    expect(result.source).not.toContain('"SDA"');
  });

  it("slides and turns a part from where it is", () => {
    const placed = applySchematicEdits(
      BLANK,
      [{ op: "place", symbol: "jlc:R", at: { x: 50.8, y: 50.8 }, nets: { "1": "A", "2": "B" } }],
      context(),
    ).source;
    const moved = applySchematicEdits(
      placed,
      [
        { op: "move", reference: "R1", by: { x: 12.7, y: -2.54 } },
        { op: "move", reference: "R1", rotateBy: 90 },
        { op: "move", reference: "R1", rotateBy: 90 },
      ],
      context(),
    );
    expect(moved.placed.at(-1)).toMatchObject({ at: { x: 63.5, y: 48.26 }, rotation: 180 });
    expect(netsOf(moved.source)).toEqual({ "R1.1": "A", "R1.2": "B" });
  });

  it("draws wires between pins, joins them with junctions, and says what was done", () => {
    const placed = applySchematicEdits(
      BLANK,
      [
        { op: "place", symbol: "jlc:R", at: { x: 50.8, y: 50.8 } },
        { op: "place", symbol: "jlc:R", at: { x: 76.2, y: 50.8 } },
        { op: "place", symbol: "jlc:R", at: { x: 63.5, y: 63.5 }, rotation: 90 },
      ],
      context(),
    ).source;
    // R1 pin 2 is at (55.88, 50.8), R2 pin 1 at (71.12, 50.8), R3 pin 2 at (63.5, 58.42).
    const wired = applySchematicEdits(
      placed,
      [
        {
          op: "wire",
          points: [
            { x: 55.88, y: 50.8 },
            { x: 71.12, y: 50.8 },
          ],
        },
        {
          op: "wire",
          points: [
            { x: 63.5, y: 58.42 },
            { x: 63.5, y: 50.8 },
          ],
        },
        { op: "label", net: "MID", at: { x: 60.96, y: 50.8 } },
      ],
      context(),
    );
    expect(wired.summary).toEqual([
      "Drew a wire from R1 pin 2 (B) to R2 pin 1 (A)",
      "Drew a wire from R3 pin 2 (B) to (63.5, 50.8)",
      "Added the label MID at (60.96, 50.8)",
    ]);
    expect(wired.source.split("(junction").length - 1).toBe(1);
    expect(netsOf(wired.source)).toMatchObject({ "R1.2": "MID", "R2.1": "MID", "R3.2": "MID" });

    const wire = /\(wire[^]*?\(uuid "([^"]+)"\)/.exec(wired.source)?.[1] ?? "";
    const erased = applySchematicEdits(wired.source, [{ op: "erase", id: wire }], context());
    expect(erased.summary).toEqual(["Removed a wire at R1 pin 2 (B)"]);
    expect(erased.source.split("(wire").length - 1).toBe(1);
    expect(() =>
      applySchematicEdits(erased.source, [{ op: "erase", id: wire }], context()),
    ).toThrow(/no longer on the sheet/);
  });

  it("describes edits to parts for the change log", () => {
    const { summary } = applySchematicEdits(
      BLANK,
      [
        { op: "place", symbol: "jlc:R", value: "10k", nets: { "1": "+3V3", "2": "EN" } },
        { op: "connect", reference: "R1", nets: { "2": "BOOT", "1": "" }, noConnect: [] },
        { op: "set", reference: "R1", property: "Value", value: "4.7k" },
        { op: "move", reference: "R1", by: { x: 2.54, y: 0 } },
        { op: "move", reference: "R1", rotateBy: 90 },
        { op: "remove", reference: "R1" },
      ],
      context(),
    );
    expect(summary).toEqual([
      "Placed R1 (jlc:R, 10k) with pins 1=+3V3, 2=EN",
      "Disconnected R1 pin 1",
      "Connected R1 pin 2 to BOOT",
      "Set R1 Value to 4.7k",
      expect.stringMatching(/^Moved R1 to \(/),
      "Turned R1 to 90 degrees",
      "Removed R1 (4.7k)",
    ]);
  });

  it("marks unused pins as not connected", () => {
    const { source } = applySchematicEdits(
      BLANK,
      [{ op: "place", symbol: "jlc:R", nets: { "1": "GND" }, noConnectRest: true }],
      context(),
    );
    expect(source.split("(no_connect").length - 1).toBe(1);
  });

  it("refuses parts that do not come from JLC, and unknown pins", () => {
    const attempt = (edit: Parameters<typeof applySchematicEdits>[1][number]) => () =>
      applySchematicEdits(BLANK, [edit], context());
    expect(attempt({ op: "place", symbol: "Device:R" })).toThrow(SchematicEditError);
    expect(attempt({ op: "place", symbol: "Device:R" })).toThrow(/jlc_part_search/);
    expect(attempt({ op: "place", symbol: "jlc:Missing" })).toThrow(/jlc_part_import/);
    expect(attempt({ op: "place", symbol: "jlc:R", nets: { "9": "GND" } })).toThrow(
      /no pin 9.*1 \(A\), 2 \(B\)/,
    );
    expect(attempt({ op: "remove", reference: "U5" })).toThrow(/No part U5/);
  });
});
