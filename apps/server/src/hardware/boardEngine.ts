/** Copper, the KiCad engine Kitty runs for the design, from the schematic to the fab files. */

/** The Copper commit Kitty was tested with; the user may move to a newer one from the designer. */
export const COPPER_COMMIT = "303964c8b70cb0f99b1635efcc681ec83d237c3c";
const COPPER_REPOSITORY = "claynicholson/copper-kicad-mcp";
export const COPPER_PAGE = `https://github.com/${COPPER_REPOSITORY}`;
export const copperArchiveUrl = (commit: string) =>
  `https://codeload.github.com/${COPPER_REPOSITORY}/tar.gz/${commit}`;
/** GitHub's list of what the repository has that this commit does not. */
export const copperCompareUrl = (commit: string) =>
  `https://api.github.com/repos/${COPPER_REPOSITORY}/compare/${commit}...HEAD`;
/** The user's choice of a newer Copper, kept under Copper's own folder. */
export const COPPER_CHOICE_FILE = "engine.json";
const COMMIT = /^[0-9a-f]{40}$/;
const NOTES_SHOWN = 8;

/** The commit the user moved to, read from the choice file; none when it names no commit. */
export function chosenEngineCommit(text: string | undefined): string | undefined {
  if (!text) return undefined;
  try {
    const commit = (JSON.parse(text) as { commit?: unknown }).commit;
    return typeof commit === "string" && COMMIT.test(commit) ? commit : undefined;
  } catch {
    return undefined;
  }
}

export const engineChoiceText = (commit: string) => `${JSON.stringify({ commit }, null, 2)}\n`;

export interface EngineNews {
  /** The newest commit of Copper; absent when the one in use is the newest. */
  readonly latest?: string;
  readonly behind: number;
  /** The first line of each new commit, newest first. */
  readonly notes: ReadonlyArray<string>;
}

/** What GitHub's comparison says is new; none when the answer is not a comparison. */
export function parseEngineNews(text: string): EngineNews | undefined {
  try {
    const parsed = JSON.parse(text) as { ahead_by?: unknown; commits?: unknown };
    if (typeof parsed.ahead_by !== "number" || !Array.isArray(parsed.commits)) return undefined;
    const commits = (
      parsed.commits as ReadonlyArray<{ sha?: unknown; commit?: { message?: unknown } }>
    )
      .filter((entry) => typeof entry.sha === "string" && COMMIT.test(entry.sha))
      .toReversed();
    const latest = commits[0]?.sha;
    if (parsed.ahead_by === 0 || typeof latest !== "string") return { behind: 0, notes: [] };
    return {
      latest,
      behind: parsed.ahead_by,
      notes: commits.slice(0, NOTES_SHOWN).flatMap((entry) => {
        const message = entry.commit?.message;
        const line = typeof message === "string" ? message.split("\n")[0]?.trim() : undefined;
        return line ? [line.slice(0, 160)] : [];
      }),
    };
  } catch {
    return undefined;
  }
}
interface Finding {
  readonly severity: string;
  readonly description: string;
  readonly items: ReadonlyArray<{ readonly description: string }>;
}
interface CheckCounts {
  readonly summary: { readonly errors: number };
  readonly violations: ReadonlyArray<Finding>;
}
const FINDINGS_SHOWN = 6;

/**
 * Why the order files may not be made yet: the errors KiCad's own checks still count.
 * None when the schematic and the board are clean; warnings do not hold an order back.
 */
export function orderRefusal(
  erc: CheckCounts,
  drc: CheckCounts & { readonly unconnected: ReadonlyArray<Finding> },
): string | undefined {
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  // KiCad counts each unrouted connection among the board's errors; here it is named apart.
  const boardErrors = Math.max(0, drc.summary.errors - drc.unconnected.length);
  const counts = [
    erc.summary.errors > 0 ? plural(erc.summary.errors, "schematic error") : undefined,
    boardErrors > 0 ? plural(boardErrors, "board error") : undefined,
    drc.unconnected.length > 0 ? plural(drc.unconnected.length, "unrouted connection") : undefined,
  ].filter((count) => count !== undefined);
  if (counts.length === 0) return undefined;
  const findings = [
    ...[...erc.violations, ...drc.violations].filter((violation) => violation.severity === "error"),
    ...drc.unconnected,
  ]
    .slice(0, FINDINGS_SHOWN)
    .map((violation) => {
      const about = violation.items[0]?.description;
      return `- ${violation.description}${about ? `: ${about}` : ""}`;
    });
  return [
    `The order files were not made: ${counts.join(", ")}. A board ordered like this would likely not work.`,
    ...findings,
    "Fix each one at its cause and check again; then the order files can be made.",
  ].join("\n");
}

/** Under the user's home: the engine's source, its Python, and its own cache and settings. */
export const COPPER_FOLDER = ".kitty/tools/copper";
export const COPPER_HOME_FOLDER = ".kitty/copper";

/** Pythons tried for the engine, newest first; it needs 3.10 or later with Pillow. */
export const ENGINE_PYTHONS = [
  "python3.14",
  "python3.13",
  "python3.12",
  "python3.11",
  "python3.10",
  "python3",
];

/** Prints `ok` when this Python can run the engine as it is. */
export const ENGINE_PYTHON_CHECK =
  "import sys; assert sys.version_info >= (3, 10); import PIL; print('ok')";
