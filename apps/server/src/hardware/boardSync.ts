/** Bringing a schematic's parts and nets onto its board, with KiCad's own Python doing the writing. */
import { child, children, parseSexpr, type Sexpr, value } from "@t3tools/shared/kicad/sexpr";

/** One part of the schematic, as the board needs it. */
export interface BoardSyncPart {
  readonly ref: string;
  readonly value: string;
  /** Library id of the footprint, `jlc:R0603`. */
  readonly footprint: string;
  /** The symbol's place in the schematic; KiCad uses it to tie footprint to symbol. */
  readonly path: string;
  /** Net of each pad number. */
  readonly pads: Readonly<Record<string, string>>;
  /** The symbol's other fields (MPN, LCSC Part), which the footprint carries too. */
  readonly fields: Readonly<Record<string, string>>;
}

export interface BoardSyncPlan {
  readonly components: ReadonlyArray<BoardSyncPart>;
  /** Parts that have no footprint and so cannot go on the board. */
  readonly withoutFootprint: ReadonlyArray<string>;
}

const naturally = new Intl.Collator("en", { numeric: true }).compare;

/**
 * Reads `kicad-cli sch export netlist --format kicadsexpr`. Parts come out
 * block by block, so the parts of a block land next to each other on the board.
 */
export function boardSyncPlan(netlist: string): BoardSyncPlan {
  const root = parseSexpr(netlist);
  const pads = new Map<string, Record<string, string>>();
  for (const net of children(child(root, "nets"), "net")) {
    const name = value(net, "name") ?? "";
    for (const node of children(net, "node")) {
      const ref = value(node, "ref");
      const pin = value(node, "pin");
      if (!ref || !pin) continue;
      const known = pads.get(ref) ?? {};
      known[pin] = name;
      pads.set(ref, known);
    }
  }
  const withoutFootprint: Array<string> = [];
  const found: Array<BoardSyncPart & { readonly group: string }> = [];
  for (const comp of children(child(root, "components"), "comp")) {
    const ref = value(comp, "ref");
    if (!ref) continue;
    const footprint = value(comp, "footprint") ?? "";
    if (!footprint.includes(":")) {
      withoutFootprint.push(ref);
      continue;
    }
    const fields: Record<string, string> = {};
    for (const field of children(child(comp, "fields"), "field")) {
      const name = value(field, "name");
      const text = field[2];
      if (name && name !== "Footprint" && typeof text === "string") fields[name] = text;
    }
    const group =
      fields.Group ??
      children(comp, "property")
        .filter((property) => value(property, "name") === "Group")
        .map((property) => value(property, "value") ?? "")[0] ??
      "";
    found.push({
      ref,
      value: value(comp, "value") ?? "",
      footprint,
      path: `${value(child(comp, "sheetpath"), "tstamps") ?? "/"}${atom(child(comp, "tstamps"))}`,
      pads: pads.get(ref) ?? {},
      fields,
      group,
    });
  }
  const components = found
    .toSorted((a, b) => naturally(a.group, b.group) || naturally(a.ref, b.ref))
    .map(({ group: _group, ...part }) => part);
  return { components, withoutFootprint: withoutFootprint.toSorted(naturally) };
}

const atom = (node: Sexpr | undefined): string => {
  const first = Array.isArray(node) ? node[1] : undefined;
  return typeof first === "string" ? first : "";
};

/** Where each footprint library of a design lives: its own table first, then KiCad's. */
export function footprintLibraries(
  table: string | undefined,
  designDirectory: string,
  names: Iterable<string>,
  kicadFootprintDirectories: ReadonlyArray<string>,
): Record<string, ReadonlyArray<string>> {
  const own = new Map<string, string>();
  if (table) {
    try {
      for (const lib of children(parseSexpr(table), "lib")) {
        const name = value(lib, "name");
        const uri = value(lib, "uri");
        if (name && uri) own.set(name, uri.replaceAll("${KIPRJMOD}", designDirectory));
      }
    } catch {
      // A table that does not parse leaves KiCad's own libraries to try.
    }
  }
  const libraries: Record<string, ReadonlyArray<string>> = {};
  for (const name of names) {
    const mine = own.get(name);
    libraries[name] = [
      ...(mine ? [mine] : []),
      ...kicadFootprintDirectories.map((directory) => `${directory}/${name}.pretty`),
    ];
  }
  return libraries;
}

/** The job file the script reads: where new parts start, and how they are spaced, in mm. */
export const boardSyncJob = (
  board: string,
  components: ReadonlyArray<BoardSyncPart>,
  libraries: Record<string, ReadonlyArray<string>>,
): string =>
  JSON.stringify({ board, components, libraries, origin: [100, 80], gap: 3, rowWidth: 80 });

/** KiCad's Python, which has the `pcbnew` module: KITTY_KICAD_PYTHON, the app's own, then PATH. */
export function kicadPythonCandidates(env: NodeJS.ProcessEnv, cli: string): ReadonlyArray<string> {
  const configured = env.KITTY_KICAD_PYTHON?.trim();
  const bundled = cli.endsWith("/Contents/MacOS/kicad-cli")
    ? [
        `${cli.slice(0, -"/MacOS/kicad-cli".length)}/Frameworks/Python.framework/Versions/Current/bin/python3`,
      ]
    : [];
  return [...(configured ? [configured] : []), ...bundled, "python3"];
}

export interface BoardSyncReport {
  readonly added: ReadonlyArray<string>;
  readonly updated: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
  readonly missing: ReadonlyArray<{ readonly ref: string; readonly footprint: string }>;
}

