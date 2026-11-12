import { assert, it } from "vite-plus/test";

import {
  finishingEdits,
  freeroutingArgs,
  javaCandidates,
  parseAutorouteReport,
  pickFreeroutingJar,
} from "./boardAutoroute.ts";

it("looks for Java where the user says first", () => {
  assert.deepEqual(javaCandidates({ KITTY_JAVA: "/j/java", JAVA_HOME: "/jdk" }).slice(0, 3), [
    "/j/java",
    "/jdk/bin/java",
    "java",
  ]);
});

it("picks the newest Freerouting jar", () => {
  assert.equal(
    pickFreeroutingJar(["freerouting-2.5.0.jar", "notes.txt", "freerouting-2.10.0.jar"]),
    "freerouting-2.10.0.jar",
  );
  assert.equal(pickFreeroutingJar(["freerouting-cli"]), undefined);
});

it("runs the router without a window or usage data", () => {
  const args = freeroutingArgs("/f.jar", "/in.dsn", "/out.ses", 20);
  assert.deepEqual(args.slice(1, 9), [
    "-jar",
    "/f.jar",
    "-de",
    "/in.dsn",
    "-do",
    "/out.ses",
    "-mp",
    "20",
  ]);
  assert.include(args, "--gui.enabled=false");
  assert.include(args, "--usage_and_diagnostic_data.disable_analytics=true");
});

it("reads what the script reports", () => {
  assert.deepEqual(parseAutorouteReport('x\nKITTY_ROUTE {"tracks":47,"vias":4,"narrow":1}\n'), {
    tracks: 47,
    vias: 4,
    narrow: 1,
  });
  assert.deepEqual(parseAutorouteReport('KITTY_ROUTE {"error":"No outline."}'), {
    error: "No outline.",
  });
  assert.equal(parseAutorouteReport("Traceback"), undefined);
});

const boardOf = (net: string, extra = "") => `(kicad_pcb (version 20241229)
  (footprint "R" (layer "F.Cu") (at 10 10) (property "Reference" "R1")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net "${net}")))
  ${extra})`;

it("finishes a routed board with a ground pour and tidy references", () => {
  assert.deepEqual(finishingEdits(boardOf("/GND")), [
    { op: "pour", net: "/GND" },
    { op: "tidy_labels" },
  ]);
  // No ground net, or a pour already there: only the references are tidied.
  assert.deepEqual(finishingEdits(boardOf("+3V3")), [{ op: "tidy_labels" }]);
  const poured = `(zone (net 1) (net_name "GND") (layer "F.Cu") (uuid "z")
    (polygon (pts (xy 0 0) (xy 9 0) (xy 9 9))))`;
  assert.deepEqual(finishingEdits(boardOf("GND", poured)), [{ op: "tidy_labels" }]);
});
