import { describe, expect, it } from "vite-plus/test";

import { designMention, withMention } from "./designMention.ts";

describe("designMention", () => {
  const file = "hardware/kicad/board.kicad_sch";

  it("names a part, a net, or both", () => {
    expect(designMention({ ref: "R1", value: "10k", file })).toBe(`R1 (10k) in ${file}`);
    expect(designMention({ net: "/SDA", file })).toBe(`net /SDA in ${file}`);
    expect(designMention({ ref: "U2", net: "+3V3", file })).toBe(`U2, net +3V3 in ${file}`);
    expect(designMention({ file })).toBeUndefined();
  });

  it("adds a mention to a prompt once", () => {
    const mention = `R1 (10k) in ${file}`;
    expect(withMention("", mention)).toBe(`About ${mention}: `);
    const prompt = withMention("Lower the current. ", mention);
    expect(prompt).toBe(`Lower the current.\nAbout ${mention}: `);
    expect(withMention(prompt, mention)).toBe(prompt);
  });
});
