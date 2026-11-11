/** Draws a scene onto a 2D canvas. */
import { displayNet } from "@t3tools/shared/kicad/pick";
import {
  arcPoints,
  type Box,
  type Scene,
  type SceneItem,
  type Shape,
} from "@t3tools/shared/kicad/scene";

import { paintOrder } from "./scenePaint.ts";

/** Screen position = world position × scale + offset, in CSS pixels. */
export interface View {
  readonly scale: number;
  readonly x: number;
  readonly y: number;
}

export interface DrawOptions {
  readonly color: (paint: string) => string;
  readonly hidden: ReadonlySet<string>;
  readonly selection: ReadonlySet<string>;
  readonly selectionColor: string;
  /** When set, items it rejects are dimmed. */
  readonly focus?: ((item: SceneItem) => boolean) | undefined;
  readonly fontFamily: string;
}

interface Entry {
  readonly item: SceneItem;
  readonly shape: Shape;
}

const prepared = new WeakMap<
  Scene,
  ReadonlyArray<readonly [paint: string, entries: ReadonlyArray<Entry>]>
>();

/** Shapes grouped by paint in draw order, with zones under the tracks of their layer. */
function prepare(scene: Scene) {
  const cached = prepared.get(scene);
  if (cached) return cached;
  const byPaint = new Map<string, Array<Entry>>();
  for (const item of scene.items) {
    for (const shape of item.shapes) {
      const list = byPaint.get(shape.paint) ?? [];
      if (item.kind === "zone") list.unshift({ item, shape });
      else list.push({ item, shape });
      byPaint.set(shape.paint, list);
    }
  }
  const ordered = paintOrder(scene, byPaint.keys()).map(
    (paint) => [paint, byPaint.get(paint) ?? []] as const,
  );
  prepared.set(scene, ordered);
  return ordered;
}

export const scenePaints = (scene: Scene): ReadonlyArray<string> =>
  prepare(scene).map(([paint]) => paint);

const MIN_TEXT_PX = 3.5;
const DIMMED = 0.18;
const ZONE_ALPHA = 0.38;

/** KiCad markup: `~{RESET}` is an overbar, `{slash}` an escaped slash. */
const plainText = (text: string) => displayNet(text).replace(/[~^_]\{([^}]*)\}/g, "$1");

function trace(
  ctx: CanvasRenderingContext2D,
  points: ReadonlyArray<{ x: number; y: number }>,
  close: boolean,
) {
  ctx.beginPath();
  points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  if (close) ctx.closePath();
}

function drawText(
  ctx: CanvasRenderingContext2D,
  shape: Extract<Shape, { kind: "text" }>,
  view: View,
  options: DrawOptions,
) {
  const px = shape.size * view.scale * 1.25;
  if (px < MIN_TEXT_PX) return;
  const lines = plainText(shape.text).split("\n");
  ctx.save();
  ctx.translate(shape.at.x, shape.at.y);
  if (shape.vertical) ctx.rotate(-Math.PI / 2);
  // Fonts are set in world units; the canvas transform scales them.
  const size = shape.size * 1.25;
  ctx.font = `${size}px ${options.fontFamily}`;
  ctx.textAlign = shape.align;
  ctx.textBaseline =
    shape.baseline === "middle" ? "middle" : shape.baseline === "top" ? "top" : "alphabetic";
  const lineHeight = size * 1.2;
  const first =
    shape.baseline === "bottom"
      ? -(lines.length - 1) * lineHeight
      : shape.baseline === "middle"
        ? (-(lines.length - 1) * lineHeight) / 2
        : 0;
  if (shape.frame) {
    const width = ctx.measureText(lines[0] ?? "").width;
    const half = size * 0.75;
    const start = shape.align === "left" ? 0 : shape.align === "right" ? -width : -width / 2;
    const pad = size * 0.3;
    const left = start - pad;
    const right = start + width + pad;
    // The pointed end faces the wire; bidirectional labels point both ways.
    const tipLeft = shape.align === "left" || shape.frame === "bidirectional";
    const tipRight = shape.align === "right" || shape.frame === "bidirectional";
    const outline = [
      { x: left, y: -half },
      { x: right, y: -half },
      ...(tipRight && shape.frame !== "passive" ? [{ x: right + half * 0.7, y: 0 }] : []),
      { x: right, y: half },
      { x: left, y: half },
      ...(tipLeft && shape.frame !== "passive" ? [{ x: left - half * 0.7, y: 0 }] : []),
    ];
    ctx.lineWidth = Math.max(0.15, 1 / view.scale);
    trace(ctx, outline, true);
    ctx.stroke();
  }
  lines.forEach((line, index) => ctx.fillText(line, 0, first + index * lineHeight));
  ctx.restore();
}

