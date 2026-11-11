import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import * as KicadService from "./KicadService.ts";

const result = (stdout: string, code = 0, stderr = "") => ({
  stdout,
  stderr,
  code: code as never,
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const ERC = JSON.stringify({
  kicad_version: "10.0.7",
  sheets: [
    {
      path: "/",
      violations: [
        {
          type: "pin_not_connected",
          severity: "error",
          description: "Pin not connected",
          items: [{ description: "Symbol U1 Pin 2 [EN]", pos: { x: 1, y: 2 } }],
        },
      ],
    },
  ],
});

/** A fake kicad-cli: `version` answers, and `-o <file>` gets `report` written to it. */
const fakeCli = (
  calls: Array<ReadonlyArray<string>>,
  options: { readonly installed?: boolean; readonly fail?: boolean; readonly report?: string } = {},
) =>
  ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.gen(function* () {
        if (options.installed === false) return result("", 127);
        if (input.args[0] === "version") return result("10.0.7\n");
        calls.push(input.args);
        if (options.fail) {
          return result(
            "",
            1,
            'Fontconfig warning: "/opt/homebrew/etc/fonts/conf.d/48-guessfamily.conf", line 19\nFailed to load schematic',
          );
        }
        const output = input.args[input.args.indexOf("-o") + 1];
        if (output) {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.writeFileString(output, options.report ?? ERC).pipe(Effect.orDie);
        }
        return result("");
      }).pipe(Effect.provide(NodeServices.layer)),
  });

const workspace = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "kitty-kicad-test-" });
  const board = path.join(root, "hw", "keycap");
  yield* fs.makeDirectory(board, { recursive: true });
  for (const file of ["keycap.kicad_pro", "keycap.kicad_sch", "power.kicad_sch"]) {
    yield* fs.writeFileString(path.join(board, file), "");
  }
  return root;
});

const withCli = <A, E, R>(
  runner: ProcessRunner.ProcessRunner["Service"],
  use: (service: KicadService.KicadService["Service"]) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    return yield* use(yield* KicadService.make());
  }).pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
    Effect.provideService(HostProcess.Environment, {}),
    Effect.provideService(
      SecureRandom.SecureRandom,
      SecureRandom.make((size) => new Uint8Array(size).fill(7)),
    ),
  );

