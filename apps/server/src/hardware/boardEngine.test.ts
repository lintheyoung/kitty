import { describe, expect, it } from "vite-plus/test";

import { parseEngineReply } from "./boardEngine.ts";

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
});
