import { assert, it } from "vite-plus/test";

import { appendChange, parseChangeLog, userChangesSinceAgent } from "./schematicChangeLog.ts";

const change = (by: "user" | "agent", ...summary: ReadonlyArray<string>) => ({
  at: "2026-11-11T10:00:00.000Z",
  by,
  summary,
});

it("keeps a log that survives damaged lines", () => {
  let log = appendChange("", change("agent", "Placed R1"));
  log = appendChange(`${log}not json\n{"at":1}\n`, change("user", "Moved R1 to (10, 20)"));
  assert.deepStrictEqual(parseChangeLog(log), [
    change("agent", "Placed R1"),
    change("user", "Moved R1 to (10, 20)"),
  ]);
});

it("reports what the user did since the agent last edited", () => {
  const changes = [
    change("user", "Removed R9"),
    change("agent", "Placed R1", "Placed R2"),
    change("user", "Moved R1 to (10, 20)"),
    change("user", "Set R2 Value to 4.7k", "Connected R2 pin 2 to SDA"),
  ];
  assert.deepStrictEqual(userChangesSinceAgent(changes), [
    "Moved R1 to (10, 20)",
    "Set R2 Value to 4.7k",
    "Connected R2 pin 2 to SDA",
  ]);
  assert.deepStrictEqual(userChangesSinceAgent([change("user", "Removed R9")]), ["Removed R9"]);
  assert.deepStrictEqual(userChangesSinceAgent([...changes, change("agent", "Removed R2")]), []);
});
