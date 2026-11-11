import { describe, expect, it } from "vite-plus/test";

import { ratsnest } from "./ratsnest.ts";
import type { Scene, SceneItem } from "./scene.ts";

const pad = (id: string, x: number, net: string): SceneItem => ({
  id,
  kind: "pad",
  net,
  box: { minX: x - 0.5, minY: -0.5, maxX: x + 0.5, maxY: 0.5 },
  shapes: [],
});
const track = (id: string, from: number, to: number, net: string): SceneItem => ({
  id,
  kind: "track",
  net,
  box: { minX: from, minY: 0, maxX: to, maxY: 0 },
  shapes: [
    {
      kind: "line",
      points: [
        { x: from, y: 0 },
        { x: to, y: 0 },
      ],
      width: 0.2,
      paint: "F.Cu",
    },
  ],
});
const scene = (...items: ReadonlyArray<SceneItem>): Scene => ({
  kind: "board",
  items,
  bounds: { minX: 0, minY: 0, maxX: 100, maxY: 10 },
  layers: [],
});
const spans = (board: Scene) =>
  ratsnest(board).map((wire) => `${wire.net}:${wire.from.x}-${wire.to.x}`);

describe("ratsnest", () => {
  it("joins the pads of a net with the shortest lines", () => {
    expect(spans(scene(pad("a", 0, "SDA"), pad("b", 30, "SDA"), pad("c", 10, "SDA")))).toEqual([
      "SDA:0-10",
      "SDA:30-10",
    ]);
  });

  it("leaves out what tracks already join, and nets with one pad or a zone", () => {
    const zone: SceneItem = { ...pad("z", 0, "GND"), kind: "zone" };
    const board = scene(
      pad("a", 0, "SDA"),
      pad("b", 10, "SDA"),
      pad("c", 30, "SDA"),
      // Two tracks end to end reach from the first pad to the second.
      track("t1", 0, 5, "SDA"),
      track("t2", 5, 10, "SDA"),
      pad("d", 50, "LED"),
      pad("e", 60, "GND"),
      pad("f", 70, "GND"),
      zone,
      pad("g", 80, "unconnected-(U1-Pad3)"),
      pad("h", 90, "unconnected-(U1-Pad3)"),
    );
    expect(spans(board)).toEqual(["SDA:10-30"]);
  });
});
