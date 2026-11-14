/** What changed between two versions of a design file, in words an agent can act on. */
import { buildBoardScene } from "@t3tools/shared/kicad/boardScene";
import type { Scene, SceneItem } from "@t3tools/shared/kicad/scene";
import { buildSchematicScene } from "@t3tools/shared/kicad/schematicScene";

const LISTED = 12;
const COUNTED: ReadonlyArray<readonly [SceneItem["kind"], string]> = [
  ["wire", "wires"],
  ["label", "labels"],
  ["track", "tracks"],
  ["via", "vias"],
  ["zone", "copper pours and keep-outs"],
];

const centre = (item: SceneItem) =>
  `(${((item.box.minX + item.box.maxX) / 2).toFixed(1)}, ${((item.box.minY + item.box.maxY) / 2).toFixed(1)})`;
const named = (item: SceneItem) => (item.value ? `${item.ref} (${item.value})` : `${item.ref}`);
const listed = (items: ReadonlyArray<string>) =>
  items.length <= LISTED
    ? items.join(", ")
    : `${items.slice(0, LISTED).join(", ")} and ${items.length - LISTED} more`;

function parts(scene: Scene): Map<string, SceneItem> {
  const found = new Map<string, SceneItem>();
  for (const item of scene.items) {
    if (item.kind !== "symbol" && item.kind !== "footprint") continue;
    if (!item.ref || item.ref.startsWith("#")) continue;
    found.set(item.ref, item);
  }
  return found;
}

const netsOf = (item: SceneItem) =>
  new Map((item.pins ?? []).map((pin) => [pin.number, pin.net ?? ""] as const));

/** The differences between two scenes of the same drawing, most telling first. */
export function describeSceneChange(before: Scene, after: Scene): ReadonlyArray<string> {
  const was = parts(before);
  const now = parts(after);
  const lines: Array<string> = [];
  const added = [...now.values()].filter((item) => !was.has(item.ref ?? ""));
  const removed = [...was.values()].filter((item) => !now.has(item.ref ?? ""));
  if (added.length > 0) lines.push(`Added ${listed(added.map(named))}`);
  if (removed.length > 0) lines.push(`Removed ${listed(removed.map(named))}`);
  const moved: Array<string> = [];
  const revalued: Array<string> = [];
  const rewired: Array<string> = [];
  for (const [ref, item] of now) {
    const old = was.get(ref);
    if (!old) continue;
    if (centre(old) !== centre(item)) moved.push(`${ref} from ${centre(old)} to ${centre(item)}`);
    if ((old.value ?? "") !== (item.value ?? "")) {
      revalued.push(`${ref} from ${old.value ?? "nothing"} to ${item.value ?? "nothing"}`);
    }
    const oldNets = netsOf(old);
    for (const [pin, net] of netsOf(item)) {
      const earlier = oldNets.get(pin);
      if (earlier === undefined || earlier === net) continue;
      rewired.push(`${ref} pin ${pin} from ${earlier || "no net"} to ${net || "no net"}`);
    }
  }
  if (moved.length > 0) lines.push(`Moved ${listed(moved)}`);
  if (revalued.length > 0) lines.push(`Changed the value of ${listed(revalued)}`);
  if (rewired.length > 0) lines.push(`Reconnected ${listed(rewired)}`);
  const counts = COUNTED.flatMap(([kind, name]) => {
    const count = (scene: Scene) => scene.items.filter((item) => item.kind === kind).length;
    const [from, to] = [count(before), count(after)];
    return from === to ? [] : [`${name} ${from} to ${to}`];
  });
  if (counts.length > 0) lines.push(`Counts changed: ${counts.join(", ")}`);
  return lines;
}

/** What differs between two saved versions of a schematic or board; empty when it cannot be read. */
export function describeDesignChange(
  kind: "schematic" | "board",
  before: string,
  after: string,
): ReadonlyArray<string> {
  try {
    return kind === "board"
      ? describeSceneChange(buildBoardScene(before), buildBoardScene(after))
      : describeSceneChange(buildSchematicScene(before).scene, buildSchematicScene(after).scene);
  } catch {
    return [];
  }
}

/** Where a design stands, in one line: how much is drawn, placed and routed. */
export function describeDesignState(
  schematic: string | undefined,
  board: string | undefined,
  unrouted: number | undefined,
): string {
  const count = (scene: Scene, kind: SceneItem["kind"]) =>
    scene.items.filter((item) => item.kind === kind).length;
  const facts: Array<string> = [];
  try {
    if (schematic !== undefined) {
      facts.push(`schematic: ${parts(buildSchematicScene(schematic).scene).size} parts`);
    }
    if (board !== undefined) {
      const scene = buildBoardScene(board);
      const left = unrouted === undefined ? "" : `, ${unrouted} connections unrouted`;
      facts.push(
        `board: ${parts(scene).size} parts, ${count(scene, "track")} tracks, ${count(scene, "via")} vias${left}`,
      );
    }
  } catch {
    return "";
  }
  return facts.join("; ");
}
