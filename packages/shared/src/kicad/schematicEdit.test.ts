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
      if (library === "jlc") return name === "R" ? symbols.get("R") : undefined;
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
