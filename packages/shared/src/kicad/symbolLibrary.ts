/** Reading and merging KiCad symbol libraries (`.kicad_sym`). */
import { type Node, parseDoc, printDoc, unquoted } from "./sexprDoc.ts";

export interface SymbolPin {
  readonly number: string;
  readonly name: string;
}

export interface SymbolInfo {
  readonly name: string;
  /** Reference prefix without the question mark: `R`, `U`. */
  readonly referencePrefix: string;
  /** Every field of the symbol by name. */
  readonly properties: Readonly<Record<string, string>>;
  readonly pins: ReadonlyArray<SymbolPin>;
}

const isList = (node: Node | undefined): node is Array<Node> => Array.isArray(node);
const head = (node: Node | undefined) =>
  isList(node) && typeof node[0] === "string" ? node[0] : "";
const text = (node: Node | undefined) => (typeof node === "string" ? unquoted(node) : "");

/** The symbols defined at the top of a library, in file order. */
export function librarySymbols(library: Node): ReadonlyArray<Array<Node>> {
  if (!isList(library)) return [];
  return library.filter((entry): entry is Array<Node> => head(entry) === "symbol");
}

export function describeSymbol(symbol: ReadonlyArray<Node>): SymbolInfo {
  const properties: Record<string, string> = {};
  const pins: Array<SymbolPin> = [];
  const collectPins = (node: ReadonlyArray<Node>) => {
    for (const entry of node) {
      if (head(entry) === "symbol") collectPins(entry as Array<Node>);
      if (head(entry) !== "pin") continue;
      const fields = (entry as Array<Node>).filter(isList);
      const field = (name: string) => text(fields.find((item) => head(item) === name)?.[1]);
      pins.push({ number: field("number"), name: field("name") });
    }
  };
  for (const entry of symbol) {
    if (head(entry) === "property") {
      const [, name, value] = entry as Array<Node>;
      properties[text(name)] = text(value);
    }
  }
  collectPins(symbol);
  return {
    name: text(symbol[1]),
    referencePrefix: (properties.Reference ?? "U").replace(/[?#\d]+$/, "") || "U",
    properties,
    pins,
  };
}

/**
 * Adds `incoming`'s symbols to `existing`, replacing symbols of the same name.
 * Returns the merged library text; with no existing library, `incoming` as is.
 */
export function mergeSymbolLibraries(existing: string | undefined, incoming: string): string {
  if (existing === undefined) return incoming;
  const target = parseDoc(existing);
  if (!isList(target)) throw new Error("The symbol library is not a list.");
  for (const symbol of librarySymbols(parseDoc(incoming))) {
    const at = target.findIndex((entry) => head(entry) === "symbol" && entry[1] === symbol[1]);
    if (at >= 0) target[at] = symbol;
    else target.push(symbol);
  }
  return printDoc(target);
}

const TABLE_HEAD = { symbol: "sym_lib_table", footprint: "fp_lib_table" } as const;

/**
 * A project library table (`sym-lib-table`, `fp-lib-table`) that lists the
 * library `name`. Existing entries and formatting are kept.
 */
export function withLibraryEntry(
  existing: string | undefined,
  kind: keyof typeof TABLE_HEAD,
  entry: { readonly name: string; readonly uri: string; readonly description: string },
): string {
  const line = `\t(lib (name "${entry.name}")(type "KiCad")(uri "${entry.uri}")(options "")(descr "${entry.description}"))`;
  if (existing === undefined || existing.trim() === "") {
    return `(${TABLE_HEAD[kind]}\n\t(version 7)\n${line}\n)\n`;
  }
  if (new RegExp(`\\(name\\s+"?${entry.name}"?\\)`).test(existing)) return existing;
  const end = existing.lastIndexOf(")");
  if (end < 0) throw new Error("The library table is not a list.");
  return `${existing.slice(0, end).trimEnd()}\n${line}\n)\n`;
}
