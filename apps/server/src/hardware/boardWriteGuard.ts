/**
 * Shell commands that write to a board. Agents flash through `hw_flash`, which
 * asks the user first and backs the board up; these would bypass that.
 */

const IDF_WRITES = new Set([
  "flash",
  "app-flash",
  "bootloader-flash",
  "partition-table-flash",
  "encrypted-flash",
  "encrypted-app-flash",
  "dfu-flash",
  "erase-flash",
  "erase_flash",
  "erase-otadata",
  "erase_otadata",
]);
const IDF_EFUSE = /^efuse[-_](burn|write)/;
const ESPTOOL_WRITES = new Set([
  "write_flash",
  "write-flash",
  "erase_flash",
  "erase-flash",
  "erase_region",
  "erase-region",
  "write_mem",
  "write-mem",
]);
const ESPEFUSE_WRITES = /^(burn|write[-_]protect)/;

export type BoardWrite = { readonly kind: "flash" | "efuse"; readonly command: string };

/** Splits a shell command line into simple commands (on ; && || | and newlines). */
const simpleCommands = (line: string) =>
  line
    .split(/\n|;|&&|\|\||\|/)
    .map((part) => part.trim())
    .filter(Boolean);

const PREFIXES = new Set(["sudo", "exec", "env", "time", "command", "nohup"]);
const SHELLS = /^(ba|z|da)?sh$/;
const PYTHON = /^python(\d(\.\d+)?)?$/;
const unquote = (token: string) => token.replace(/^['"]|['"]$/g, "");

/** What a simple command runs: the program (or Python module/script) and its arguments. */
function program(command: string): { name: string; args: ReadonlyArray<string> } | undefined {
  const tokens = command.split(/\s+/).map(unquote).filter(Boolean);
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index] ?? "";
    if (/^\w+=/.test(token) || PREFIXES.has(token)) index++;
    else break;
  }
  const first = tokens[index];
  if (first === undefined) return undefined;
  const name = first.split("/").at(-1) ?? first;
  const args = tokens.slice(index + 1);
  if (PYTHON.test(name)) {
    if (args[0] === "-m" && args[1]) return { name: args[1], args: args.slice(2) };
    const script = args[0];
    if (script) return { name: script.split("/").at(-1) ?? script, args: args.slice(1) };
  }
  return { name, args };
}

/** The first part of `line` that would flash, erase or burn eFuses on a board. */
export function findBoardWrite(line: string): BoardWrite | undefined {
  for (const command of simpleCommands(line)) {
    const run = program(command);
    if (!run) continue;
    const { name, args } = run;
    if (SHELLS.test(name)) {
      const flag = command.indexOf(" -c ");
      const nested =
        flag >= 0 ? findBoardWrite(unquote(command.slice(flag + 4).trim())) : undefined;
      if (nested) return nested;
      continue;
    }
    if (/^idf(\.py)?$/.test(name)) {
      if (args.some((arg) => IDF_EFUSE.test(arg))) return { kind: "efuse", command };
      if (args.some((arg) => IDF_WRITES.has(arg))) return { kind: "flash", command };
    }
    if (/^esptool(\.py)?$/.test(name) && args.some((arg) => ESPTOOL_WRITES.has(arg))) {
      return { kind: "flash", command };
    }
    if (/^espefuse(\.py)?$/.test(name) && args.some((arg) => ESPEFUSE_WRITES.test(arg))) {
      return { kind: "efuse", command };
    }
  }
  return undefined;
}

export function boardWriteDenial(write: BoardWrite): string {
  return write.kind === "efuse"
    ? `Kitty blocked \`${write.command}\`: burning eFuses permanently changes the chip and cannot be undone. Explain what it would do and let the user run it themselves.`
    : `Kitty blocked \`${write.command}\`: writing to the board needs the user's approval. Use the hw_flash tool instead; it builds, backs the board up the first time, and asks the user in the Hardware panel.`;
}
