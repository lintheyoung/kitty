/** Routing a board with Freerouting: KiCad's Python hands the board over and takes the tracks back. */
import type { BoardEdit } from "@t3tools/contracts";
import { buildBoardScene } from "@t3tools/shared/kicad/boardScene";

/**
 * What a routed board still needs to be a finished one: ground poured over the
 * free copper, unless the board already has a pour, and readable references.
 */
export function finishingEdits(source: string): ReadonlyArray<BoardEdit> {
  const scene = buildBoardScene(source);
  const poured = scene.items.some((item) => item.kind === "zone" && item.net !== undefined);
  const ground = scene.items.find(
    (item) => item.kind === "pad" && item.net?.replace(/^\//, "").toUpperCase() === "GND",
  )?.net;
  return [
    ...(ground && !poured ? [{ op: "pour", net: ground } as const] : []),
    { op: "tidy_labels" },
  ];
}

/** Java to run the router with: KITTY_JAVA, JAVA_HOME, PATH, then where Homebrew puts it. */
export function javaCandidates(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const configured = env.KITTY_JAVA?.trim();
  const home = env.JAVA_HOME?.trim();
  return [
    ...(configured ? [configured] : []),
    ...(home ? [`${home}/bin/java`] : []),
    "java",
    "/opt/homebrew/opt/openjdk/bin/java",
    "/usr/local/opt/openjdk/bin/java",
  ];
}

/** Folders a Freerouting jar is looked for in, under the user's home. */
export const FREEROUTING_FOLDERS = [".kitty/tools/freerouting", ".local/share/freerouting"];

/** The newest Freerouting jar among a folder's files. */
export function pickFreeroutingJar(files: ReadonlyArray<string>): string | undefined {
  return files
    .filter((file) => /^freerouting.*\.jar$/i.test(file))
    .toSorted(new Intl.Collator("en", { numeric: true }).compare)
    .at(-1);
}

export const FREEROUTING_MISSING =
  "Auto-routing needs Java and Freerouting. Install Java (brew install openjdk), download freerouting.jar from github.com/freerouting/freerouting/releases into ~/.kitty/tools/freerouting, or set KITTY_FREEROUTING_JAR.";

/** Runs the router without its window and without sending usage data. */
export const freeroutingArgs = (
  jar: string,
  dsn: string,
  ses: string,
  passes: number,
): ReadonlyArray<string> => [
  "-Djava.awt.headless=true",
  "-jar",
  jar,
  "-de",
  dsn,
  "-do",
  ses,
  "-mp",
  String(passes),
  "--gui.enabled=false",
  "--usage_and_diagnostic_data.disable_analytics=true",
  "--profile.allow_telemetry=false",
  "-dct",
  "0",
];

export const autorouteJob = (job: {
  readonly mode: "export" | "import";
  readonly board: string;
  readonly dsn: string;
  readonly ses: string;
}): string => JSON.stringify(job);

export interface AutorouteReport {
  readonly tracks: number;
  readonly vias: number;
  /** Tracks left thinner than the board allows because widening them would touch other copper. */
  readonly narrow: number;
}

const REPORT_MARK = "KITTY_ROUTE ";

/** The script's last word: what it did, or why it could not. Undefined when it did not finish. */
export function parseAutorouteReport(
  stdout: string,
): AutorouteReport | { readonly error: string } | undefined {
  const line = stdout.split("\n").findLast((candidate) => candidate.startsWith(REPORT_MARK));
  if (!line) return undefined;
  try {
    const report = JSON.parse(line.slice(REPORT_MARK.length)) as {
      error?: unknown;
      tracks?: number;
      vias?: number;
      narrow?: number;
    };
    if (typeof report.error === "string") return { error: report.error };
    return { tracks: report.tracks ?? 0, vias: report.vias ?? 0, narrow: report.narrow ?? 0 };
  } catch {
    return undefined;
  }
}

/** Run by KiCad's Python: writes the board for the router, or reads the router's tracks back. */
export const AUTOROUTE_SCRIPT = String.raw`import json, sys
import pcbnew

job = json.load(open(sys.argv[1]))
board = pcbnew.LoadBoard(job["board"])

def done(report):
    print("KITTY_ROUTE " + json.dumps(report))
    sys.exit(0)

if job["mode"] == "export":
    edges = board.GetBoardEdgesBoundingBox()
    if edges.GetWidth() <= 0 or edges.GetHeight() <= 0:
        done({"error": "The board has no outline yet. Set one with pcb_edit before routing."})
    outside = sorted(fp.GetReference() for fp in board.GetFootprints()
                     if not edges.Contains(fp.GetBoundingBox(False)))
    if outside:
        done({"error": "Place every part inside the outline before routing. Still outside: %s." % ", ".join(outside[:20])})
    if not pcbnew.ExportSpecctraDSN(board, job["dsn"]):
        done({"error": "KiCad could not write the board for the router."})
    done({})

if not pcbnew.ImportSpecctraSES(board, job["ses"]):
    done({"error": "KiCad could not read the router's result."})

settings = board.GetDesignSettings()

def touches(track, layer):
    """Whether the track comes too close to copper of another net."""
    gap = settings.m_NetSettings.GetEffectiveNetClass(track.GetNetname()).GetClearance()
    shape = track.GetEffectiveShape()
    for fp in board.GetFootprints():
        for pad in fp.Pads():
            if pad.GetNetCode() != track.GetNetCode() and pad.IsOnLayer(layer):
                if shape.Collide(pad.GetEffectiveShape(layer), gap):
                    return True
    for other in board.GetTracks():
        if other.GetNetCode() == track.GetNetCode() or not other.IsOnLayer(layer):
            continue
        via = other.Type() == pcbnew.PCB_VIA_T
        if shape.Collide(other.GetEffectiveShape(layer) if via else other.GetEffectiveShape(), gap):
            return True
    return False

# The router thins tracks where they leave fine pads; bring them back to the net's width where there is room.
tracks = vias = narrow = 0
for track in board.GetTracks():
    if track.Type() == pcbnew.PCB_VIA_T:
        vias += 1
        continue
    tracks += 1
    thin = track.GetWidth()
    if thin >= settings.m_TrackMinWidth:
        continue
    wanted = settings.m_NetSettings.GetEffectiveNetClass(track.GetNetname()).GetTrackWidth()
    track.SetWidth(max(wanted, settings.m_TrackMinWidth))
    if touches(track, track.GetLayer()):
        track.SetWidth(thin)
        narrow += 1

pcbnew.SaveBoard(job["board"], board)
done({"tracks": tracks, "vias": vias, "narrow": narrow})
`;
