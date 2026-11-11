/** What changed between two versions of a drawing, for showing an edit before it is kept. */
import { type Box, type Scene, type SceneItem, unionBoxes } from "./scene.ts";

export interface SceneDiff {
  /** Ids of items in the new drawing that are new or look different. */
  readonly added: ReadonlySet<string>;
  /** Items of the old drawing that are gone, or that now sit somewhere else. */
  readonly removed: ReadonlyArray<SceneItem>;
  /** The area the changes cover; undefined when nothing changed. */
  readonly box: Box | undefined;
}

const sameBox = (a: Box, b: Box) =>
  a.minX === b.minX && a.minY === b.minY && a.maxX === b.maxX && a.maxY === b.maxY;

/** Compares items by id; an item whose shapes differ counts as changed. */
export function diffScenes(before: Scene, after: Scene): SceneDiff {
  const old = new Map(before.items.map((item) => [item.id, item]));
  const added = new Set<string>();
  const removed: Array<SceneItem> = [];
  const boxes: Array<Box> = [];
  for (const item of after.items) {
    const was = old.get(item.id);
    old.delete(item.id);
    if (was && JSON.stringify(was.shapes) === JSON.stringify(item.shapes)) continue;
    added.add(item.id);
    boxes.push(item.box);
    // A moved item also shows where it used to be.
    if (was && !sameBox(was.box, item.box)) {
      removed.push(was);
      boxes.push(was.box);
    }
  }
  for (const item of old.values()) {
    removed.push(item);
    boxes.push(item.box);
  }
  return { added, removed, box: unionBoxes(boxes) };
}
