import { describe, expect, it } from "vite-plus/test";

import { parseDoc } from "./sexprDoc.ts";
import {
  describeSymbol,
  librarySymbols,
  mergeSymbolLibraries,
  withLibraryEntry,
} from "./symbolLibrary.ts";

const symbol = (name: string, reference: string, value: string) =>
  [
    `\t(symbol "${name}"`,
    `\t\t(property "Reference" "${reference}"`,
    "\t\t\t(at 0 2.54 0)",
    "\t\t)",
    `\t\t(property "Value" "${value}"`,
    "\t\t\t(at 0 -2.54 0)",
    "\t\t)",
    '\t\t(property "LCSC Part" "C25804"',
    "\t\t\t(at 0 0 0)",
    "\t\t)",
    `\t\t(symbol "${name}_0_1"`,
    "\t\t\t(pin passive line",
    "\t\t\t\t(at -5.08 0 0)",
    "\t\t\t\t(length 2.54)",
    '\t\t\t\t(name "A"',
    "\t\t\t\t)",
    '\t\t\t\t(number "1"',
    "\t\t\t\t)",
    "\t\t\t)",
    "\t\t)",
    "\t)",
  ].join("\n");

const library = (...symbols: ReadonlyArray<string>) =>
  [
    "(kicad_symbol_lib",
    "\t(version 20251024)",
    '\t(generator "kicad_symbol_editor")',
    ...symbols,
    ")",
    "",
  ].join("\n");

describe("symbol libraries", () => {
  it("describes a symbol's fields and pins", () => {
    const [first] = librarySymbols(parseDoc(library(symbol("R0603", "R?", "10k"))));
    expect(describeSymbol(first!)).toEqual({
      name: "R0603",
      referencePrefix: "R",
      properties: { Reference: "R?", Value: "10k", "LCSC Part": "C25804" },
      pins: [{ number: "1", name: "A" }],
    });
  });

  it("starts a library from the incoming one", () => {
    const incoming = library(symbol("R0603", "R", "10k"));
    expect(mergeSymbolLibraries(undefined, incoming)).toBe(incoming);
  });

  it("adds new symbols and replaces symbols of the same name", () => {
    const existing = library(symbol("R0603", "R", "10k"), symbol("LDO", "U", "AMS1117"));
    const merged = mergeSymbolLibraries(
      existing,
      library(symbol("R0603", "R", "22k"), symbol("ESP32", "U", "ESP32-S3")),
    );
    const symbols = librarySymbols(parseDoc(merged)).map(describeSymbol);
    expect(symbols.map((item) => [item.name, item.properties.Value])).toEqual([
      ["R0603", "22k"],
      ["LDO", "AMS1117"],
      ["ESP32", "ESP32-S3"],
    ]);
    // Merging the same part again changes nothing.
    expect(mergeSymbolLibraries(merged, library(symbol("ESP32", "U", "ESP32-S3")))).toBe(merged);
  });
});

describe("library tables", () => {
  const entry = { name: "jlc", uri: "${KIPRJMOD}/lib/jlc.kicad_sym", description: "JLC" };

  it("creates a table", () => {
    expect(withLibraryEntry(undefined, "symbol", entry)).toBe(
      '(sym_lib_table\n\t(version 7)\n\t(lib (name "jlc")(type "KiCad")(uri "${KIPRJMOD}/lib/jlc.kicad_sym")(options "")(descr "JLC"))\n)\n',
    );
    expect(withLibraryEntry("", "footprint", entry).startsWith("(fp_lib_table")).toBe(true);
  });

  it("keeps existing entries and adds the library once", () => {
    const existing =
      '(sym_lib_table\n  (version 7)\n  (lib (name "mine")(type "KiCad")(uri "${KIPRJMOD}/mine.kicad_sym")(options "")(descr ""))\n)\n';
    const next = withLibraryEntry(existing, "symbol", entry);
    expect(next).toContain('(name "mine")');
    expect(next).toContain('(name "jlc")');
    expect(withLibraryEntry(next, "symbol", entry)).toBe(next);
  });
});
