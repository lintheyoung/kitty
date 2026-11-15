import { describe, expect, it } from "vite-plus/test";

import {
  chosenEngineCommit,
  engineChoiceText,
  enginePictures,
  parseEngineNews,
  parseEngineReply,
  parseLayoutReview,
} from "./boardEngine.ts";

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

  it("finds the pictures a report names", () => {
    expect(
      enginePictures(
        '{"image":"copper-out/render/pcb-top.png","images":["copper-out/a.png","copper-out/render/pcb-top.png"]}',
      ),
    ).toEqual(["copper-out/render/pcb-top.png", "copper-out/a.png"]);
    expect(enginePictures('{"routed":3}')).toEqual([]);
  });
});

describe("parseEngineNews", () => {
  const sha = (letter: string) => letter.repeat(40);

  it("gives the newest commit and the first line of each new one, newest first", () => {
    const news = parseEngineNews(
      JSON.stringify({
        ahead_by: 2,
        commits: [
          { sha: sha("a"), commit: { message: "Route diff pairs\n\nlong text" } },
          { sha: sha("b"), commit: { message: "Fix pour clearance" } },
        ],
      }),
    );
    expect(news).toEqual({
      latest: sha("b"),
      behind: 2,
      notes: ["Fix pour clearance", "Route diff pairs"],
    });
  });

  it("says nothing is new when the commit in use is the newest", () => {
    expect(parseEngineNews(JSON.stringify({ ahead_by: 0, commits: [] }))).toEqual({
      behind: 0,
      notes: [],
    });
  });

  it("does not take an error page for news", () => {
    expect(parseEngineNews('{"message":"API rate limit exceeded"}')).toBeUndefined();
    expect(parseEngineNews("<html>")).toBeUndefined();
  });
});

describe("chosenEngineCommit", () => {
  it("reads back the commit it wrote and ignores anything that is not one", () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    expect(chosenEngineCommit(engineChoiceText(commit))).toBe(commit);
    expect(chosenEngineCommit('{"commit":"main; rm -rf"}')).toBeUndefined();
    expect(chosenEngineCommit("not json")).toBeUndefined();
    expect(chosenEngineCommit(undefined)).toBeUndefined();
  });
});
