/** Changing a board: moving parts and setting its outline, with KiCad's own Python writing the file. */
import type { BoardEdit, BoardPart } from "@t3tools/contracts";

/** The job file the script reads. */
export const boardEditJob = (board: string, edits: ReadonlyArray<BoardEdit>): string =>
  JSON.stringify({ board, edits });

export interface BoardEditReport {
  /** What each edit did, one line per change. */
  readonly summary: ReadonlyArray<string>;
  readonly outline?: { x: number; y: number; width: number; height: number };
  readonly parts: ReadonlyArray<BoardPart>;
  /** Pairs of parts on the same side whose bodies overlap. */
  readonly overlaps: ReadonlyArray<readonly [string, string]>;
}

const REPORT_MARK = "KITTY_BOARD ";
const naturally = new Intl.Collator("en", { numeric: true }).compare;

/**
 * The script's last word: the board after the edits, or why they were refused.
 * Undefined when the script did not finish.
 */
export function parseBoardReport(
  stdout: string,
): BoardEditReport | { readonly error: string } | undefined {
  const line = stdout.split("\n").findLast((candidate) => candidate.startsWith(REPORT_MARK));
  if (!line) return undefined;
  try {
    const report = JSON.parse(line.slice(REPORT_MARK.length)) as {
      error?: unknown;
      summary?: ReadonlyArray<string>;
      outline?: BoardEditReport["outline"] | null;
      parts?: ReadonlyArray<BoardPart>;
      overlaps?: ReadonlyArray<readonly [string, string]>;
    };
    if (typeof report.error === "string") return { error: report.error };
    return {
      summary: report.summary ?? [],
      ...(report.outline ? { outline: report.outline } : {}),
      parts: (report.parts ?? []).toSorted((a, b) => naturally(a.reference, b.reference)),
      overlaps: report.overlaps ?? [],
    };
  } catch {
    return undefined;
  }
}

/** Run by KiCad's Python with the job file as its argument; saves only when every edit applies. */
export const BOARD_EDIT_SCRIPT = String.raw`import json, sys
import pcbnew

job = json.load(open(sys.argv[1]))
board = pcbnew.LoadBoard(job["board"])
mm = pcbnew.FromMM
to_mm = lambda value: round(pcbnew.ToMM(value), 3)
summary = []

def fail(message):
    print("KITTY_BOARD " + json.dumps({"error": message}))
    sys.exit(0)

def number(value):
    text = ("%.3f" % value).rstrip("0").rstrip(".")
    return "0" if text in ("-0", "") else text

footprints = {}
for fp in board.GetFootprints():
    footprints.setdefault(fp.GetReference(), fp)

for edit in job["edits"]:
    op = edit["op"]
    if op == "move":
        fp = footprints.get(edit["reference"])
        if fp is None:
            fail("%s is not on the board. Run pcb_sync to bring the schematic's parts onto it." % edit["reference"])
        ref = edit["reference"]
        position = fp.GetPosition()
        if "at" in edit or "by" in edit:
            if "at" in edit:
                target = pcbnew.VECTOR2I(mm(edit["at"]["x"]), mm(edit["at"]["y"]))
            else:
                target = pcbnew.VECTOR2I(position.x + mm(edit["by"]["x"]), position.y + mm(edit["by"]["y"]))
            fp.SetPosition(target)
            summary.append("Moved %s to (%s, %s) on the board" % (ref, number(to_mm(target.x)), number(to_mm(target.y))))
        side = edit.get("side")
        if side and (side == "back") != fp.IsFlipped():
            fp.Flip(fp.GetPosition(), pcbnew.FLIP_DIRECTION_LEFT_RIGHT)
            summary.append("Put %s on the %s of the board" % (ref, side))
        if "rotation" in edit or "rotateBy" in edit:
            angle = edit["rotation"] if "rotation" in edit else fp.GetOrientationDegrees() + edit["rotateBy"]
            fp.SetOrientationDegrees(angle % 360)
            summary.append("Turned %s to %s degrees" % (ref, number(fp.GetOrientationDegrees() % 360)))
    elif op == "outline":
        if edit["width"] <= 0 or edit["height"] <= 0:
            fail("The board outline needs a width and height above zero.")
        for drawing in list(board.GetDrawings()):
            if drawing.GetLayer() == pcbnew.Edge_Cuts:
                board.Remove(drawing)
        shape = pcbnew.PCB_SHAPE(board, pcbnew.SHAPE_T_RECT)
        shape.SetStart(pcbnew.VECTOR2I(mm(edit["x"]), mm(edit["y"])))
        shape.SetEnd(pcbnew.VECTOR2I(mm(edit["x"] + edit["width"]), mm(edit["y"] + edit["height"])))
        shape.SetLayer(pcbnew.Edge_Cuts)
        shape.SetWidth(mm(0.1))
        board.Add(shape)
        summary.append("Set the board outline to %s x %s mm at (%s, %s)" % (
            number(edit["width"]), number(edit["height"]), number(edit["x"]), number(edit["y"])))
    else:
        fail("Unknown board edit: %s" % op)

if job["edits"]:
    pcbnew.SaveBoard(job["board"], board)

edges = board.GetBoardEdgesBoundingBox()
outline = None
if edges.GetWidth() > 0 and edges.GetHeight() > 0:
    outline = {"x": to_mm(edges.GetLeft()), "y": to_mm(edges.GetTop()),
               "width": to_mm(edges.GetWidth()), "height": to_mm(edges.GetHeight())}

parts = []
boxes = []
for fp in board.GetFootprints():
    box = fp.GetBoundingBox(False)
    group = fp.GetFieldText("Group") if fp.HasField("Group") else ""
    parts.append({
        "reference": fp.GetReference(), "value": fp.GetValue(),
        "at": {"x": to_mm(fp.GetPosition().x), "y": to_mm(fp.GetPosition().y)},
        "rotation": round(fp.GetOrientationDegrees() % 360, 2),
        "side": "back" if fp.IsFlipped() else "front",
        "width": to_mm(box.GetWidth()), "height": to_mm(box.GetHeight()),
        "pads": fp.GetPadCount(), "group": group,
        "inside": outline is not None and edges.Contains(box),
    })
    boxes.append((fp.GetReference(), fp.IsFlipped(), box))

overlaps = []
for index, (ref, flipped, box) in enumerate(boxes):
    for other, other_flipped, other_box in boxes[index + 1:]:
        if flipped == other_flipped and box.Intersects(other_box):
            overlaps.append([ref, other])

print("KITTY_BOARD " + json.dumps({"summary": summary, "outline": outline, "parts": parts, "overlaps": overlaps[:40]}))
`;
