/** What a placed and routed board still needs to be a finished one. */
import type { Scene } from "./scene.ts";

export type FinishingEdit =
  | { readonly op: "pour"; readonly net: string }
  | { readonly op: "tidy_labels" };

/**
 * Ground poured over the free copper, unless the board already has a pour, and
 * every reference set beside its part.
 */
export function finishingEdits(scene: Scene): ReadonlyArray<FinishingEdit> {
  const poured = scene.items.some((item) => item.kind === "zone" && item.net !== undefined);
  const ground = scene.items.find(
    (item) => item.kind === "pad" && item.net?.replace(/^\//, "").toUpperCase() === "GND",
  )?.net;
  return [
    ...(ground && !poured ? [{ op: "pour", net: ground } as const] : []),
    { op: "tidy_labels" },
  ];
}
