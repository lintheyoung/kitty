import { describe, expect, it } from "vite-plus/test";

import type { Scene, SceneItem } from "./scene.ts";
import { diffScenes } from "./sceneDiff.ts";

const wire = (id: string, x: number, length = 10): SceneItem => ({
  id,
  kind: "wire",
  box: { minX: x, minY: 0, maxX: x + length, maxY: 0 },
  shapes: [
    {
      kind: "line",
      points: [
        { x, y: 0 },
        { x: x + length, y: 0 },
      ],
      width: 0.15,
      paint: "wire",
    },
  ],
});

const scene = (...items: ReadonlyArray<SceneItem>): Scene => ({
  kind: "schematic",
  items,
  bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
  layers: [],
});

describe("diffScenes", () => {
  it("finds nothing between identical drawings", () => {
    const diff = diffScenes(scene(wire("a", 0)), scene(wire("a", 0)));
    expect([...diff.added]).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.box).toBeUndefined();
  });

  it("reports new, removed and moved items", () => {
    const diff = diffScenes(
      scene(wire("kept", 0), wire("gone", 20), wire("moved", 40)),
      scene(wire("kept", 0), wire("moved", 60), wire("new", 80)),
    );
    expect([...diff.added]).toEqual(["moved", "new"]);
    expect(diff.removed.map((item) => [item.id, item.box.minX])).toEqual([
      ["moved", 40],
      ["gone", 20],
    ]);
    expect(diff.box).toEqual({ minX: 20, minY: 0, maxX: 90, maxY: 0 });
  });

  it("marks an item changed in place without a ghost of the old one", () => {
    const diff = diffScenes(scene(wire("a", 0)), scene({ ...wire("a", 0, 10), shapes: [] }));
    expect([...diff.added]).toEqual(["a"]);
    expect(diff.removed).toEqual([]);
  });
});
