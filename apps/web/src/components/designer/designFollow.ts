/** Following the agent: when it works on the design, the designer opens on the page it is changing. */
import type { ScopedThreadRef } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { useEffect, useRef } from "react";
import { create } from "zustand";

import type { ThreadStructureVisibleTurnItem } from "@t3tools/client-runtime/state/shell";

import { useRightPanelStore } from "../../rightPanelStore";

export type DesignPage = "schematic" | "board";

/** What each Copper tool does, as the designer says it while the agent runs it. */
const COPPER_WORK: Readonly<Record<string, readonly [DesignPage, string]>> = {
  sch_apply: ["schematic", "Drawing the schematic"],
  sch_tidy: ["schematic", "Tidying the schematic"],
  sch_read: ["schematic", "Reading the schematic"],
  parts_search: ["schematic", "Looking for parts"],
  parts_get: ["schematic", "Looking up a part"],
  parts_import: ["schematic", "Adding a part to the library"],
  parts_source_bom: ["schematic", "Finding a part for each line of the BOM"],
  parts_alternatives: ["schematic", "Looking for other parts that fit"],
  design_review: ["schematic", "Reviewing the design"],
  board_build: ["board", "Building the board: placing, routing, checking"],
  pcb_sync: ["board", "Bringing the schematic onto the board"],
  pcb_setup: ["board", "Setting up the board"],
  pcb_place: ["board", "Placing parts"],
  pcb_route_plan: ["board", "Planning the routing"],
  pcb_route_guided: ["board", "Routing to a plan"],
  pcb_route: ["board", "Routing the board"],
  pcb_pour: ["board", "Pouring copper"],
  pcb_edit: ["board", "Editing the board"],
  pcb_read: ["board", "Reading the board"],
  verify: ["board", "Checking the design"],
  render: ["board", "Taking a picture of the design"],
  fab_export: ["board", "Making the order files"],
  export: ["board", "Exporting files"],
};

/** The last part of a tool's name; providers prefix it, e.g. mcp__t3-code__copper. */
const bareName = (toolName: string | null | undefined) => toolName?.split(/__|[./:]/).at(-1);

/** The page a design tool call works on and what it is doing; none for other tools. */
export function designWorkOfTool(
  toolName: string | null | undefined,
  input: unknown,
): { readonly page: DesignPage; readonly working: string; readonly why?: string } | undefined {
  if (bareName(toolName) !== "copper" || typeof input !== "object" || input === null) {
    return undefined;
  }
  const tool = (input as { readonly tool?: unknown }).tool;
  const work = typeof tool === "string" ? COPPER_WORK[tool] : undefined;
  const why = (input as { readonly why?: unknown }).why;
  return work
    ? {
        page: work[0],
        working: work[1],
        ...(typeof why === "string" && why.trim() !== "" ? { why: why.trim() } : {}),
      }
    : undefined;
}

/** How long after a design tool ran it still pulls the designer to its page. */
const FRESH_MS = 20_000;

export interface DesignCall {
  readonly id: string;
  readonly page: DesignPage;
  /** What the agent is doing, shown while the call runs. */
  readonly working: string;
  /** The agent's own reason for the call, when it gave one. */
  readonly why?: string;
  readonly live: boolean;
}

/** The agent's newest design tool call, if it is running or has only just finished. */
export function freshDesignCall(
  items: ReadonlyArray<ThreadStructureVisibleTurnItem>,
  now: number,
): DesignCall | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]?.item;
    if (item?.type !== "dynamic_tool") continue;
    const work = designWorkOfTool(item.toolName, item.input);
    if (!work) continue;
    const live = item.status === "pending" || item.status === "running";
    const fresh = now - DateTime.toEpochMillis(item.updatedAt) < FRESH_MS;
    return live || fresh ? { id: item.id, ...work, live } : undefined;
  }
  return undefined;
}

interface DesignFocus {
  readonly threadId: string;
  readonly call: DesignCall;
}

export const useDesignFocusStore = create<{ focus?: DesignFocus }>(() => ({}));

/** Opens the designer on the page of each new design tool call of the thread. */
export function useDesignFollow(
  threadRef: ScopedThreadRef | null | undefined,
  items: ReadonlyArray<ThreadStructureVisibleTurnItem>,
) {
  const followed = useRef<string | undefined>(undefined);
  const environmentId = threadRef?.environmentId;
  const threadId = threadRef?.threadId;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reacts to the agent's tool calls arriving from the server by opening the designer
  useEffect(() => {
    if (!environmentId || !threadId) return;
    const call = freshDesignCall(items, Date.now());
    const shown = useDesignFocusStore.getState().focus;
    if (!call) {
      // A call that has ended stops showing as running.
      if (shown?.threadId === threadId && shown.call.live) {
        useDesignFocusStore.setState({ focus: { threadId, call: { ...shown.call, live: false } } });
      }
      return;
    }
    if (followed.current !== call.id) {
      followed.current = call.id;
      useRightPanelStore.getState().open({ environmentId, threadId }, "designer");
    }
    if (
      shown?.threadId !== threadId ||
      shown.call.id !== call.id ||
      shown.call.live !== call.live
    ) {
      useDesignFocusStore.setState({ focus: { threadId, call } });
    }
  }, [environmentId, threadId, items]);
}