const REPORT_MARK = "KITTY_SYNC ";

/** The script's last word; undefined when it did not finish. */
export function parseSyncReport(stdout: string): BoardSyncReport | undefined {
  const line = stdout.split("\n").findLast((candidate) => candidate.startsWith(REPORT_MARK));
  if (!line) return undefined;
  try {
    const report = JSON.parse(line.slice(REPORT_MARK.length)) as Partial<BoardSyncReport>;
    const list = (input: unknown) =>
      Array.isArray(input) ? input.filter((entry) => typeof entry === "string") : [];
    return {
      added: list(report.added).toSorted(naturally),
      updated: list(report.updated).toSorted(naturally),
      removed: list(report.removed).toSorted(naturally),
      missing: Array.isArray(report.missing) ? report.missing : [],
    };
  } catch {
    return undefined;
  }
}

/**
 * Run by KiCad's Python with the job file as its argument. New parts are set
 * down in rows beside the board; parts already placed keep their place.
 */
export const BOARD_SYNC_SCRIPT = String.raw`import json, os, sys
import pcbnew

job = json.load(open(sys.argv[1]))
board = pcbnew.LoadBoard(job["board"])
mm = pcbnew.FromMM
report = {"added": [], "updated": [], "removed": [], "missing": []}

def net_of(name):
    found = board.FindNet(name)
    if found is None:
        found = pcbnew.NETINFO_ITEM(board, name)
        board.Add(found)
    return found

def load(footprint):
    library, _, name = footprint.partition(":")
    for directory in job["libraries"].get(library, []):
        if os.path.isfile(os.path.join(directory, name + ".kicad_mod")):
            return pcbnew.FootprintLoad(directory, name)
    return None

def body(fp):
    box = fp.GetBoundingBox(False)
    return box.GetWidth(), box.GetHeight()

existing = {}
for fp in board.GetFootprints():
    existing.setdefault(fp.GetReference(), fp)

# New parts are laid out in rows beside what is already on the board.
area = board.GetBoardEdgesBoundingBox()
for fp in board.GetFootprints():
    area.Merge(fp.GetBoundingBox(False))
empty = area.GetWidth() == 0 and area.GetHeight() == 0
left = mm(job["origin"][0]) if empty else area.GetRight() + mm(job["gap"])
top = mm(job["origin"][1]) if empty else area.GetTop()
cursor = [left, top, 0]
row_width = mm(job["rowWidth"])

def stage(fp):
    width, height = body(fp)
    if cursor[0] > left and cursor[0] + width > left + row_width:
        cursor[0] = left
        cursor[1] += cursor[2] + mm(job["gap"])
        cursor[2] = 0
    box = fp.GetBoundingBox(False)
    position = fp.GetPosition()
    fp.SetPosition(pcbnew.VECTOR2I(
        int(cursor[0] + position.x - box.GetLeft()), int(cursor[1] + position.y - box.GetTop())))
    cursor[0] += width + mm(job["gap"])
    cursor[2] = max(cursor[2], height)

for part in job["components"]:
    ref = part["ref"]
    fp = existing.pop(ref, None)
    replaced = None
    if fp is not None and fp.GetFPIDAsString() != part["footprint"]:
        replaced, fp = fp, None
    if fp is None:
        fp = load(part["footprint"])
        if fp is None:
            report["missing"].append({"ref": ref, "footprint": part["footprint"]})
            if replaced is not None:
                existing[ref] = None
            continue
        fp.SetFPIDAsString(part["footprint"])
        fp.SetReference(ref)
        board.Add(fp)
        if replaced is not None:
            # A changed footprint stays where the old one was.
            fp.SetPosition(replaced.GetPosition())
            fp.SetOrientation(replaced.GetOrientation())
            if replaced.IsFlipped():
                fp.Flip(fp.GetPosition(), False)
            board.Remove(replaced)
            report["updated"].append(ref)
        else:
            stage(fp)
            report["added"].append(ref)
    changed = False
    if fp.GetValue() != part["value"]:
        fp.SetValue(part["value"])
        changed = True
    fp.SetPath(pcbnew.KIID_PATH(part["path"]))
    # The symbol's fields ride along on the footprint, as KiCad's own update does.
    known = {field.GetName(): field for field in fp.GetFields()}
    for name, text in part["fields"].items():
        field = known.get(name)
        if field is None:
            field = pcbnew.PCB_FIELD(fp, pcbnew.FIELD_T_USER, name)
            field.SetVisible(False)
            field.SetLayer(pcbnew.B_Fab if fp.IsFlipped() else pcbnew.F_Fab)
            field.SetPosition(fp.GetPosition())
            fp.Add(field)
        if field.GetText() != text:
            field.SetText(text)
    for pad in fp.Pads():
        name = part["pads"].get(pad.GetNumber(), "")
        if pad.GetNetname() != name:
            changed = True
            if name:
                pad.SetNet(net_of(name))
            else:
                pad.SetNetCode(0)
    if changed and ref not in report["added"] and ref not in report["updated"]:
        report["updated"].append(ref)

# Parts that came from the schematic and are no longer in it go; anything else stays.
for ref, fp in existing.items():
    if fp is None or fp.GetPath().AsString() in ("", "/") or fp.IsLocked():
        continue
    board.Remove(fp)
    report["removed"].append(ref)

pcbnew.SaveBoard(job["board"], board)
print("KITTY_SYNC " + json.dumps(report))
`;
