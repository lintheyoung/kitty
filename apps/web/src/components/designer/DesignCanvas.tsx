import type { Point, Scene, SceneItem } from "@t3tools/shared/kicad/scene";
import type { SceneDiff } from "@t3tools/shared/kicad/sceneDiff";
import { MaximizeIcon, MinusIcon, PlusIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import { CanvasController } from "./canvasController.ts";
import type { Marker } from "./sceneRenderer.ts";
import {
  DIFF_ADDED_COLOR,
  DIFF_REMOVED_COLOR,
  paletteFor,
  SELECTION_COLOR,
  SELECTION_COLOR_LIGHT,
} from "./scenePaint.ts";

const FONT_FAMILY = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

/** A zoomable, clickable drawing of a schematic sheet or a board. */
export function DesignCanvas(props: {
  readonly scene: Scene;
  readonly dark: boolean;
  /** Paints (layers) not drawn. */
  readonly hidden: ReadonlySet<string>;
  readonly selectedIds: ReadonlySet<string>;
  /** When set, items it rejects are dimmed. */
  readonly focus?: ((item: SceneItem) => boolean) | undefined;
  /** An item to bring into view, e.g. after cross-probing from the other drawing. */
  readonly reveal?: SceneItem | undefined;
  readonly markers?: ReadonlyArray<Marker> | undefined;
  /** A change under review, marked on the drawing. */
  readonly diff?: SceneDiff | undefined;
  readonly onPick: (item: SceneItem | undefined) => void;
  /** Items that can be dragged to a new place, and what to do when one is dropped. */
  readonly movable?: ((item: SceneItem) => boolean) | undefined;
  readonly onMove?: ((item: SceneItem, by: Point) => void) | undefined;
  /** When set, the canvas is in its wire tool and reports each wire drawn. */
  readonly onWire?: ((points: ReadonlyArray<Point>) => void) | undefined;
  readonly className?: string;
}) {
  const controller = useRef<CanvasController | null>(null);
  const attach = (canvas: HTMLCanvasElement) => {
    const created = new CanvasController(canvas);
    controller.current = created;
    return () => {
      created.destroy();
      controller.current = null;
    };
  };
  const { scene, dark, hidden, selectedIds, focus, onPick, reveal, markers, movable, onMove } =
    props;
  const { onWire, diff } = props;
  // The board always sits on a dark canvas, so its selection outline stays light.
  const lightSurface = scene.kind === "schematic" && !dark;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes the latest drawing and options into the imperative canvas controller
  useEffect(() => {
    controller.current?.update({
      scene,
      onPick,
      movable,
      onMove,
      onWire,
      options: {
        color: paletteFor(scene, dark),
        hidden,
        selection: selectedIds,
        selectionColor: lightSurface ? SELECTION_COLOR_LIGHT : SELECTION_COLOR,
        focus,
        fontFamily: FONT_FAMILY,
        markers,
        diff: diff
          ? {
              added: diff.added,
              removed: diff.removed,
              addedColor: DIFF_ADDED_COLOR,
              removedColor: DIFF_REMOVED_COLOR,
            }
          : undefined,
      },
    });
  }, [
    scene,
    dark,
    hidden,
    selectedIds,
    focus,
    onPick,
    lightSurface,
    markers,
    movable,
    onMove,
    onWire,
    diff,
  ]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the imperative canvas to an item chosen outside it
  useEffect(() => {
    if (reveal) controller.current?.reveal(reveal);
  }, [reveal]);
  return (
    <div
      className={cn(
        "relative min-h-0 min-w-0",
        scene.kind === "board" && "bg-pcb",
        props.className,
      )}
    >
      <canvas
        ref={attach}
        aria-label={scene.kind === "board" ? "Board drawing" : "Schematic drawing"}
        className="absolute inset-0 block size-full cursor-crosshair touch-none"
      />
      <div className="absolute right-2 bottom-2 flex gap-1 rounded-md border bg-background/90 p-0.5 shadow-sm">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Zoom out"
          onClick={() => controller.current?.zoom(1 / 1.4)}
        >
          <MinusIcon />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Zoom in"
          onClick={() => controller.current?.zoom(1.4)}
        >
          <PlusIcon />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Fit to window"
          onClick={() => controller.current?.fit()}
        >
          <MaximizeIcon />
        </Button>
      </div>
    </div>
  );
}
