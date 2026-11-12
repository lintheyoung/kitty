import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";

import { designPageOfTool, freshDesignCall } from "./designFollow.ts";

const NOW = Date.parse("2026-11-12T10:00:00Z");
const tool = (id: string, toolName: string, status: string, secondsAgo: number) =>
  ({
    item: {
      type: "dynamic_tool",
      id,
      toolName,
      status,
      updatedAt: DateTime.makeUnsafe(NOW - secondsAgo * 1000),
    },
  }) as unknown as Parameters<typeof freshDesignCall>[0][number];

describe("designPageOfTool", () => {
  it("knows the page of a design tool whatever the provider's prefix", () => {
    expect(designPageOfTool("sch_edit")).toBe("schematic");
    expect(designPageOfTool("mcp__t3-code__pcb_edit")).toBe("board");
    expect(designPageOfTool("t3-code.pcb_autoroute")).toBe("board");
    expect(designPageOfTool("hw_build")).toBeUndefined();
    expect(designPageOfTool(null)).toBeUndefined();
  });
});

describe("freshDesignCall", () => {
  it("follows the newest design call while it runs or has just finished", () => {
    const items = [
      tool("a", "mcp__t3-code__sch_edit", "completed", 300),
      tool("b", "mcp__t3-code__pcb_edit", "running", 90),
      tool("c", "mcp__t3-code__hw_build", "running", 1),
    ];
    expect(freshDesignCall(items, NOW)).toEqual({ id: "b", page: "board" });
    expect(freshDesignCall([tool("a", "sch_edit", "completed", 5)], NOW)).toEqual({
      id: "a",
      page: "schematic",
    });
  });

  it("leaves old work alone, so opening a thread does not move the designer", () => {
    expect(freshDesignCall([tool("a", "pcb_edit", "completed", 300)], NOW)).toBeUndefined();
    expect(freshDesignCall([], NOW)).toBeUndefined();
  });
});
