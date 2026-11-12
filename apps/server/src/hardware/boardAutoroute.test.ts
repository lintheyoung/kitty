import { assert, it } from "vite-plus/test";

import {
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
