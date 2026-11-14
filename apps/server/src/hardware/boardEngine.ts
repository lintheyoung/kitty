/** Copper, the PCB engine Kitty runs for reading, routing and reviewing boards. */

/** The Copper commit Kitty was tested with; a newer one is taken only by changing this. */
export const COPPER_COMMIT = "303964c8b70cb0f99b1635efcc681ec83d237c3c";
export const COPPER_ARCHIVE_URL = `https://codeload.github.com/claynicholson/copper-kicad-mcp/tar.gz/${COPPER_COMMIT}`;
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
    cwd=os.path.dirname(project))

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

/** The engine names its own tools in its hints; these are the Kitty tools that do the same. */
const KITTY_TOOLS: ReadonlyArray<readonly [RegExp, string]> = [
  [/pcb_place\(moves=\[\{ref:'([^']+)', x:\.\., y:\.\.\}\]\)/g, "pcb_edit move $1"],
  [
    /pcb_place\(auto=true, clear_tracks=true\) then pcb_route\(\)/g,
    "move the parts with pcb_edit, then pcb_route with ripup all",
  ],
  [/pcb_route_guided\(/g, "pcb_route("],
  [/fab_export\(\)/g, "kicad_fab_export"],
  [/verify\(what=\[[^\]]*\]\)|verify\(\)/g, "pcb_review"],
  [/checkpoint\(action='restore'[^)]*\)/g, "undo in the designer"],
];

/** The engine's text with its tool names turned into Kitty's. */
export const inKittyTerms = (text: string): string =>
  KITTY_TOOLS.reduce((result, [pattern, name]) => result.replace(pattern, name), text);

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
    if (typeof reply.error === "string") return { error: inKittyTerms(reply.error) };
    return typeof reply.summary === "string" && typeof reply.report === "string"
      ? { summary: inKittyTerms(reply.summary), report: inKittyTerms(reply.report) }
      : undefined;
  } catch {
    return undefined;
  }
}
