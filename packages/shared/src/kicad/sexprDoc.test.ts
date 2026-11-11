import { describe, expect, it } from "vite-plus/test";

import { numeric, parseDoc, printDoc, quoted, unquoted } from "./sexprDoc.ts";

// Written by KiCad 10: lists on their own lines, points packed on one line.
const FILE = [
  "(kicad_sch",
  "\t(version 20260101)",
  '\t(generator "eeschema")',
  "\t(wire",
  "\t\t(pts",
  "\t\t\t(xy 100.33 46.99) (xy 105.41 46.99)",
  "\t\t)",
  "\t\t(stroke",
  "\t\t\t(width 0)",
  "\t\t\t(type default)",
  "\t\t)",
  '\t\t(uuid "0a1b")',
  "\t)",
  '\t(text "say \\"hi\\"\\nthere"',
  "\t\t(at 10 20 0)",
  "\t)",
  "\t(embedded_fonts no)",
  ")",
  "",
].join("\n");

describe("sexprDoc", () => {
  it("writes back exactly what KiCad wrote", () => {
    expect(printDoc(parseDoc(FILE))).toBe(FILE);
  });

  it("keeps atoms as written and escapes strings like KiCad", () => {
    const root = parseDoc(FILE) as Array<unknown>;
    expect(root[1]).toEqual(["version", "20260101"]);
    expect(root[2]).toEqual(["generator", '"eeschema"']);
    const text = (root[4] as Array<string>)[1] as string;
    expect(unquoted(text)).toBe('say "hi"\nthere');
    expect(quoted(unquoted(text))).toBe(text);
    expect(unquoted("yes")).toBe("yes");
  });

  it("packs points up to the line limit, then starts a new line", () => {
    const points = Array.from({ length: 12 }, (_, index) => ["xy", String(index * 10), "0"]);
    const lines = printDoc(["polyline", ["pts", ...points]]).split("\n");
    // 99 columns hold several points; the rest continue on the next line at the same indent.
    expect(lines[2]?.startsWith("\t\t(xy 0 0) (xy 10 0)")).toBe(true);
    expect(lines[2]?.length).toBeLessThanOrEqual(110);
    expect(lines[3]?.startsWith("\t\t(xy ")).toBe(true);
    expect(parseDoc(lines.join("\n"))).toEqual(["polyline", ["pts", ...points]]);
  });

  it("formats numbers without float noise", () => {
    expect(numeric(2.54 * 3)).toBe("7.62");
    expect(numeric(-0)).toBe("0");
    expect(numeric(100)).toBe("100");
  });

  it("rejects text that is not a complete list", () => {
    expect(() => parseDoc("(a (b)")).toThrow("never closed");
    expect(() => parseDoc(")")).toThrow('Unexpected ")"');
  });
});
