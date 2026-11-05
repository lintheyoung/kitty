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