function drawShape(ctx: CanvasRenderingContext2D, shape: Shape, view: View, options: DrawOptions) {
  const hairline = 1 / view.scale;
  switch (shape.kind) {
    case "line":
      ctx.lineWidth = Math.max(shape.width, hairline);
      trace(ctx, shape.points, false);
      ctx.stroke();
      break;
    case "arc":
      ctx.lineWidth = Math.max(shape.width, hairline);
      trace(ctx, arcPoints(shape.start, shape.mid, shape.end), false);
      ctx.stroke();
      break;
    case "polygon":
      trace(ctx, shape.points, true);
      if (shape.fill) {
        ctx.fillStyle = options.color(shape.fill);
        ctx.fill();
      }
      if (shape.width > 0) {
        ctx.lineWidth = Math.max(shape.width, hairline);
        ctx.stroke();
      }
      break;
    case "circle":
      ctx.beginPath();
      ctx.arc(shape.center.x, shape.center.y, shape.radius, 0, Math.PI * 2);
      if (shape.fill) {
        ctx.fillStyle = options.color(shape.fill);
        ctx.fill();
      }
      if (shape.width > 0) {
        ctx.lineWidth = Math.max(shape.width, hairline);
        ctx.stroke();
      }
      break;
    case "text":
      drawText(ctx, shape, view, options);
      break;
  }
}

const overlaps = (a: Box, b: Box) =>
  a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;

export function drawScene(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  view: View,
  size: { readonly width: number; readonly height: number; readonly pixelRatio: number },
  options: DrawOptions,
): void {
  const { width, height, pixelRatio } = size;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width * pixelRatio, height * pixelRatio);
  ctx.setTransform(
    view.scale * pixelRatio,
    0,
    0,
    view.scale * pixelRatio,
    view.x * pixelRatio,
    view.y * pixelRatio,
  );
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  // Text boxes are approximate, so the visible area gets a generous margin.
  const margin = 20;
  const visible: Box = {
    minX: -view.x / view.scale - margin,
    minY: -view.y / view.scale - margin,
    maxX: (width - view.x) / view.scale + margin,
    maxY: (height - view.y) / view.scale + margin,
  };
  for (const [paint, entries] of prepare(scene)) {
    if (options.hidden.has(paint)) continue;
    const color = options.color(paint);
    for (const { item, shape } of entries) {
      if (!overlaps(item.box, visible) && shape.kind !== "text") continue;
      const focused = options.focus ? options.focus(item) : true;
      ctx.globalAlpha = (focused ? 1 : DIMMED) * (item.kind === "zone" ? ZONE_ALPHA : 1);
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      drawShape(ctx, shape, view, options);
    }
  }
  ctx.globalAlpha = 1;
  if (options.selection.size === 0) return;
  ctx.strokeStyle = options.selectionColor;
  ctx.lineWidth = 1.5 / view.scale;
  ctx.setLineDash([4 / view.scale, 3 / view.scale]);
  const pad = 3 / view.scale;
  for (const item of scene.items) {
    if (!options.selection.has(item.id)) continue;
    ctx.strokeRect(
      item.box.minX - pad,
      item.box.minY - pad,
      item.box.maxX - item.box.minX + pad * 2,
      item.box.maxY - item.box.minY + pad * 2,
    );
  }
  ctx.setLineDash([]);
}

/** The view that fits `bounds` inside the canvas with a margin. */
export function fitView(bounds: Box, width: number, height: number, margin = 24): View {
  const w = Math.max(bounds.maxX - bounds.minX, 1);
  const h = Math.max(bounds.maxY - bounds.minY, 1);
  const scale = Math.max(0.1, Math.min((width - margin * 2) / w, (height - margin * 2) / h));
  return {
    scale,
    x: (width - w * scale) / 2 - bounds.minX * scale,
    y: (height - h * scale) / 2 - bounds.minY * scale,
  };
}

/** Zooms by `factor` keeping the world point under (`cx`, `cy`) fixed. */
export function zoomAt(view: View, factor: number, cx: number, cy: number): View {
  const scale = Math.max(0.2, Math.min(400, view.scale * factor));
  const ratio = scale / view.scale;
  return { scale, x: cx - (cx - view.x) * ratio, y: cy - (cy - view.y) * ratio };
}
