/** The two tables JLC's assembly order asks for, in the columns its upload page reads. */
import type { KicadBomLine } from "@t3tools/contracts";

const cell = (value: string) => `"${value.replaceAll('"', '""')}"`;
const row = (cells: ReadonlyArray<string>) => cells.map(cell).join(",");

/** Bill of materials: one line per value and footprint, with the LCSC number JLC picks the part by. */
export function jlcBomCsv(lines: ReadonlyArray<KicadBomLine>): string {
  const rows = lines
    .filter((line) => !line.dnp)
    .map((line) =>
      row([
        line.value,
        line.refs.join(","),
        // JLC wants the footprint's own name, without the library before the colon.
        line.footprint?.split(":").at(-1) ?? "",
        line.lcsc ?? "",
      ]),
    );
  return `${["Comment,Designator,Footprint,LCSC Part #", ...rows].join("\n")}\n`;
}

/** One line of a CSV file, split on commas outside quotes. */
function cells(line: string): ReadonlyArray<string> {
  const result: Array<string> = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index++;
      } else quoted = !quoted;
    } else if (char === "," && !quoted) {
      result.push(current);
      current = "";
    } else current += char;
  }
  return [...result, current];
}

const millimetres = (value: string) => `${Number(value).toFixed(4)}mm`;

/** Placement file from KiCad's position file: where each part's centre is, its side and its angle. */
export function jlcCplCsv(kicadPositions: string): string {
  const [header = "", ...body] = kicadPositions.split(/\r?\n/).filter((line) => line.trim());
  const names = cells(header);
  const column = (name: string) => names.indexOf(name);
  const at = { ref: column("Ref"), x: column("PosX"), y: column("PosY"), rot: column("Rot") };
  const side = column("Side");
  const rows = body.map((line) => {
    const values = cells(line);
    return row([
      values[at.ref] ?? "",
      millimetres(values[at.x] ?? "0"),
      millimetres(values[at.y] ?? "0"),
      values[side]?.toLowerCase() === "bottom" ? "Bottom" : "Top",
      String(Number(values[at.rot] ?? "0")),
    ]);
  });
  return `${["Designator,Mid X,Mid Y,Layer,Rotation", ...rows].join("\n")}\n`;
}

/** Why a board is not ready to order, in words; empty when it is. */
export function orderBlockers(counts: {
  readonly errors: number;
  readonly unconnected: number;
}): ReadonlyArray<string> {
  const plural = (count: number, one: string, many: string) =>
    `${count} ${count === 1 ? one : many}`;
  return [
    ...(counts.unconnected > 0
      ? [plural(counts.unconnected, "connection is not routed", "connections are not routed")]
      : []),
    ...(counts.errors > 0 ? [plural(counts.errors, "DRC error", "DRC errors")] : []),
  ];
}
