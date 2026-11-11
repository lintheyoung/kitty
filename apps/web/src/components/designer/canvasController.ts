/** Owns one canvas: its view, pointer handling and redraws. React only feeds it props. */
import { pickItem } from "@t3tools/shared/kicad/pick";
import type { Point, Scene, SceneItem } from "@t3tools/shared/kicad/scene";

import { observeResize } from "~/lib/observeResize";

import { type DrawOptions, drawScene, fitView, type View, zoomAt } from "./sceneRenderer.ts";

export interface CanvasState {
  readonly scene: Scene;
  readonly options: DrawOptions;
  readonly onPick: (item: SceneItem | undefined) => void;
  /** When set, items it accepts can be dragged; the drop reports how far, in millimetres. */
  readonly movable?: ((item: SceneItem) => boolean) | undefined;
  readonly onMove?: ((item: SceneItem, by: Point) => void) | undefined;
}

/** Dragged parts land on the schematic grid. */
const MOVE_GRID = 1.27;

const DRAG_THRESHOLD_PX = 4;
const PICK_TOLERANCE_PX = 4;
const WHEEL_ZOOM = 0.0015;

/**
 * A mouse wheel turns in fixed notches (multiples of 120 in the legacy delta)
 * and never sideways; a trackpad sends fine-grained deltas on both axes.
 */
function isMouseWheel(event: WheelEvent): boolean {
  if (event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) return true;
  const legacy = (event as WheelEvent & { readonly wheelDeltaY?: number }).wheelDeltaY;
  return event.deltaX === 0 && legacy !== undefined && legacy !== 0 && Math.abs(legacy) % 120 === 0;
}

