/**
 * A lossless reader and writer for KiCad files. Atoms keep their exact text
 * (quotes, number formatting), and the writer lays lists out the way KiCad
 * does, so a file that is read and written back unchanged is byte-identical.
 */

/** A list, or an atom as written in the file (quoted strings keep their quotes). */
export type Node = string | Array<Node>;

export function parseDoc(text: string): Node {
  let index = 0;
  const length = text.length;
  const isSpace = (char: string) => char === " " || char === "\n" || char === "\t" || char === "\r";
  const read = (): Node => {
    while (index < length && isSpace(text[index] as string)) index++;
    if (index >= length) throw new Error("Unexpected end of file.");
    const char = text[index];
    if (char === "(") {
      index++;
      const list: Array<Node> = [];
      for (;;) {
        while (index < length && isSpace(text[index] as string)) index++;
        if (index >= length) throw new Error("A list is never closed.");
        if (text[index] === ")") {
          index++;
          return list;
        }
        list.push(read());
      }
    }
    if (char === ")") throw new Error(`Unexpected ")" at offset ${index}.`);
    const start = index;
    if (char === '"') {
      index++;
      while (index < length && text[index] !== '"') index += text[index] === "\\" ? 2 : 1;
      if (index >= length) throw new Error("A quoted string is never closed.");
      index++;
    } else {
      while (
        index < length &&
        !isSpace(text[index] as string) &&
        text[index] !== "(" &&
        text[index] !== ")"
      ) {
        index++;
      }
    }
    return text.slice(start, index);
  };
  return read();
}

/** A quoted atom for `value`, escaped the way KiCad writes strings. */
export function quoted(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`;
}

/** The text of an atom: quoted strings are unescaped, bare atoms returned as is. */
export function unquoted(atom: string): string {
  if (!atom.startsWith('"')) return atom;
  return atom.slice(1, -1).replace(/\\(.)/g, (_, char: string) => (char === "n" ? "\n" : char));
}

/** A number atom, without the float noise (`2.54`, not `2.5400000001`). */
export function numeric(value: number): string {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function flatten(node: Node, out: Array<string>): void {
  if (typeof node === "string") {
    out.push(node);
    return;
  }
  out.push("(");
  for (const child of node) flatten(child, out);
  out.push(")");
}

const XY_LINE_LIMIT = 99;
const TOKEN_WRAP_COLUMN = 72;

/**
 * Writes a document in KiCad's layout: every list on its own line, indented
 * with tabs, runs of `(xy …)` points packed up to column 99, and long runs
 * of atoms wrapped at column 72.
 */
export function printDoc(root: Node): string {
  const tokens: Array<string> = [];
  flatten(root, tokens);
  let out = "";
  let column = 0;
  let depth = 0;
  let inXY = false;
  let inMultiLineList = false;
  let previous = "";
  const newline = () => {
    out += `\n${"\t".repeat(depth)}`;
    column = depth;
  };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] as string;
    const next = tokens[index + 1];
    if (token === "(") {
      const isXY = next === "xy";
      if (out === "") {
        out = "(";
        column = 1;
      } else if (inXY && isXY && column < XY_LINE_LIMIT) {
        out += " (";
        column += 2;
      } else {
        newline();
        out += "(";
        column += 1;
      }
      inXY = isXY;
      depth++;
    } else if (token === ")") {
      if (depth > 0) depth--;
      if (previous === ")" || inMultiLineList) {
        newline();
        out += ")";
        column++;
        inMultiLineList = false;
      } else {
        out += ")";
        column++;
      }
    } else {
      // An atom follows the list head or another atom after one space, or wraps.
      if (previous !== "(") {
        if (inXY || column < TOKEN_WRAP_COLUMN) {
          out += " ";
          column++;
        } else {
          newline();
          inMultiLineList = true;
        }
      }
      out += token;
      column += token.length;
    }
    previous = token;
  }
  return `${out}\n`;
}
