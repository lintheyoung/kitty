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

  it("leaves out what tracks already join, and nets with one pad", () => {
    const board = scene(
      pad("a", 0, "SDA"),
      pad("b", 10, "SDA"),
      pad("c", 30, "SDA"),
      // Two tracks end to end reach from the first pad to the second.
      track("t1", 0, 5, "SDA"),
      track("t2", 5, 10, "SDA"),
      pad("d", 50, "LED"),
      pad("g", 80, "unconnected-(U1-Pad3)"),
      pad("h", 90, "unconnected-(U1-Pad3)"),
    );
    expect(spans(board)).toEqual(["SDA:10-30"]);
  });

  it("joins what lies on the same filled piece of a zone, on its layer", () => {
    const fill = (
      id: string,
      from: number,
      to: number,
      layer: string,
      filled = true,
    ): SceneItem => ({
      id,
      kind: "zone",
      net: "GND",
      layer,
      box: { minX: from, minY: -5, maxX: to, maxY: 5 },
      shapes: [
        {
          kind: "polygon",
          points: [
            { x: from, y: -5 },
            { x: to, y: -5 },
            { x: to, y: 5 },
            { x: from, y: 5 },
          ],
          width: 0,
          paint: layer,
          ...(filled ? { fill: layer } : {}),
        },
      ],
    });
    const front = (id: string, x: number): SceneItem => ({ ...pad(id, x, "GND"), layer: "F.Cu" });
    const via: SceneItem = { ...pad("v", 60, "GND"), kind: "via" };
    // Two front pads on a front pour are joined; a pad off it is not.
    expect(
      spans(scene(front("a", 0), front("b", 20), front("c", 50), fill("z", -2, 30, "F.Cu"))),
    ).toEqual(["GND:20-50"]);
    // A back pour does not reach front pads, until vias bring them down to it.
    const back = fill("z", -2, 70, "B.Cu");
    expect(spans(scene(front("a", 0), front("b", 60), back))).toEqual(["GND:0-60"]);
    const down: SceneItem = { ...pad("w", 0, "GND"), kind: "via" };
    expect(spans(scene(front("a", 0), front("b", 60), back, via, down))).toEqual([]);
    // An unfilled zone joins nothing.
    const drawn = fill("z", -2, 70, "B.Cu", false);
    expect(spans(scene(front("a", 0), front("b", 60), drawn, via, down))).toEqual(["GND:0-60"]);
  });

  it("counts a track that ends on the middle of another as joined", () => {
    const stub: SceneItem = {
      ...track("t2", 0, 0, "SDA"),
      shapes: [
        {
          kind: "line",
          points: [
            { x: 15, y: 0 },
            { x: 15, y: 5 },
          ],
          width: 0.2,
          paint: "F.Cu",
        },
      ],
    };
    const far: SceneItem = {
      ...pad("b", 15, "SDA"),
      box: { minX: 14.5, minY: 4.5, maxX: 15.5, maxY: 5.5 },
    };
    expect(spans(scene(pad("a", 0, "SDA"), far, track("t1", 0, 30, "SDA"), stub))).toEqual([]);
  });

  it("does not join a pad to a track on the other side of the board", () => {
    const back: SceneItem = { ...track("t", 0, 30, "SDA"), layer: "B.Cu" };
    const front = (id: string, x: number): SceneItem => ({ ...pad(id, x, "SDA"), layer: "F.Cu" });
    expect(spans(scene(front("a", 0), front("b", 30), back))).toEqual(["SDA:0-30"]);
  });
});
