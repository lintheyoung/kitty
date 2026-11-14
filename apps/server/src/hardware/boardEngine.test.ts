import { describe, expect, it } from "vite-plus/test";

import { inKittyTerms, parseEngineReply } from "./boardEngine.ts";

describe("the PCB engine's replies", () => {
  it("reads the summary and report from the runner's last line", () => {
    const line = JSON.stringify({ summary: "routed 3/3", report: '{"routed":3}' });
    expect(parseEngineReply(`some noise\n${line}\n`)).toEqual({
      summary: "routed 3/3",
      report: '{"routed":3}',
    });
    expect(parseEngineReply(JSON.stringify({ error: "no outline" }))).toEqual({
      error: "no outline",
    });
    expect(parseEngineReply("Traceback (most recent call last)")).toBeUndefined();
    expect(parseEngineReply("")).toBeUndefined();
  });

  it("names Kitty's tools where the engine names its own", () => {
    expect(inKittyTerms("pcb_place(moves=[{ref:'C5', x:.., y:..}]) next to U1.2")).toBe(
      "pcb_edit move C5 next to U1.2",
    );
    expect(inKittyTerms("clean — fab_export() when you're ready")).toBe(
      "clean — kicad_fab_export when you're ready",
    );
    expect(inKittyTerms("then verify(what=['erc','drc'])")).toBe("then pcb_review");
  });
});
