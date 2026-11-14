import type { Scene, SceneItem } from "@t3tools/shared/kicad/scene";
import { describe, expect, it } from "vite-plus/test";

import { describeSceneChange } from "./designChange.ts";

const part = (ref: string, x: number, over: Partial<SceneItem> = {}): SceneItem => ({
  id: ref,
  kind: "footprint",
  box: { minX: x - 1, minY: 9, maxX: x + 1, maxY: 11 },
  shapes: [],
  ref,
  ...over,
});
const track = (id: string): SceneItem => ({
  id,
  kind: "track",
  box: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
  shapes: [],
});
const scene = (items: ReadonlyArray<SceneItem>): Scene => ({ kind: "board", items }) as Scene;

describe("describeSceneChange", () => {
  it("says which parts came, went, moved and changed, and how the copper counts moved", () => {
    const before = scene([
      part("R1", 10, { value: "10k" }),
      part("C1", 20),
      part("U1", 30, { pins: [{ number: "3", name: "EN", at: { x: 0, y: 0 }, net: "EN" }] }),
      track("t1"),
    ]);
    const after = scene([
      part("R1", 14, { value: "4.7k" }),
      part("U1", 30, { pins: [{ number: "3", name: "EN", at: { x: 0, y: 0 }, net: "RESET" }] }),
      part("D1", 40, { value: "Red" }),
      track("t1"),
      track("t2"),
      track("t3"),
    ]);
    expect(describeSceneChange(before, after)).toEqual([
      "Added D1 (Red)",
      "Removed C1",
      "Moved R1 from (10.0, 10.0) to (14.0, 10.0)",
      "Changed the value of R1 from 10k to 4.7k",
      "Reconnected U1 pin 3 from EN to RESET",
      "Counts changed: tracks 1 to 3",
    ]);
    expect(describeSceneChange(before, before)).toEqual([]);
  });
});