it.effect("finds a project's root schematic from its directory or .kicad_pro", () =>
  Effect.gen(function* () {
    const root = yield* workspace();
    const calls: Array<ReadonlyArray<string>> = [];
    for (const path of ["hw/keycap", "hw/keycap/keycap.kicad_pro", "hw/keycap/keycap.kicad_sch"]) {
      const report = yield* withCli(fakeCli(calls), (service) =>
        service.erc({ workspaceRoot: root, path }),
      );
      assert.equal(report.schematic, "hw/keycap/keycap.kicad_sch");
      assert.equal(report.summary.errors, 1);
      assert.equal(report.violations[0]?.type, "pin_not_connected");
    }
    assert.isTrue(calls.every((args) => args.at(-1)?.endsWith("hw/keycap/keycap.kicad_sch")));
    assert.deepStrictEqual(calls[0]?.slice(0, 5), [
      "sch",
      "erc",
      "--format",
      "json",
      "--severity-all",
    ]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects missing designs and paths outside the workspace", () =>
  Effect.gen(function* () {
    const root = yield* workspace();
    const calls: Array<ReadonlyArray<string>> = [];
    const noBoard = yield* Effect.flip(
      withCli(fakeCli(calls), (service) => service.drc({ workspaceRoot: root, path: "hw/keycap" })),
    );
    assert.equal(noBoard.code, "invalid_path");
    const outside = yield* Effect.flip(
      withCli(fakeCli(calls), (service) => service.erc({ workspaceRoot: root, path: "../x" })),
    );
    assert.equal(outside.code, "invalid_path");
    assert.equal(calls.length, 0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reports a missing kicad-cli and kicad-cli failures without fontconfig noise", () =>
  Effect.gen(function* () {
    const root = yield* workspace();
    const missing = yield* Effect.flip(
      withCli(fakeCli([], { installed: false }), (service) =>
        service.erc({ workspaceRoot: root, path: "hw/keycap" }),
      ),
    );
    assert.equal(missing.code, "toolchain_missing");
    const failed = yield* Effect.flip(
      withCli(fakeCli([], { fail: true }), (service) =>
        service.erc({ workspaceRoot: root, path: "hw/keycap" }),
      ),
    );
    assert.equal(failed.code, "command_failed");
    assert.include(failed.message, "Failed to load schematic");
    assert.notInclude(failed.message, "Fontconfig");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("returns one component's pin table from the netlist", () =>
  Effect.gen(function* () {
    const root = yield* workspace();
    const netlist = `(export (components
      (comp (ref "U1") (value "ESP32-S3-WROOM-1"))
      (comp (ref "D1") (value "LED")))
      (nets
        (net (name "/LED") (node (ref "U1") (pin "12") (pinfunction "IO48")) (node (ref "D1") (pin "2")))))`;
    const result = yield* withCli(fakeCli([], { report: netlist }), (service) =>
      service.netlist({ workspaceRoot: root, path: "hw/keycap", component: "u1" }),
    );
    assert.deepStrictEqual(result.pins, [
      { pin: "12", function: "IO48", net: "/LED", connected: true, others: ["D1.2"] },
    ]);
    const unknown = yield* Effect.flip(
      withCli(fakeCli([], { report: netlist }), (service) =>
        service.netlist({ workspaceRoot: root, path: "hw/keycap", component: "U9" }),
      ),
    );
    assert.equal(unknown.code, "invalid_argument");
    assert.include(unknown.message, "U1, D1");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("reads copper layers from a board header", () => {
  const board = `(kicad_pcb
	(version 20250114)
	(layers
		(0 "F.Cu" signal "Top Layer")
		(4 "In1.Cu" power "GND")
		(2 "B.Cu" signal)
		(9 "F.Adhes" user "F.Adhesive")
		(25 "Edge.Cuts" user)
	)
	(segment (layer "F.Cu")))`;
  assert.deepStrictEqual(KicadService.boardCopperLayers(board), ["F.Cu", "In1.Cu", "B.Cu"]);
});

/** A fake kicad-cli that draws SVGs like `export svg`: sheets into a directory, a board into a file. */
const drawingCli = (calls: Array<ReadonlyArray<string>>, boardSvg: string) =>
  ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.gen(function* () {
        if (input.args[0] === "version") return result("10.0.7\n");
        calls.push(input.args);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const output = input.args[input.args.indexOf("-o") + 1] ?? "";
        if (input.args[0] === "sch") {
          yield* fs
            .writeFileString(path.join(output, "keycap.svg"), "<svg>root</svg>")
            .pipe(Effect.orDie);
          yield* fs
            .writeFileString(path.join(output, "keycap-power.svg"), "<svg>power</svg>")
            .pipe(Effect.orDie);
        } else {
          yield* fs.writeFileString(output, boardSvg).pipe(Effect.orDie);
        }
        return result("");
      }).pipe(Effect.provide(NodeServices.layer)),
  });

it.effect("draws schematic sheets root first, and a board unless it is blank", () =>
  Effect.gen(function* () {
    const root = yield* workspace();
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(`${root}/hw/keycap/keycap.kicad_pcb`, "");
    const calls: Array<ReadonlyArray<string>> = [];
    const sheets = yield* withCli(drawingCli(calls, ""), (service) =>
      service.preview({
        workspaceRoot: root,
        path: "hw/keycap/keycap.kicad_pro",
        kind: "schematic",
      }),
    );
    assert.equal(sheets.file, "hw/keycap/keycap.kicad_sch");
    assert.deepStrictEqual(
      sheets.pages.map((page) => page.name),
      ["Root sheet", "power"],
    );

    const drawn = '<svg viewBox="0 0 33.2 18.1"><path/></svg>';
    const board = yield* withCli(drawingCli(calls, drawn), (service) =>
      service.preview({ workspaceRoot: root, path: "hw/keycap", kind: "board" }),
    );
    assert.equal(board.file, "hw/keycap/keycap.kicad_pcb");
    assert.deepStrictEqual(board.pages, [{ name: "Board", svg: drawn }]);
    assert.include(calls.at(-1) ?? [], "--mode-single");

    const blank = yield* withCli(
      drawingCli(calls, '<svg viewBox="0.0000 0.0000 0.2540 0.2540"></svg>'),
      (service) => service.preview({ workspaceRoot: root, path: "hw/keycap", kind: "board" }),
    );
    assert.equal(blank.pages.length, 0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("returns the design's sheets and board as text, following sub-sheets", () =>
  Effect.gen(function* () {
    const root = yield* workspace();
    const fs = yield* FileSystem.FileSystem;
    const sheet = (file: string) =>
      `(kicad_sch (sheet (at 0 0) (size 10 10) (property "Sheetname" "Power") (property "Sheetfile" "${file}")))`;
    yield* fs.writeFileString(`${root}/hw/keycap/keycap.kicad_sch`, sheet("power.kicad_sch"));
    // A sheet that points outside the workspace is not followed.
    yield* fs.writeFileString(
      `${root}/hw/keycap/power.kicad_sch`,
      sheet("../../../outside.kicad_sch"),
    );
    yield* fs.writeFileString(`${root}/hw/keycap/keycap.kicad_pcb`, "(kicad_pcb)");
    const design = yield* withCli(drawingCli([], ""), (service) =>
      service.designSource({ workspaceRoot: root, path: "hw/keycap/keycap.kicad_pro" }),
    );
    assert.deepStrictEqual(
      design.sheets.map((entry) => [entry.name, entry.file]),
      [
        ["Root sheet", "hw/keycap/keycap.kicad_sch"],
        ["Power", "hw/keycap/power.kicad_sch"],
      ],
    );
    assert.equal(design.board?.source, "(kicad_pcb)");
    assert.equal(design.omitted, 0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const EDIT_LIBRARY = `(kicad_symbol_lib
  (symbol "R"
    (property "Reference" "R" (at 0 2.54 0))
    (property "Value" "R" (at 0 -2.54 0))
    (symbol "R_0_1"
      (pin passive line (at -5.08 0 0) (length 2.54) (name "A") (number "1"))
      (pin passive line (at 5.08 0 180) (length 2.54) (name "B") (number "2"))
    )
  )
)`;
const EDIT_SHEET = `(kicad_sch\n\t(version 20260306)\n\t(uuid "11111111-2222-3333-4444-555555555555")\n\t(paper "A4")\n\t(lib_symbols)\n)\n`;
const EDIT_NETLIST = `(export (components (comp (ref "R1") (value "10k")))
  (nets (net (code "1") (name "/EN") (node (ref "R1") (pin "2") (pinfunction "B")))
        (net (code "2") (name "/OTHER") (node (ref "R1") (pin "1") (pinfunction "A")))))`;

/** A fake kicad-cli for edits: a netlist for `export netlist`, an ERC report for `erc`. */
const editCli = (fail: boolean) =>
  ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.gen(function* () {
        if (input.args[0] === "version") return result("10.0.7\n");
        if (fail) return result("", 1, "Failed to load schematic");
        const fs = yield* FileSystem.FileSystem;
        const output = input.args[input.args.indexOf("-o") + 1] ?? "";
        yield* fs
          .writeFileString(output, input.args[1] === "erc" ? ERC : EDIT_NETLIST)
          .pipe(Effect.orDie);
        return result("");
      }).pipe(Effect.provide(NodeServices.layer)),
  });

it.effect("edits a schematic, reports what KiCad resolved, and undoes it", () =>
  Effect.gen(function* () {
    const root = yield* workspace();
    const fs = yield* FileSystem.FileSystem;
    const file = `${root}/hw/keycap/keycap.kicad_sch`;
    yield* fs.makeDirectory(`${root}/hw/keycap/lib`);
    yield* fs.writeFileString(`${root}/hw/keycap/lib/jlc.kicad_sym`, EDIT_LIBRARY);
    yield* fs.writeFileString(file, EDIT_SHEET);
    const target = { workspaceRoot: root, path: "hw/keycap/keycap.kicad_pro" };
    const place = {
      op: "place" as const,
      symbol: "jlc:R",
      value: "10k",
      nets: { "1": "+3V3", "2": "EN" },
    };

    yield* withCli(editCli(false), (service) =>
      Effect.gen(function* () {
        const edited = yield* service.schematicEdit({ ...target, edits: [place] });
        assert.equal(edited.schematic, "hw/keycap/keycap.kicad_sch");
        assert.deepStrictEqual(edited.erc, { errors: 1, warnings: 0 });
        assert.deepStrictEqual(edited.parts[0]?.pins, [
          { number: "1", name: "A", net: "/OTHER" },
          { number: "2", name: "B", net: "/EN" },
        ]);
        // KiCad put pin 1 on another net than the one asked for.
        assert.deepStrictEqual(edited.warnings, ["R1 pin 1 is on /OTHER, not +3V3."]);
        const saved = yield* fs.readFileString(file);
        assert.include(saved, '(lib_id "jlc:R")');

        const undone = yield* service.schematicHistory({ ...target, step: "undo" });
        assert.deepStrictEqual(undone, { ...undone, applied: true, undo: 0, redo: 1 });
        assert.equal(yield* fs.readFileString(file), EDIT_SHEET);
        const again = yield* service.schematicHistory({ ...target, step: "undo" });
        assert.equal(again.applied, false);
        yield* service.schematicHistory({ ...target, step: "redo" });
        assert.equal(yield* fs.readFileString(file), saved);

        // A save from somewhere else starts the history over.
        yield* fs.writeFileString(file, EDIT_SHEET);
        const stale = yield* service.schematicHistory({ ...target, step: "undo" });
        assert.equal(stale.applied, false);
      }),
    );

    // Nothing is saved when KiCad cannot read the result, or a part is not from JLC.
    const unreadable = yield* withCli(editCli(true), (service) =>
      service.schematicEdit({ ...target, edits: [place] }).pipe(Effect.flip),
    );
    assert.include(unreadable.message, "nothing was changed");
    const foreign = yield* withCli(editCli(false), (service) =>
      service
        .schematicEdit({ ...target, edits: [{ op: "place", symbol: "Device:R" }] })
        .pipe(Effect.flip),
    );
    assert.equal(foreign.code, "invalid_argument");
    assert.equal(yield* fs.readFileString(file), EDIT_SHEET);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
