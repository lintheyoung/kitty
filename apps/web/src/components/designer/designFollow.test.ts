import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";

import { designWorkOfTool, freshDesignCall } from "./designFollow.ts";

const NOW = Date.parse("2026-11-12T10:00:00Z");
const tool = (id: string, copperTool: string, status: string, secondsAgo: number) =>
  ({
    item: {
      type: "dynamic_tool",
      id,
      toolName: copperTool === "hw_build" ? "mcp__t3-code__hw_build" : "mcp__t3-code__copper",
      input: { path: "hardware/kicad", tool: copperTool },
      status,
      updatedAt: DateTime.makeUnsafe(NOW - secondsAgo * 1000),
    },
  }) as unknown as Parameters<typeof freshDesignCall>[0][number];

describe("designWorkOfTool", () => {
  it("reads the Copper tool from the call, whatever the provider's prefix", () => {
    expect(designWorkOfTool("copper", { tool: "sch_apply" })).toEqual({
      page: "schematic",
      working: "Drawing the schematic",
    });
    expect(designWorkOfTool("t3-code.copper", { tool: "pcb_route" })?.page).toBe("board");
    expect(designWorkOfTool("mcp__t3-code__copper", { tool: "copper_help" })).toBeUndefined();
    expect(designWorkOfTool("hw_build", { tool: "pcb_route" })).toBeUndefined();
    expect(designWorkOfTool(null, undefined)).toBeUndefined();
  });
});

describe("freshDesignCall", () => {
  it("follows the newest design call while it runs or has just finished", () => {
    const items = [
      tool("a", "sch_apply", "completed", 300),
      tool("b", "pcb_route", "running", 90),
      tool("c", "hw_build", "running", 1),
    ];
    expect(freshDesignCall(items, NOW)).toEqual({
      id: "b",
      page: "board",
      working: "Routing the board",
      live: true,
    });
    expect(freshDesignCall([tool("a", "sch_tidy", "completed", 5)], NOW)).toMatchObject({
      id: "a",
      page: "schematic",
      live: false,
    });
  });

  it("leaves old work alone, so opening a thread does not move the designer", () => {
    expect(freshDesignCall([tool("a", "pcb_edit", "completed", 300)], NOW)).toBeUndefined();
    expect(freshDesignCall([], NOW)).toBeUndefined();
  });
});
