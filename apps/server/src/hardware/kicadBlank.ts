/**
 * A blank KiCad project. kicad-cli `upgrade` then rewrites the schematic and
 * board in the running KiCad's own format, so these only need to be valid.
 */

/** The standard 2-layer stack of a new KiCad 10 board. */
const LAYERS = [
  '(0 "F.Cu" signal)',
  '(2 "B.Cu" signal)',
  '(9 "F.Adhes" user "F.Adhesive")',
  '(11 "B.Adhes" user "B.Adhesive")',
  '(13 "F.Paste" user)',
  '(15 "B.Paste" user)',
  '(5 "F.SilkS" user "F.Silkscreen")',
  '(7 "B.SilkS" user "B.Silkscreen")',
  '(1 "F.Mask" user)',
  '(3 "B.Mask" user)',
  '(17 "Dwgs.User" user "User.Drawings")',
  '(19 "Cmts.User" user "User.Comments")',
  '(21 "Eco1.User" user "User.Eco1")',
  '(23 "Eco2.User" user "User.Eco2")',
  '(25 "Edge.Cuts" user)',
  '(27 "Margin" user)',
  '(31 "F.CrtYd" user "F.Courtyard")',
  '(29 "B.CrtYd" user "B.Courtyard")',
  '(35 "F.Fab" user)',
  '(33 "B.Fab" user)',
];

const quote = (text: string) => `"${text.replace(/(["\\])/g, "\\$1")}"`;

/** KiCad assigns the schematic its UUID when it first saves it. */
export function blankSchematic(title: string): string {
  return `(kicad_sch (version 20231120) (generator "kitty") (paper "A4")
  (title_block (title ${quote(title)}) (rev "0.1"))
  (lib_symbols)
  (sheet_instances (path "/" (page "1"))))
`;
}

export function blankBoard(title: string): string {
  return `(kicad_pcb (version 20240108) (generator "kitty")
  (general (thickness 1.6))
  (paper "A4")
  (title_block (title ${quote(title)}) (rev "0.1"))
  (layers ${LAYERS.join(" ")})
  (setup (pad_to_mask_clearance 0))
  (net 0 ""))
`;
}

export function blankProject(fileName: string): string {
  return `${JSON.stringify({ meta: { filename: fileName, version: 3 } }, null, 2)}\n`;
}
