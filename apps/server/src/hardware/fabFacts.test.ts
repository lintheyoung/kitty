import { describe, expect, it } from "vite-plus/test";

import { JLCPCB_FACTS, kittyFabProfile } from "./fabFacts.ts";

const builtIn = JSON.stringify({
  name: "jlcpcb",
  notes: "Copper's default profile.",
  rules: {
    standard: { min_track: 0.127, pth_annular: 0.15, min_text_height: 0.8 },
    advanced: { min_track: 0.09, pth_annular: 0.15, min_text_height: 0.8 },
  },
  limits: { price_tier_mm: [100, 100], through_vias_only: true },
  part_classes: { field: "JLC Class", fee_usd: { extended: 3.0 } },
});

describe("kittyFabProfile", () => {
  it("raises Copper's JLCPCB rules to the published limits and keeps the rest", () => {
    const profile = JSON.parse(kittyFabProfile(builtIn) ?? "{}");
    expect(profile.rules.standard).toEqual({
      min_track: 0.127,
      pth_annular: 0.18,
      min_text_height: 1,
    });
    expect(profile.rules.advanced.min_track).toBe(0.09);
    expect(profile.rules_by_layers["4"].pth_annular).toBe(0.15);
    expect(profile.limits).toEqual({ price_tier_mm: [102, 102], through_vias_only: true });
    expect(profile.part_classes).toEqual({ field: "JLC Class", fee_usd: { extended: 3.07 } });
  });

  it("says where each figure comes from and keeps Copper's own note", () => {
    const notes: string = JSON.parse(kittyFabProfile(builtIn) ?? "{}").notes;
    expect(notes).toContain("https://jlcpcb.com/capabilities/pcb-capabilities");
    expect(notes).toContain(
      "4-layer stackup name JLC04161H-7628: not on JLCPCB's pages (not checked)",
    );
    expect(notes).toContain("Copper's note: Copper's default profile.");
    expect(JLCPCB_FACTS.filter((fact) => fact.status !== "not checked" && !fact.source)).toEqual(
      [],
    );
  });

  it("leaves Copper alone when its profile is not what Kitty expects", () => {
    expect(kittyFabProfile("not json")).toBeUndefined();
    expect(kittyFabProfile(JSON.stringify({ name: "pcbway" }))).toBeUndefined();
  });
});
