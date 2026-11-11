import { assert, it } from "vite-plus/test";

import { easyedaConverterCandidates, normalizeLcsc, parseJlcSearch } from "./jlcParts.ts";

it("reads LCSC numbers however they are typed", () => {
  assert.equal(normalizeLcsc(" c25804 "), "C25804");
  assert.equal(normalizeLcsc("25804"), "C25804");
  assert.equal(normalizeLcsc("AMS1117"), undefined);
  assert.equal(normalizeLcsc("C25804; rm -rf"), undefined);
});

it("looks for the converter in the configured place first", () => {
  assert.deepEqual(easyedaConverterCandidates({ KITTY_EASYEDA2KICAD: " /opt/e2k " }, "/home/a"), [
    "/opt/e2k",
    "/home/a/.local/bin/easyeda2kicad",
    "easyeda2kicad",
  ]);
});

const row = (code: string, type: string, stock: number, extra: object = {}) => ({
  componentCode: code,
  componentModelEn: `MPN-${code}`,
  componentSpecificationEn: "0603",
  describe: "part",
  componentLibraryType: type,
  stockCount: stock,
  ...extra,
});

it("ranks parts in stock first, then basic, preferred and extended", () => {
  const reply = {
    data: {
      componentPageInfo: {
        total: 41,
        list: [
          row("C1", "expand", 900),
          row("C2", "base", 0),
          row("C3", "expand", 50, { preferredComponentFlag: true }),
          row("C4", "base", 10, {
            componentBrandEn: "UNI-ROYAL",
            firstSortName: "Resistors",
            secondSortName: "Chip Resistor",
            componentPrices: [{ productPrice: 0.0012 }],
            minImageAccessIdUrl: "https://img.example/c4.jpg?sig=1",
            dataManualUrl: "https://www.lcsc.com/datasheet/c4.pdf",
            productBigImageAccessIdUrl: "javascript:alert(1)",
          }),
          row("C5", "base", 500),
          { componentCode: "none" },
        ],
      },
    },
  };
  const result = parseJlcSearch(reply, 4);
  assert.equal(result.total, 41);
  assert.deepEqual(
    result.parts.map((part) => [part.lcsc, part.libraryType]),
    [
      ["C5", "basic"],
      ["C4", "basic"],
      ["C3", "preferred"],
      ["C1", "extended"],
    ],
  );
  assert.deepEqual(result.parts[1], {
    lcsc: "C4",
    mpn: "MPN-C4",
    package: "0603",
    description: "part",
    libraryType: "basic",
    stock: 10,
    manufacturer: "UNI-ROYAL",
    category: "Chip Resistor / Resistors",
    unitPrice: 0.0012,
    image: "https://img.example/c4.jpg?sig=1",
    datasheet: "https://www.lcsc.com/datasheet/c4.pdf",
  });
});

it("returns nothing for a reply it does not understand", () => {
  assert.deepEqual(parseJlcSearch({ code: 500 }, 5), { parts: [], total: 0 });
  assert.deepEqual(parseJlcSearch("<html>", 5), { parts: [], total: 0 });
});
