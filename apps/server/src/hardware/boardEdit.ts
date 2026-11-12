/** Changing a board: placing parts, its outline and its tracks, with KiCad's own Python writing the file. */
import type { BoardEdit, BoardEditResult, BoardNet, BoardPart } from "@t3tools/contracts";
import { buildBoardScene } from "@t3tools/shared/kicad/boardScene";
import { sameNet } from "@t3tools/shared/kicad/pick";
import { ratsnest } from "@t3tools/shared/kicad/ratsnest";
import type { Box, Point, SceneItem } from "@t3tools/shared/kicad/scene";

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
  readonly keepouts: ReadonlyArray<BoardKeepout>;
}

type BoardKeepout = BoardEditResult["keepouts"][number];

const round = (value: number) => Math.round(value * 1000) / 1000;
const centre = (box: Box): Point => ({
  x: round((box.minX + box.maxX) / 2),
  y: round((box.minY + box.maxY) / 2),
});
const padName = (pad: SceneItem) => `${pad.ref ?? "?"}.${pad.number ?? "?"}`;

/** How many connections `toRoute` lists at most. */
const TO_ROUTE_LIMIT = 80;

export interface BoardRouting {
  readonly toRoute: ReadonlyArray<{ net: string; from: string; to: string }>;
  readonly unrouted: number;
  readonly nets: ReadonlyArray<BoardNet>;
}