/** Prints `ok` when this Python is new enough to hold the engine's own environment. */
export const ENGINE_PYTHON_VERSION_CHECK =
  "import sys; assert sys.version_info >= (3, 10); print('ok')";

export const ENGINE_MISSING =
  "The PCB engine needs Python 3.10 or later, which this computer does not have. Install it (brew install python) and try again.";

/**
 * Runs one engine tool on one project and prints `{summary, report}` or `{error}`.
 * Arguments: the engine's source folder, the .kicad_pro, the tool name, the JSON arguments.
 */
export const ENGINE_RUNNER = `import json, os, subprocess, sys

source, project, tool, arguments = sys.argv[1:5]
server = subprocess.Popen(
    [sys.executable, "-I", "-c",
     "import sys; sys.path.insert(0, %r); from copper_kicad.cli import main; sys.argv = ['copper', 'serve']; main()" % source],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
    cwd=os.path.dirname(project) or None)

def call(number, method, params):
    server.stdin.write(json.dumps({"jsonrpc": "2.0", "id": number, "method": method, "params": params}) + "\\n")
    server.stdin.flush()
    while True:
        line = server.stdout.readline()
        if not line:
            return {"error": {"message": "The PCB engine stopped without an answer."}}
        try:
            reply = json.loads(line)
        except ValueError:
            continue
        if reply.get("id") == number:
            return reply

def text_of(reply):
    if "error" in reply:
        return None, str(reply["error"].get("message", reply["error"]))
    result = reply.get("result", {})
    text = "\\n".join(part.get("text", "") for part in result.get("content", []) if part.get("type") == "text")
    return (None, text) if result.get("isError") else (text, None)

call(1, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "kitty", "version": "1"}})
server.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\\n")
server.stdin.flush()
failed = None
if project:
    _, failed = text_of(call(2, "tools/call", {"name": "project_open", "arguments": {"path": project}}))
text = None
if failed is None:
    text, failed = text_of(call(3, "tools/call", {"name": tool, "arguments": json.loads(arguments)}))
server.stdin.close()
server.terminate()
if failed is not None:
    print(json.dumps({"error": failed}))
else:
    summary, _, report = text.partition("\\n")
    print(json.dumps({"summary": summary.strip(), "report": report.strip()}))
`;

/** A tool's arguments as the runner reads them. */
export const engineArguments = (value: Readonly<Record<string, unknown>>): string =>
  JSON.stringify(value);

export interface EngineReply {
  readonly summary: string;
  /** The engine's findings and numbers, as the JSON text it gave. */
  readonly report: string;
}

/** The runner's last line of output, read back; undefined when it is not a reply. */
export function parseEngineReply(
  stdout: string,
): EngineReply | { readonly error: string } | undefined {
  const line = stdout.trim().split("\n").at(-1);
  if (!line) return undefined;
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const reply = parsed as { summary?: unknown; report?: unknown; error?: unknown };
    if (typeof reply.error === "string") return { error: reply.error };
    return typeof reply.summary === "string" && typeof reply.report === "string"
      ? { summary: reply.summary, report: reply.report }
      : undefined;
  } catch {
    return undefined;
  }
}

/** What each point of the layout review means, in plain words. */
const LAYOUT_TITLES: Readonly<Record<string, string>> = {
  decap_far: "Decoupling capacitors are far from the pins they serve",
  connector_off_edge: "A connector does not sit at the board edge",
  vias_per_net: "Tracks change layers often",
  emptiest_third: "Part of the board is left empty",
  imbalance: "The parts are bunched on one side",
  silk_unreadable: "A reference on the silkscreen cannot be read",
  hs_plane_crossings: "Tracks cross under a fast signal",
  power_thinner_than_pad: "A supply track is thinner than its pads allow",
  largest_empty: "A large area of the board is unused",
  passives_aligned: "Small parts are not lined up",
};

export interface LayoutReview {
  /** Out of 100. */
  readonly score?: number;
  readonly points: ReadonlyArray<{
    readonly type: string;
    readonly description: string;
    readonly fix?: string;
  }>;
}

/** The layout score and its weak points, read from the engine's `elegance` report. */
export function parseLayoutReview(report: string): LayoutReview {
  let parsed: unknown;
  try {
    parsed = JSON.parse(report);
  } catch {
    return { points: [] };
  }
  const elegance = (parsed as { elegance?: unknown } | null)?.elegance;
  if (typeof elegance !== "object" || elegance === null) return { points: [] };
  const { score, worst } = elegance as { score?: unknown; worst?: unknown };
  const points = (Array.isArray(worst) ? worst : []).flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { what, value, target, fix } = entry as Record<string, unknown>;
    if (typeof what !== "string") return [];
    const title = LAYOUT_TITLES[what] ?? what.replaceAll("_", " ");
    const measured = typeof value === "string" || typeof value === "number" ? `: ${value}` : "";
    const wanted = typeof target === "string" ? ` (aim: ${target})` : "";
    return [
      {
        type: `layout_${what}`,
        description: `${title}${measured}${wanted}`,
        ...(typeof fix === "string" ? { fix } : {}),
      },
    ];
  });
  return { ...(typeof score === "number" ? { score } : {}), points };
}

/** The pictures a report names, as the engine saved them under the design folder. */
export const enginePictures = (report: string): ReadonlyArray<string> => [
  ...new Set(report.match(/copper-out\/[^"\\]+?\.png/g) ?? []),
];
