import type { Scene, SceneItem } from "@t3tools/shared/kicad/scene";
import { describe, expect, it } from "vite-plus/test";

import { antennaArea, auditBoard } from "./boardAudit.ts";

const box = (minX: number, minY: number, maxX: number, maxY: number) => ({
  minX,
  minY,
  maxX,
  maxY,
});
const item = (fields: Partial<SceneItem> & Pick<SceneItem, "id" | "kind" | "box">): SceneItem => ({
  shapes: [],
  ...fields,
});
// A module 20 wide and 26 tall whose top 7 mm carries the antenna, on a 40 x 52 board.
const module = item({
  id: "u1",
  kind: "footprint",
  ref: "U1",
  value: "ESP32-S3-WROOM-1",
  box: box(10, 0, 30, 26),
});
const pads = [
  item({ id: "p1", kind: "pad", ref: "U1", layer: "F.Cu", box: box(10, 7, 11, 8) }),
  item({ id: "p2", kind: "pad", ref: "U1", layer: "F.Cu", box: box(29, 25, 30, 26) }),
];
const edge = item({ id: "edge", kind: "graphic", layer: "Edge.Cuts", box: box(0, 0, 40, 52) });
const scene = (...extra: ReadonlyArray<SceneItem>): Scene => ({
  kind: "board",
  items: [module, ...pads, edge, ...extra],
  bounds: box(0, 0, 40, 52),
  layers: ["F.Cu", "B.Cu"],
});

describe("antennaArea", () => {
  it("finds the end of the body that reaches past the pads", () => {
    expect(antennaArea(box(10, 0, 30, 26), box(10, 7, 30, 26))).toEqual({
      side: "top",
      area: box(10, 0, 30, 6),
    });
  });

  it("finds none on a part whose pads fill its body", () => {
    expect(antennaArea(box(0, 0, 5, 5), box(0.5, 0.5, 4.5, 4.5))).toBeUndefined();
  });
});

describe("auditBoard", () => {
  it("passes a module on the edge with nothing by its antenna", () => {
    expect(auditBoard(scene())).toEqual([]);
  });

  it("names a part beside the antenna and a track under it", () => {
    const points = auditBoard(
      scene(
        item({ id: "r5", kind: "pad", ref: "R5", layer: "F.Cu", box: box(31, 2, 32, 3) }),
        item({ id: "t1", kind: "track", net: "/EN", layer: "B.Cu", box: box(12, 3, 20, 3.2) }),
      ),
    );
    expect(points).toHaveLength(1);
    expect(points[0]?.type).toBe("audit_antenna_copper");
    expect(points[0]?.description).toContain("R5");
    expect(points[0]?.description).toContain("net /EN");
  });

  it("sees a pour that covers the antenna though none of its corners lie there", () => {
    const pour = item({
      id: "z",
      kind: "zone",
      title: "Copper zone",
      layer: "B.Cu",
      box: box(0, 0, 40, 52),
      shapes: [
        {
          kind: "polygon",
          points: [
            { x: 0, y: 0 },
            { x: 40, y: 0 },
            { x: 40, y: 52 },
            { x: 0, y: 52 },
          ],
          width: 0,
          paint: "B.Cu",
          fill: "B.Cu",
        },
      ],
    });
    expect(auditBoard(scene(pour))[0]?.description).toContain("the copper pour");
  });

  it("says when the antenna sits inside the board", () => {
    const inland: Scene = {
      ...scene(),
      items: [module, ...pads, item({ ...edge, box: box(0, -10, 40, 52) })],
    };
    const points = auditBoard(inland);
    expect(points.map((point) => point.type)).toEqual(["audit_antenna_edge"]);
    expect(points[0]?.description).toContain("10.0 mm inside");
  });

  it("leaves parts that are not radio modules alone", () => {
    const plain: Scene = { ...scene(), items: [{ ...module, value: "AMS1117" }, ...pads, edge] };
    expect(auditBoard(plain)).toEqual([]);
  });
});