/** What is left to route on a board, and where the copper of the nets asked about lies. */
export function boardRouting(source: string, nets: ReadonlyArray<string> = []): BoardRouting {
  const scene = buildBoardScene(source);
  const pads = scene.items.filter((item) => item.kind === "pad" && item.net);
  const padAt = new Map(
    pads.map((pad) => {
      const at = centre(pad.box);
      return [`${pad.net}@${at.x},${at.y}`, padName(pad)] as const;
    }),
  );
  const wires = ratsnest(scene);
  const name = (net: string, point: Point) =>
    padAt.get(`${net}@${round(point.x)},${round(point.y)}`) ?? `(${point.x}, ${point.y})`;
  const wanted = (item: SceneItem, net: string) =>
    item.net !== undefined && (item.net === net || sameNet(net, item.net));
  return {
    toRoute: wires.slice(0, TO_ROUTE_LIMIT).map((wire) => ({
      net: wire.net,
      from: name(wire.net, wire.from),
      to: name(wire.net, wire.to),
    })),
    unrouted: wires.length,
    nets: nets.map((net) => ({
      net,
      pads: pads
        .filter((pad) => wanted(pad, net))
        .map((pad) => ({
          pad: padName(pad),
          at: centre(pad.box),
          side: pad.layer === "F.Cu" ? "front" : pad.layer === "B.Cu" ? "back" : "both",
        })),
      tracks: scene.items
        .filter((item) => item.kind === "track" && wanted(item, net))
        .flatMap((item) => {
          const shape = item.shapes[0];
          const ends =
            shape?.kind === "line"
              ? [shape.points[0], shape.points.at(-1)]
              : shape?.kind === "arc"
                ? [shape.start, shape.end]
                : [];
          const [from, to] = ends;
          if (!shape || !from || !to || !("width" in shape)) return [];
          return [{ id: item.id, layer: item.layer ?? "F.Cu", width: shape.width, from, to }];
        }),
      vias: scene.items
        .filter((item) => item.kind === "via" && wanted(item, net))
        .map((item) => ({ id: item.id, at: centre(item.box) })),
    })),
  };
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
      keepouts?: ReadonlyArray<BoardKeepout>;
    };
    if (typeof report.error === "string") return { error: report.error };
    return {
      summary: report.summary ?? [],
      ...(report.outline ? { outline: report.outline } : {}),
      parts: (report.parts ?? []).toSorted((a, b) => naturally(a.reference, b.reference)),
      overlaps: report.overlaps ?? [],
      keepouts: report.keepouts ?? [],
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
removed = []

def fail(message):
    print("KITTY_BOARD " + json.dumps({"error": message}))
    sys.exit(0)

def number(value):
    text = ("%.3f" % value).rstrip("0").rstrip(".")
    return "0" if text in ("-0", "") else text

footprints = {}
for fp in board.GetFootprints():
    footprints.setdefault(fp.GetReference(), fp)

settings = board.GetDesignSettings()
copper_layers = [layer for layer in board.GetEnabledLayers().CuStack()]

def copper_layer(name):
    layer = board.GetLayerID(name)
    if layer < 0 or not pcbnew.IsCopperLayer(layer) or layer not in copper_layers:
        fail("%s is not a copper layer of this board." % name)
    return layer

def where(position):
    return "(%s, %s)" % (number(to_mm(position.x)), number(to_mm(position.y)))

def pad_name(pad):
    return "%s.%s" % (pad.GetParentFootprint().GetReference(), pad.GetNumber())

def spot_name(spot):
    return pad_name(spot[1]) if spot[1] is not None else where(spot[0])

def spot_of(point):
    """A point of an edit as (position, pad or None)."""
    if "pad" not in point:
        return (pcbnew.VECTOR2I(mm(point["x"]), mm(point["y"])), None)
    ref, _, pin = point["pad"].rpartition(".")
    fp = footprints.get(ref)
    pad = fp.FindPadByNumber(pin) if fp is not None and pin else None
    if pad is None:
        fail("The board has no pad %s." % point["pad"])
    return (pad.GetPosition(), pad)

def find_net(name):
    for candidate in (name, "/" + name):
        net = board.FindNet(candidate)
        if net is not None and net.GetNetCode() > 0:
            return net
    return None

def net_for(name, spots, layer):
    """The net of new copper: the one named, else that of what it starts on."""
    if name:
        net = find_net(name)
        if net is None:
            fail("The board has no net called %s." % name)
        return net
    for position, pad in spots:
        if pad is not None and pad.GetNetCode() > 0:
            return pad.GetNet()
    position = spots[0][0]
    for track in board.GetTracks():
        if track.GetNetCode() > 0 and (layer is None or track.IsOnLayer(layer)) and track.HitTest(position):
            return track.GetNet()
    for fp in board.GetFootprints():
        for pad in fp.Pads():
            if pad.GetNetCode() > 0 and (layer is None or pad.IsOnLayer(layer)) and pad.HitTest(position):
                return pad.GetNet()
    return None

def keepouts():
    return [zone for zone in board.Zones() if zone.GetIsRuleArea()]

def blocked(shape, layers, net, via=False):
    """What the shape would touch that it may not: a keep-out area or copper of another net."""
    gap = settings.m_NetSettings.GetEffectiveNetClass(net.GetNetname()).GetClearance()
    for zone in keepouts():
        barred = zone.GetDoNotAllowVias() if via else zone.GetDoNotAllowTracks()
        if barred and any(zone.IsOnLayer(layer) for layer in layers) and zone.Outline().Collide(shape, 0):
            return "the keep-out area %s" % (zone.GetZoneName() or "there")
    for layer in layers:
        for fp in board.GetFootprints():
            for pad in fp.Pads():
                if pad.GetNetCode() == net.GetNetCode() or not pad.IsOnLayer(layer):
                    continue
                if shape.Collide(pad.GetEffectiveShape(layer), gap):
                    return "%s (%s)" % (pad_name(pad), pad.GetNetname() or "no net")
        for track in board.GetTracks():
            if track.GetNetCode() == net.GetNetCode() or not track.IsOnLayer(layer):
                continue
            other = track.GetEffectiveShape(layer) if track.Type() == pcbnew.PCB_VIA_T else track.GetEffectiveShape()
            if shape.Collide(other, gap):
                return "a %s of %s at %s" % (
                    "via" if track.Type() == pcbnew.PCB_VIA_T else "track", track.GetNetname(), where(track.GetPosition()))
    return None

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
                # Kept until the end like removed tracks: freeing it mid-run breaks KiCad's Python types.
                removed.append(drawing)
        shape = pcbnew.PCB_SHAPE(board, pcbnew.SHAPE_T_RECT)
        shape.SetStart(pcbnew.VECTOR2I(mm(edit["x"]), mm(edit["y"])))
        shape.SetEnd(pcbnew.VECTOR2I(mm(edit["x"] + edit["width"]), mm(edit["y"] + edit["height"])))
        shape.SetLayer(pcbnew.Edge_Cuts)
        shape.SetWidth(mm(0.1))
        board.Add(shape)
        summary.append("Set the board outline to %s x %s mm at (%s, %s)" % (
            number(edit["width"]), number(edit["height"]), number(edit["x"]), number(edit["y"])))
    elif op == "keepout":
        if edit["width"] <= 0 or edit["height"] <= 0 or not edit["name"].strip():
            fail("A keep-out area needs a name and a width and height above zero.")
        for zone in keepouts():
            if zone.GetZoneName() == edit["name"]:
                board.Remove(zone)
                removed.append(zone)
        zone = pcbnew.ZONE(board)
        zone.SetIsRuleArea(True)
        zone.SetZoneName(edit["name"])
        layers = pcbnew.LSET()
        for layer in copper_layers:
            layers.AddLayer(layer)
        zone.SetLayerSet(layers)
        zone.SetDoNotAllowTracks(True)
        zone.SetDoNotAllowVias(True)
        zone.SetDoNotAllowZoneFills(True)
        zone.SetDoNotAllowPads(False)
        zone.SetDoNotAllowFootprints(False)
        outline = zone.Outline()
        outline.NewOutline()
        for x, y in ((0, 0), (1, 0), (1, 1), (0, 1)):
            outline.Append(mm(edit["x"] + x * edit["width"]), mm(edit["y"] + y * edit["height"]))
        for fp in board.GetFootprints():
            for pad in fp.Pads():
                if pad.GetNetCode() > 0 and any(
                        pad.IsOnLayer(layer) and outline.Collide(pad.GetEffectiveShape(layer), 0)
                        for layer in copper_layers):
                    fail("That area covers %s, which then could not be reached. Keep it clear of pads." % pad_name(pad))
        board.Add(zone)
        summary.append("Kept copper out of %s: %s x %s mm at (%s, %s)" % (
            edit["name"], number(edit["width"]), number(edit["height"]), number(edit["x"]), number(edit["y"])))
    elif op == "remove_keepout":
        found = [zone for zone in keepouts() if zone.GetZoneName() == edit["name"]]
        if not found:
            fail("The board has no keep-out area called %s." % edit["name"])
        for zone in found:
            board.Remove(zone)
            removed.append(zone)
        summary.append("Removed the keep-out area %s" % edit["name"])
    elif op == "track":
        layer = copper_layer(edit.get("layer", "F.Cu"))
        spots = [spot_of(point) for point in edit["points"]]
        if len(spots) < 2:
            fail("A track needs at least two points.")
        net = net_for(edit.get("net"), spots, layer)
        if net is None:
            fail("Say which net this track belongs to, or start it on a pad.")
        for position, pad in spots:
            if pad is None:
                continue
            if pad.GetNetCode() != net.GetNetCode():
                fail("%s is on %s, not on %s." % (pad_name(pad), pad.GetNetname() or "no net", net.GetNetname()))
            if not pad.IsOnLayer(layer):
                fail("%s has no copper on %s. Bring the track over with a via." % (pad_name(pad), board.GetLayerName(layer)))
        rules = settings.m_NetSettings.GetEffectiveNetClass(net.GetNetname())
        width = mm(edit["width"]) if "width" in edit else rules.GetTrackWidth()
        if width < settings.m_TrackMinWidth:
            fail("A track must be at least %s mm wide." % number(to_mm(settings.m_TrackMinWidth)))
        count = 0
        length = 0
        for (start, _), (end, _) in zip(spots, spots[1:]):
            if start == end:
                continue
            track = pcbnew.PCB_TRACK(board)
            track.SetStart(start)
            track.SetEnd(end)
            track.SetLayer(layer)
            track.SetWidth(width)
            track.SetNet(net)
            hit = blocked(track.GetEffectiveShape(), [layer], net)
            if hit:
                fail("The track from %s to %s on %s would touch %s. %s" % (
                    where(start), where(end), board.GetLayerName(layer), hit,
                    "Go around it." if hit.startswith("the keep-out") else "Go around it or use the other side."))
            board.Add(track)
            count += 1
            length += track.GetLength()
        if count == 0:
            fail("The track's points are all the same place.")
        summary.append("Routed %s from %s to %s on %s (%s mm)" % (
            net.GetNetname(), spot_name(spots[0]), spot_name(spots[-1]), board.GetLayerName(layer), number(to_mm(length))))
    elif op == "via":
        spot = spot_of(edit["at"])
        net = net_for(edit.get("net"), [spot], None)
        if net is None:
            fail("Say which net this via belongs to, or put it at the end of a track.")
        rules = settings.m_NetSettings.GetEffectiveNetClass(net.GetNetname())
        via = pcbnew.PCB_VIA(board)
        via.SetViaType(pcbnew.VIATYPE_THROUGH)
        via.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
        via.SetPosition(spot[0])
        via.SetWidth(pcbnew.F_Cu, rules.GetViaDiameter())
        via.SetDrill(rules.GetViaDrill())
        via.SetNet(net)
        hit = blocked(via.GetEffectiveShape(pcbnew.F_Cu), copper_layers, net, True)
        if hit:
            fail("A via at %s would touch %s." % (where(spot[0]), hit))
        board.Add(via)
        summary.append("Added a via on %s at %s" % (net.GetNetname(), where(spot[0])))
    elif op == "unroute":
        ids = set(edit.get("ids") or [])
        net = None
        if edit.get("net"):
            net = find_net(edit["net"])
            if net is None:
                fail("The board has no net called %s." % edit["net"])
        if net is None and not ids:
            fail("Say which net or which tracks to remove.")
        gone = []
        for track in list(board.GetTracks()):
            uuid = track.m_Uuid.AsString()
            if uuid in ids or (net is not None and track.GetNetCode() == net.GetNetCode()):
                ids.discard(uuid)
                gone.append(track.Type() == pcbnew.PCB_VIA_T)
                board.Remove(track)
                # Removed items are kept until the end: freeing one mid-run breaks KiCad's Python types.
                removed.append(track)
        if ids:
            fail("The board has no track or via with the id %s." % sorted(ids)[0])
        vias = sum(gone)
        tracks = len(gone) - vias
        if gone:
            what = " and ".join(part for part in (
                "%d track%s" % (tracks, "" if tracks == 1 else "s") if tracks else "",
                "%d via%s" % (vias, "" if vias == 1 else "s") if vias else "") if part)
            summary.append("Removed %s%s" % (what, " from " + net.GetNetname() if net is not None else ""))
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

areas = []
for zone in keepouts():
    box = zone.GetBoundingBox()
    areas.append({"name": zone.GetZoneName(), "x": to_mm(box.GetLeft()), "y": to_mm(box.GetTop()),
                  "width": to_mm(box.GetWidth()), "height": to_mm(box.GetHeight())})

print("KITTY_BOARD " + json.dumps({
    "summary": summary, "outline": outline, "parts": parts, "overlaps": overlaps[:40], "keepouts": areas}))
`;
