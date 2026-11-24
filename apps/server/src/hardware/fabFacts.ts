/**
 * JLCPCB's process limits as Kitty checked them against JLCPCB's own pages, each with its source.
 * Copper ships a JLCPCB profile; Kitty writes a corrected copy to $COPPER_HOME/fabs, which Copper
 * prefers over its built-in one. A figure JLCPCB does not publish stays "not checked".
 */

const FAB_FACTS_CHECKED = "2026-11-25";

const PCB = "https://jlcpcb.com/capabilities/pcb-capabilities";
const ASSEMBLY = "https://jlcpcb.com/capabilities/pcb-assembly-capabilities";
const EXTRA = "https://jlcpcb.com/help/article/In-what-cases-will-there-be-charged-extra";
const PRICE = "https://jlcpcb.com/help/article/40-pcb-assembly-price";

export interface FabFact {
  readonly what: string;
  readonly published: string;
  /** checked: Copper's value is within it; corrected: Kitty changed Copper's value to it. */
  readonly status: "checked" | "corrected" | "not checked";
  readonly source?: string;
}

export const JLCPCB_FACTS: ReadonlyArray<FabFact> = [
  {
    what: "track / space, 1-2 layers",
    published: "0.10 / 0.10 mm",
    status: "checked",
    source: PCB,
  },
  {
    what: "track / space, multilayer",
    published: "0.09 / 0.09 mm",
    status: "checked",
    source: PCB,
  },
  {
    what: "via hole / diameter",
    published: "0.15 / 0.25 mm minimum; 0.2 mm preferred",
    status: "checked",
    source: PCB,
  },
  {
    what: "hole size without surcharge",
    published: "0.3 mm and larger",
    status: "checked",
    source: EXTRA,
  },
  {
    what: "plated hole annular ring",
    published: "0.20 mm preferred; at least 0.18 mm on 2 layers, 0.15 mm multilayer (1 oz)",
    status: "corrected",
    source: PCB,
  },
  { what: "pad hole to pad hole", published: "0.45 mm", status: "checked", source: PCB },
  { what: "copper to routed edge", published: "0.2 mm", status: "checked", source: PCB },
  {
    what: "silkscreen text",
    published: "1.0 mm high, 0.15 mm line",
    status: "corrected",
    source: PCB,
  },
  { what: "non-plated hole", published: "0.5 mm minimum", status: "checked", source: PCB },
  {
    what: "cheapest board size",
    published: "up to 102 x 102 mm",
    status: "corrected",
    source: EXTRA,
  },
  {
    what: "assembly board size",
    published:
      "Economic 10 x 10 mm to 470 x 500 mm, one side; Standard from 70 x 70 mm, both sides",
    status: "checked",
    source: ASSEMBLY,
  },
  {
    what: "feeder loading fee",
    published: "Economic $3.07 per extended part; Standard $1.53 per part",
    status: "corrected",
    source: PRICE,
  },
  {
    what: "4-layer stackup name JLC04161H-7628",
    published: "not on JLCPCB's pages",
    status: "not checked",
  },
];

/** What Kitty changes in Copper's JLCPCB profile. */
const CORRECTIONS = {
  rules: {
    standard: { pth_annular: 0.18, min_text_height: 1.0 },
    advanced: { pth_annular: 0.18, min_text_height: 1.0 },
  },
  rules_by_layers: { "4": { pth_annular: 0.15 } },
  limits: { price_tier_mm: [102, 102] },
  part_classes: { fee_usd: { extended: 3.07 } },
} as const;

type Json = { [key: string]: unknown };
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const merge = (base: Json, over: Json): Json => {
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const current = out[key];
    out[key] = isObject(value) && isObject(current) ? merge(current, value) : value;
  }
  return out;
};

const fabFactsNote = (): string =>
  [
    `Kitty checked these against JLCPCB's pages on ${FAB_FACTS_CHECKED}:`,
    ...JLCPCB_FACTS.map(
      (fact) =>
        `${fact.what}: ${fact.published} (${fact.status}${fact.source ? `, ${fact.source}` : ""}).`,
    ),
    "Anything not listed is Copper's own figure and was not checked by Kitty.",
  ].join(" ");

/** Copper's built-in JLCPCB profile with Kitty's corrections, or undefined when it cannot be read. */
export const kittyFabProfile = (builtIn: string): string | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(builtIn);
  } catch {
    return undefined;
  }
  if (!isObject(parsed) || parsed.name !== "jlcpcb") return undefined;
  const profile = merge(parsed, CORRECTIONS);
  profile.notes = `${fabFactsNote()} Copper's note: ${String(parsed.notes ?? "")}`;
  return `${JSON.stringify({ "//": "Written by Kitty; rewritten when Copper starts.", ...profile }, null, 2)}\n`;
};
