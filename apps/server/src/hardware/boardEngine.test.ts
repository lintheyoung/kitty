import { describe, expect, it } from "vite-plus/test";

import { parseEngineReply, parseLayoutReview } from "./boardEngine.ts";

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

  it("turns the layout review into a score and findings in plain words", () => {
    const report = JSON.stringify({
      elegance: {
        score: 79.8,
        worst: [
          {
            what: "decap_far",
            value: "C4 5.46 mm from U2.2",
            target: "<= 3 mm",
            fix: "pcb_place(moves=[{ref:'C4', x:.., y:..}]) next to U2.2",
          },
          { what: "something_new", value: 3 },
        ],
      },
    });
    expect(parseLayoutReview(report)).toEqual({
      score: 79.8,
      points: [
        {
          type: "layout_decap_far",
          description:
            "Decoupling capacitors are far from the pins they serve: C4 5.46 mm from U2.2 (aim: <= 3 mm)",
          fix: "pcb_place(moves=[{ref:'C4', x:.., y:..}]) next to U2.2",
        },
        { type: "layout_something_new", description: "something new: 3" },
      ],
    });
    expect(parseLayoutReview("not json")).toEqual({ points: [] });
    expect(parseLayoutReview('{"tracks":3}')).toEqual({ points: [] });
  });
});
