/**
 * Reading and editing ESP-IDF `sdkconfig` / `sdkconfig.defaults` text.
 *
 * Lines are `CONFIG_NAME=value` or `# CONFIG_NAME is not set`; strings are
 * double-quoted with backslash escapes, everything else (bool y, int, hex) is raw.
 */

export type SdkconfigValue = boolean | number | string;

const KEY = /^CONFIG_[A-Z0-9_]+$/;
const SET_LINE = /^(CONFIG_[A-Z0-9_]+)=(.*)$/;
const UNSET_LINE = /^# (CONFIG_[A-Z0-9_]+) is not set$/;
const INTEGER = /^-?\d+$/;
const HEX = /^0x[0-9a-fA-F]+$/;

export const isSdkconfigKey = (key: string): boolean => KEY.test(key);

/** Accepts `FOO` as well as `CONFIG_FOO`. */
export const normalizeSdkconfigKey = (key: string): string => {
  const upper = key.trim().toUpperCase();
  return upper.startsWith("CONFIG_") ? upper : `CONFIG_${upper}`;
};

function unquote(raw: string): string {
  return raw.slice(1, -1).replace(/\\(["\\])/g, "$1");
}

function quote(value: string): string {
  return `"${value.replace(/(["\\])/g, "\\$1")}"`;
}

/** The typed value of a raw right-hand side. Hex stays a string so it round-trips. */
export function decodeSdkconfigValue(raw: string): SdkconfigValue {
  if (raw === "y") return true;
  if (raw === "n") return false;
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) return unquote(raw);
  if (INTEGER.test(raw)) return Number(raw);
  return raw;
}

/** Parses every option, in file order. Unset booleans read as `false`. */
export function parseSdkconfig(text: string): Map<string, { raw: string | null }> {
  const entries = new Map<string, { raw: string | null }>();
  for (const line of text.split(/\r?\n/)) {
    const set = SET_LINE.exec(line);
    if (set) {
      entries.set(set[1] ?? "", { raw: set[2] ?? "" });
      continue;
    }
    const unset = UNSET_LINE.exec(line);
    if (unset) entries.set(unset[1] ?? "", { raw: null });
  }
  return entries;
}

export const entryValue = (entry: { raw: string | null }): SdkconfigValue =>
  entry.raw === null ? false : decodeSdkconfigValue(entry.raw);

/**
 * The raw text for a requested value. `previousRaw` decides between a quoted
 * string and a raw number for options that already exist, so a numeric-looking
 * string option stays quoted and a hex option stays unquoted.
 */
export function encodeSdkconfigValue(
  value: SdkconfigValue,
  previousRaw?: string | null,
): string | null {
  if (typeof value === "boolean") return value ? "y" : null;
  if (typeof value === "number") return String(Math.trunc(value));
  if (previousRaw?.startsWith('"')) return quote(value);
  if (previousRaw !== undefined && previousRaw !== null) {
    return INTEGER.test(value) || HEX.test(value) ? value : quote(value);
  }
  if (value === "y") return "y";
  if (value === "n") return null;
  return INTEGER.test(value) || HEX.test(value) ? value : quote(value);
}

const renderLine = (key: string, raw: string | null) =>
  raw === null ? `# ${key} is not set` : `${key}=${raw}`;

/** Rewrites the lines for `updates` in place and appends options the text lacks. */
export function applySdkconfigUpdates(
  text: string,
  updates: ReadonlyMap<string, string | null>,
): string {
  const pending = new Map(updates);
  const lines = text.length > 0 ? text.replace(/\r?\n$/, "").split(/\r?\n/) : [];
  const out = lines.map((line) => {
    const key = SET_LINE.exec(line)?.[1] ?? UNSET_LINE.exec(line)?.[1];
    if (key === undefined || !pending.has(key)) return line;
    const raw = pending.get(key) ?? null;
    pending.delete(key);
    return renderLine(key, raw);
  });
  for (const [key, raw] of pending) out.push(renderLine(key, raw));
  return out.length > 0 ? `${out.join("\n")}\n` : "";
}

/** Options whose key or value contains `search` (case-insensitive). */
export function searchSdkconfig(
  entries: ReadonlyMap<string, { raw: string | null }>,
  search: string,
): Array<string> {
  const needle = search.trim().toLowerCase();
  return [...entries]
    .filter(
      ([key, entry]) =>
        key.toLowerCase().includes(needle) || (entry.raw ?? "").toLowerCase().includes(needle),
    )
    .map(([key]) => key);
}

interface MenuNode {
  readonly name?: unknown;
  readonly type?: unknown;
  readonly children?: unknown;
}

/**
 * Choice groups from ESP-IDF's `build/config/kconfig_menus.json`: each entry
 * maps to the other entries of its choice, all with the CONFIG_ prefix.
 * Anything unreadable yields no groups.
 */
export function parseKconfigChoices(menusJson: string): Map<string, ReadonlyArray<string>> {
  const siblings = new Map<string, ReadonlyArray<string>>();
  const walk = (nodes: unknown) => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes as ReadonlyArray<MenuNode>) {
      if (typeof node !== "object" || node === null) continue;
      if (node.type === "choice" && Array.isArray(node.children)) {
        const entries = (node.children as ReadonlyArray<MenuNode>).flatMap((child) =>
          typeof child?.name === "string" && child.type === "bool" ? [`CONFIG_${child.name}`] : [],
        );
        for (const entry of entries) {
          siblings.set(
            entry,
            entries.filter((other) => other !== entry),
          );
        }
      }
      walk(node.children);
    }
  };
  try {
    walk(JSON.parse(menusJson));
  } catch {
    return new Map();
  }
  return siblings;
}
