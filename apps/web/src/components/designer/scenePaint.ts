/** Colours and draw order for schematic and board scenes. */
import type { Scene } from "@t3tools/shared/kicad/scene";

export type Palette = Readonly<Record<string, string>>;

const SCHEMATIC_DARK: Palette = {
  wire: "#5fd38d",
  bus: "#5b8def",
  junction: "#5fd38d",
  "no-connect": "#8fa7ff",
  body: "#e0787f",
  "body-fill": "rgba(224, 120, 127, 0.12)",
  pin: "#e0787f",
  "pin-name": "#7fc4d9",
  "pin-number": "#c99a9a",
  reference: "#56c7c7",
  value: "#56c7c7",
  field: "#8f98a8",
  label: "#e6e6e6",
  "global-label": "#f0a35e",
  "hier-label": "#d9c26a",
  note: "#8da2d6",
  sheet: "#b48ead",
  "sheet-fill": "rgba(180, 142, 173, 0.08)",
};

const SCHEMATIC_LIGHT: Palette = {
  wire: "#008a2e",
  bus: "#1f4fbf",
  junction: "#008a2e",
  "no-connect": "#2b3fbf",
  body: "#8c1c1c",
  "body-fill": "rgba(255, 244, 170, 0.6)",
  pin: "#8c1c1c",
  "pin-name": "#00676b",
  "pin-number": "#a03030",
  reference: "#00676b",
  value: "#00676b",
  field: "#5c6370",
  label: "#111111",
  "global-label": "#a34a00",
  "hier-label": "#7a5c00",
  note: "#2f4aa8",
  sheet: "#7a3d86",
  "sheet-fill": "rgba(122, 61, 134, 0.06)",
};

const BOARD: Palette = {
  "F.Cu": "#c83434",
  "B.Cu": "#4d7fc4",
  "In1.Cu": "#7fc87f",
  "In2.Cu": "#ce7d2c",
  "In3.Cu": "#4fcbcb",
  "In4.Cu": "#db628b",
  through: "#e3b72e",
  via: "#ececec",
  hole: "#0b1d33",
  "F.SilkS": "#f2eda1",
  "B.SilkS": "#e8b2a7",
  "F.Fab": "#afafaf",
  "B.Fab": "#585d84",
  "F.CrtYd": "#ff26e2",
  "B.CrtYd": "#26e9ff",
  "Edge.Cuts": "#d0d2cd",
};
const BOARD_OTHER = "#8a93a3";

export const SELECTION_COLOR = "#ffffff";
export const SELECTION_COLOR_LIGHT = "#1d4ed8";

export function paletteFor(scene: Scene, dark: boolean): (paint: string) => string {
  if (scene.kind === "board") return (paint) => BOARD[paint] ?? BOARD_OTHER;
  const palette = dark ? SCHEMATIC_DARK : SCHEMATIC_LIGHT;
  return (paint) => palette[paint] ?? palette.field ?? "#888888";
}

const SCHEMATIC_ORDER = [
  "sheet",
  "note",
  "body",
  "pin",
  "wire",
  "bus",
  "junction",
  "no-connect",
  "label",
  "global-label",
  "hier-label",
  "pin-name",
  "pin-number",
  "reference",
  "value",
  "field",
];

const innerIndex = (layer: string) => Number(/^In(\d+)\.Cu$/.exec(layer)?.[1] ?? 0);

/** Paints from the bottom of the stack to the top, as seen from the front. */
export function paintOrder(scene: Scene, paints: Iterable<string>): ReadonlyArray<string> {
  const present = new Set(paints);
  if (scene.kind === "schematic") {
    const known = SCHEMATIC_ORDER.filter((paint) => present.has(paint));
    return [...known, ...[...present].filter((paint) => !known.includes(paint))];
  }
  const inner = [...present]
    .filter((paint) => innerIndex(paint) > 0)
    .toSorted((a, b) => innerIndex(b) - innerIndex(a));
  const fixed = [
    "B.Fab",
    "B.CrtYd",
    "B.SilkS",
    "B.Cu",
    ...inner,
    "F.Cu",
    "through",
    "via",
    "hole",
    "F.SilkS",
    "F.CrtYd",
    "F.Fab",
    "Edge.Cuts",
  ];
  const rest = [...present].filter((paint) => !fixed.includes(paint));
  return [...rest, ...fixed.filter((paint) => present.has(paint))];
}

const BOARD_SHOWN = /^(.*\.Cu|through|via|hole|[FB]\.SilkS|Edge\.Cuts)$/;

/** Board layers drawn before the user changes anything: copper, silkscreen, outline. */
export const shownByDefault = (scene: Scene, paint: string): boolean =>
  scene.kind === "schematic" || BOARD_SHOWN.test(paint);

/** Readable names for the layer list. */
export function layerLabel(paint: string): string {
  const names: Readonly<Record<string, string>> = {
    "F.Cu": "Front copper",
    "B.Cu": "Back copper",
    "F.SilkS": "Front silkscreen",
    "B.SilkS": "Back silkscreen",
    "F.Fab": "Front fabrication",
    "B.Fab": "Back fabrication",
    "F.CrtYd": "Front courtyard",
    "B.CrtYd": "Back courtyard",
    "Edge.Cuts": "Board outline",
    through: "Through-hole pads",
    via: "Vias",
    hole: "Holes",
  };
  const inner = innerIndex(paint);
  return names[paint] ?? (inner > 0 ? `Inner copper ${inner}` : paint);
}
