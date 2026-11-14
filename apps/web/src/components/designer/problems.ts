/** Turns KiCad's ERC and DRC reports into problems the designer can list and mark. */
import type { KicadDrcResult, KicadErcResult, KicadViolation } from "@t3tools/contracts";

export interface Problem {
  readonly key: string;
  readonly severity: "error" | "warning";
  /** KiCad's own message, in the language KiCad runs in. */
  readonly title: string;
  /** What the message is about: the part, pin or track. */
  readonly subject: string;
  /** A plain explanation of what to do, when Kitty knows the check. */
  readonly hint?: string;
  readonly x?: number;
  readonly y?: number;
}

const HINTS: Readonly<Record<string, string>> = {
  pin_not_connected: "This pin is not wired to anything. Connect it, or mark it as not connected.",
  pin_not_driven: "Nothing drives this input. Connect it to an output or a pull resistor.",
  power_pin_not_driven:
    "This power pin has no power source on its net. Add a power flag or a regulator output.",
  label_dangling: "This label is not attached to a wire.",
  wire_dangling: "This wire ends in mid-air. Connect it or delete it.",
  no_connect_connected: "A pin marked as not connected is wired to something.",
  different_unit_net: "The same pin is on different nets in different units of this part.",
  multiple_net_names: "One wire has two different net names. Keep one.",
  lib_symbol_issues:
    "The symbol's library is not installed here. The part still works; this is only a notice.",
  lib_symbol_mismatch: "The symbol differs from its library version. Usually safe to ignore.",
  lib_footprint_issues:
    "The footprint's library is not installed here. The part still works; this is only a notice.",
  lib_footprint_mismatch: "The footprint differs from its library version. Usually safe to ignore.",
  unconnected_items: "These two points belong to the same net but are not routed together yet.",
  clearance: "Two copper items are closer than the board rules allow. Move one of them apart.",
  shorting_items: "Two different nets touch. This is a short circuit.",
  tracks_crossing: "Two tracks on the same layer cross. Move one to another layer with a via.",
  track_dangling: "This track ends without reaching a pad or another track.",
  via_dangling: "This via is connected on one layer only.",
  copper_edge_clearance: "Copper is too close to the board edge.",
  courtyards_overlap: "Two parts overlap. Move them apart.",
  silk_over_copper: "Silkscreen text sits on a pad and will be cut off. Only cosmetic.",
  silk_overlap: "Silkscreen texts overlap. Only cosmetic.",
  solder_mask_bridge: "The solder mask between two pads is too thin and may bridge when soldered.",
  missing_footprint:
    "A part in the schematic has no footprint on the board. Sync the board from the schematic.",
  extra_footprint: "A footprint on the board is not in the schematic.",
  net_conflict:
    "A pad is on a different net than the schematic says. Sync the board from the schematic.",
};

function toProblem(violation: KicadViolation, key: string): Problem | undefined {
  if (violation.severity === "exclusion") return undefined;
  const located = violation.items.find((item) => item.x !== undefined && item.y !== undefined);
  // The reviewer's own way to fix it says more than the general note for the check.
  const hint = violation.fix ?? HINTS[violation.type];
  return {
    key,
    severity: violation.severity,
    title: violation.description || violation.type,
    subject: violation.items
      .map((item) => item.description)
      .filter(Boolean)
      .join(" · "),
    ...(hint ? { hint } : {}),
    ...(located?.x !== undefined && located.y !== undefined ? { x: located.x, y: located.y } : {}),
  };
}

const collect = (
  violations: ReadonlyArray<KicadViolation>,
  prefix: string,
): ReadonlyArray<Problem> =>
  violations
    .map((violation, index) => toProblem(violation, `${prefix}:${index}`))
    .filter((problem): problem is Problem => problem !== undefined);

/**
 * The ERC problems on one sheet. KiCad names sheets by path: `/` for the root,
 * `/power/` for a sub-sheet called "power".
 */
export function sheetProblems(
  erc: KicadErcResult | undefined,
  sheetName: string,
  root: boolean,
): ReadonlyArray<Problem> {
  if (!erc) return [];
  const mine = erc.violations.filter((violation) =>
    root
      ? violation.sheet === undefined || violation.sheet === "/"
      : violation.sheet !== undefined && violation.sheet.endsWith(`/${sheetName}/`),
  );
  return collect(mine, `erc:${sheetName}`);
}

export function boardProblems(drc: KicadDrcResult | undefined): ReadonlyArray<Problem> {
  if (!drc) return [];
  return [
    ...collect(drc.violations, "drc"),
    ...collect(drc.unconnected, "unconnected"),
    ...collect(drc.schematicParity, "parity"),
  ];
}

export const countProblems = (problems: ReadonlyArray<Problem>) => ({
  errors: problems.filter((problem) => problem.severity === "error").length,
  warnings: problems.filter((problem) => problem.severity === "warning").length,
});

/** What to ask the agent so that it fixes these problems, with where each one is. */
export function fixRequest(design: string, problems: ReadonlyArray<Problem>): string {
  const lines = problems.map((problem) => {
    const where =
      problem.x === undefined || problem.y === undefined
        ? ""
        : ` at (${problem.x.toFixed(1)}, ${problem.y.toFixed(1)}) mm`;
    const subject = problem.subject ? ` [${problem.subject}]` : "";
    const hint = problem.hint ? ` Suggested: ${problem.hint}` : "";
    return `- ${problem.severity}: ${problem.title}${subject}${where}.${hint}`;
  });
  const what = problems.length === 1 ? "this problem" : `these ${problems.length} problems`;
  return [
    `Fix ${what} in ${design}. Read the design first, decide which are real and which can be left, fix the real ones at their cause (move parts or reroute rather than patch), then run the checks again and tell me what you changed and what you left.`,
    ...lines,
  ].join("\n");
}