export class CanvasController {
  private view: View = { scale: 1, x: 0, y: 0 };
  private state: CanvasState | undefined;
  private width = 0;
  private height = 0;
  private frame = 0;
  private fitted: Scene | undefined;
  private drag: { readonly x: number; readonly y: number; moved: boolean } | undefined;
  /** A part being dragged, and how far it has come from where it was picked up. */
  private carry:
    | { readonly item: SceneItem; readonly x: number; readonly y: number; by: Point }
    | undefined;
  private readonly dispose: () => void;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const stopObserving = observeResize(canvas, () => this.resize());
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey || isMouseWheel(event)) {
        // A trackpad pinch arrives as ctrl+wheel with small deltas; scale it up to match.
        const delta = event.ctrlKey && !isMouseWheel(event) ? event.deltaY * 4 : event.deltaY;
        this.view = zoomAt(
          this.view,
          Math.exp(-delta * WHEEL_ZOOM),
          event.clientX - rect.left,
          event.clientY - rect.top,
        );
      } else {
        // Two fingers on a trackpad move the drawing, like every other macOS canvas.
        this.view = { ...this.view, x: this.view.x - event.deltaX, y: this.view.y - event.deltaY };
      }
      this.schedule();
    };
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0 && event.button !== 1) return;
      this.drag = { x: event.clientX, y: event.clientY, moved: false };
      canvas.setPointerCapture(event.pointerId);
      const item = event.button === 0 ? this.itemAt(event) : undefined;
      this.carry =
        item && this.state?.movable?.(item)
          ? { item, x: event.clientX, y: event.clientY, by: { x: 0, y: 0 } }
          : undefined;
    };
    const onMove = (event: PointerEvent) => {
      const drag = this.drag;
      if (!drag) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      if (this.carry) {
        const grid = (pixels: number) =>
          Math.round(pixels / this.view.scale / MOVE_GRID) * MOVE_GRID;
        drag.moved = true;
        this.carry.by = {
          x: grid(event.clientX - this.carry.x),
          y: grid(event.clientY - this.carry.y),
        };
        canvas.style.cursor = "move";
        this.schedule();
        return;
      }
      this.drag = { x: event.clientX, y: event.clientY, moved: true };
      this.view = { ...this.view, x: this.view.x + dx, y: this.view.y + dy };
      canvas.style.cursor = "grabbing";
      this.schedule();
    };
    const onUp = (event: PointerEvent) => {
      const drag = this.drag;
      this.drag = undefined;
      const carry = this.carry;
      this.carry = undefined;
      canvas.style.cursor = "";
      if (!drag || !this.state) return;
      if (carry && drag.moved) {
        this.schedule();
        if (event.type === "pointerup" && (carry.by.x !== 0 || carry.by.y !== 0)) {
          this.state.onMove?.(carry.item, carry.by);
        }
        return;
      }
      if (drag.moved) return;
      this.state.onPick(this.itemAt(event));
    };
    const onDouble = () => this.fit();
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("dblclick", onDouble);
    this.dispose = () => {
      stopObserving();
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("dblclick", onDouble);
      if (this.frame !== 0) cancelAnimationFrame(this.frame);
    };
    this.resize();
  }

  destroy(): void {
    this.dispose();
  }

  update(state: CanvasState): void {
    this.state = state;
    // A different drawing starts framed; the same one re-read keeps the user's view.
    if (this.fitted !== state.scene && this.width > 0) {
      const same =
        this.fitted !== undefined &&
        this.fitted.kind === state.scene.kind &&
        this.fitted.bounds.minX === state.scene.bounds.minX &&
        this.fitted.bounds.maxX === state.scene.bounds.maxX &&
        this.fitted.bounds.minY === state.scene.bounds.minY &&
        this.fitted.bounds.maxY === state.scene.bounds.maxY;
      this.fitted = state.scene;
      if (!same) this.view = fitView(state.scene.bounds, this.width, this.height);
    }
    this.schedule();
  }

  fit(): void {
    if (!this.state) return;
    this.view = fitView(this.state.scene.bounds, this.width, this.height);
    this.schedule();
  }

  zoom(factor: number): void {
    this.view = zoomAt(this.view, factor, this.width / 2, this.height / 2);
    this.schedule();
  }

  /** Brings an item to the centre, zooming in only if it would be tiny. */
  reveal(item: SceneItem): void {
    const cx = (item.box.minX + item.box.maxX) / 2;
    const cy = (item.box.minY + item.box.maxY) / 2;
    const size = Math.max(item.box.maxX - item.box.minX, item.box.maxY - item.box.minY, 1);
    const scale = Math.max(
      this.view.scale,
      Math.min(40, (Math.min(this.width, this.height) * 0.25) / size),
    );
    this.view = { scale, x: this.width / 2 - cx * scale, y: this.height / 2 - cy * scale };
    this.schedule();
  }

  private itemAt(event: PointerEvent): SceneItem | undefined {
    if (!this.state) return undefined;
    const rect = this.canvas.getBoundingClientRect();
    const point = {
      x: (event.clientX - rect.left - this.view.x) / this.view.scale,
      y: (event.clientY - rect.top - this.view.y) / this.view.scale,
    };
    const { hidden } = this.state.options;
    const visible = (item: SceneItem) => item.shapes.some((shape) => !hidden.has(shape.paint));
    return pickItem(this.state.scene, point, PICK_TOLERANCE_PX / this.view.scale, visible);
  }

  /** An outline of the dragged part at the place it would land. */
  private drawCarry(ctx: CanvasRenderingContext2D): void {
    const carry = this.carry;
    if (!carry || !this.state) return;
    const ratio = window.devicePixelRatio || 1;
    const { scale, x, y } = this.view;
    const { box } = carry.item;
    ctx.save();
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.strokeStyle = this.state.options.selectionColor;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(
      (box.minX + carry.by.x) * scale + x,
      (box.minY + carry.by.y) * scale + y,
      (box.maxX - box.minX) * scale,
      (box.maxY - box.minY) * scale,
    );
    ctx.restore();
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const first = this.width === 0;
    this.width = rect.width;
    this.height = rect.height;
    const ratio = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(rect.width * ratio));
    this.canvas.height = Math.max(1, Math.round(rect.height * ratio));
    if (first && this.state && rect.width > 0) {
      this.fitted = this.state.scene;
      this.view = fitView(this.state.scene.bounds, this.width, this.height);
    }
    this.draw();
  }

  private schedule(): void {
    if (this.frame !== 0) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private draw(): void {
    const ctx = this.canvas.getContext("2d");
    if (!ctx || !this.state || this.width === 0) return;
    drawScene(
      ctx,
      this.state.scene,
      this.view,
      { width: this.width, height: this.height, pixelRatio: window.devicePixelRatio || 1 },
      this.state.options,
    );
    this.drawCarry(ctx);
  }
}
