/** Following the agent: when it works on the design, the designer opens on the page it is changing. */
import type { ScopedThreadRef } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { useEffect, useRef } from "react";
import { create } from "zustand";

import type { ThreadStructureVisibleTurnItem } from "@t3tools/client-runtime/state/shell";

import { useRightPanelStore } from "../../rightPanelStore";

export type DesignPage = "schematic" | "board";

const PAGE_OF_TOOL: Readonly<Record<string, DesignPage>> = {
  sch_edit: "schematic",
  sch_tidy: "schematic",
  kicad_erc: "schematic",
  pcb_sync: "board",
  pcb_edit: "board",
  pcb_autoroute: "board",
  pcb_pour: "board",
  pcb_silkscreen: "board",
  kicad_drc: "board",
  kicad_fab_export: "board",
};

/** The page a tool works on; providers prefix tool names, e.g. mcp__t3-code__pcb_edit. */
export function designPageOfTool(toolName: string | null | undefined): DesignPage | undefined {
  const name = toolName?.split(/__|[./:]/).at(-1);
  return name ? PAGE_OF_TOOL[name] : undefined;
}

/** How long after a design tool ran it still pulls the designer to its page. */
const FRESH_MS = 20_000;

export interface DesignCall {
  readonly id: string;
  readonly page: DesignPage;
}

/** The agent's newest design tool call, if it is running or has only just finished. */
export function freshDesignCall(
  items: ReadonlyArray<ThreadStructureVisibleTurnItem>,
  now: number,
): DesignCall | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]?.item;
    if (item?.type !== "dynamic_tool") continue;
    const page = designPageOfTool(item.toolName);
    if (!page) continue;
    const live = item.status === "pending" || item.status === "running";
    const fresh = now - DateTime.toEpochMillis(item.updatedAt) < FRESH_MS;
    return live || fresh ? { id: item.id, page } : undefined;
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
    if (!call || followed.current === call.id) return;
    followed.current = call.id;
    useRightPanelStore.getState().open({ environmentId, threadId }, "designer");
    useDesignFocusStore.setState({ focus: { threadId, call } });
  }, [environmentId, threadId, items]);
}
