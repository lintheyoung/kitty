/**
 * A minimal S-expression reader for KiCad files (netlists, boards, schematics).
 * Lists become arrays; atoms and quoted strings become strings.
 */
export type Sexpr = string | ReadonlyArray<Sexpr>;

const ESCAPES: Readonly<Record<string, string>> = { n: "\n", t: "\t", r: "\r" };

export function parseSexpr(text: string): Sexpr {
  let index = 0;
  const skipSpace = () => {
    while (index < text.length && /\s/.test(text[index] ?? "")) index++;
  };
  const readString = () => {
    index++; // opening quote
    let value = "";
    while (index < text.length) {
      const char = text[index++] ?? "";
      if (char === '"') return value;
      if (char === "\\") {
        const next = text[index++] ?? "";
        value += ESCAPES[next] ?? next;
      } else {
        value += char;
      }
    }
    throw new Error("Unterminated string in S-expression.");
  };
  const readAtom = () => {
    const start = index;
    while (index < text.length && !/[\s()"]/.test(text[index] ?? "")) index++;
    return text.slice(start, index);
  };
  const read = (): Sexpr => {
    skipSpace();
    const char = text[index];
    if (char === undefined) throw new Error("Unexpected end of S-expression.");
    if (char === "(") {
      index++;
      const list: Array<Sexpr> = [];
      for (;;) {
        skipSpace();
        if (text[index] === ")") {
          index++;
          return list;
        }
        if (index >= text.length) throw new Error("Unclosed list in S-expression.");
        list.push(read());
      }
    }
    if (char === ")") throw new Error(`Unexpected ")" at ${index}.`);
    return char === '"' ? readString() : readAtom();
  };
  return read();
}

const isList = (node: Sexpr | undefined): node is ReadonlyArray<Sexpr> => Array.isArray(node);

/** Child lists of `node` whose head is `name`. */
export function children(
  node: Sexpr | undefined,
  name: string,
): ReadonlyArray<ReadonlyArray<Sexpr>> {
  if (!isList(node)) return [];
  return node.filter((child): child is ReadonlyArray<Sexpr> => isList(child) && child[0] === name);
}

export const child = (node: Sexpr | undefined, name: string) => children(node, name)[0];

/** The first atom after the head of `(name value)`. */
export function value(node: Sexpr | undefined, name: string): string | undefined {
  const found = child(node, name)?.[1];
  return typeof found === "string" ? found : undefined;
}

/** The numeric atoms after the head of a list: `(at 1 2 90)` gives `[1, 2, 90]`. */
export function numbers(node: Sexpr | undefined): ReadonlyArray<number> {
  if (!isList(node)) return [];
  const result: Array<number> = [];
  for (const item of node.slice(1)) {
    if (typeof item !== "string") continue;
    const parsed = Number(item);
    if (Number.isFinite(parsed)) result.push(parsed);
  }
  return result;
}

/** The string atoms after the head of a list. */
export function atoms(node: Sexpr | undefined): ReadonlyArray<string> {
  if (!isList(node)) return [];
  return node.slice(1).filter((item): item is string => typeof item === "string");
}

/** True for `(name yes)` and for a bare `name` atom, KiCad's two ways to set a flag. */
export function flag(node: Sexpr | undefined, name: string): boolean {
  if (!isList(node)) return false;
  if (node.includes(name)) return true;
  const found = child(node, name);
  return found !== undefined && found[1] !== "no";
}
