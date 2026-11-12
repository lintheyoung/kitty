import {
  HardwareToolError,
  type JlcImportedPart,
  type JlcPartImportInput,
  type JlcPartSearchInput,
  type JlcPartSearchResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { parseDoc } from "@t3tools/shared/kicad/sexprDoc";
import {
  describeSymbol,
  librarySymbols,
  mergeSymbolLibraries,
  withLibraryEntry,
  withUsablePinTypes,
} from "@t3tools/shared/kicad/symbolLibrary";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as ProcessRunner from "../processRunner.ts";
import { logTail } from "./buildOutput.ts";
import {
  easyedaConverterCandidates,
  EASYEDA_CONVERTER_MISSING,
  JLC_HEADERS,
  JLC_SEARCH_URL,
  jlcSearchBody,
  normalizeLcsc,
  parseJlcSearch,
} from "./jlcParts.ts";
import * as KicadService from "./KicadService.ts";
import { resolveInWorkspace } from "./workspacePath.ts";

type InWorkspace<A> = A & { readonly workspaceRoot: string };

/** The design library every imported JLC part goes into. */
const JLC_LIBRARY = "jlc";
const LIBRARY_DIRECTORY = "lib";
const DEFAULT_LIMIT = 12;

/**
 * JLC's parts catalogue: finding parts that JLC stocks and assembles, and
 * bringing a part's symbol, footprint and 3D model into a design's library.
 */
export class JlcPartsService extends Context.Service<
  JlcPartsService,
  {
    readonly search: (
      input: JlcPartSearchInput,
    ) => Effect.Effect<JlcPartSearchResult, HardwareToolError>;
    readonly importPart: (
      input: InWorkspace<JlcPartImportInput>,
    ) => Effect.Effect<JlcImportedPart, HardwareToolError>;
  }
>()("t3/hardware/JlcPartsService") {}

const make = Effect.fn("JlcPartsService.make")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const kicad = yield* KicadService.KicadService;
  const http = yield* HttpClient.HttpClient;

  const failure = (code: HardwareToolError["code"], message: string) =>
    new HardwareToolError({ code, message });
  const io = <A, E extends { readonly message: string }, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError((cause) => failure("command_failed", cause.message)));

  const search = Effect.fn("JlcPartsService.search")(function* (input: JlcPartSearchInput) {
    const query = input.query.trim();
    if (query === "") return yield* failure("invalid_argument", "Say what part to look for.");
    const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), 50);
    const reply = yield* http
      .execute(
        HttpClientRequest.post(JLC_SEARCH_URL).pipe(
          HttpClientRequest.setHeaders(JLC_HEADERS),
          HttpClientRequest.bodyJsonUnsafe(jlcSearchBody(query, input.basicOnly ?? false, limit)),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
        Effect.timeout("25 seconds"),
        Effect.mapError(() =>
          failure("command_failed", "Could not reach JLC's parts catalogue. Check the network."),
        ),
      );
    return parseJlcSearch(reply, limit);
  });

  const findConverter = Effect.fn("JlcPartsService.findConverter")(function* () {
    const env = yield* HostProcess.Environment;
    const home = yield* HostProcess.HomeDirectory;
    for (const command of easyedaConverterCandidates(env, home)) {
      const result = yield* processRunner
        .run({ command, args: ["--help"], timeout: "20 seconds" })
        .pipe(Effect.option);
      if (Option.isSome(result) && result.value.code === 0) return command;
    }
    return yield* failure("toolchain_missing", EASYEDA_CONVERTER_MISSING);
  });

  const importPart = Effect.fn("JlcPartsService.importPart")(function* (
    input: InWorkspace<JlcPartImportInput>,
  ) {
    const lcsc = normalizeLcsc(input.lcsc);
    if (!lcsc) {
      return yield* failure(
        "invalid_argument",
        `${input.lcsc} is not an LCSC part number like C25804.`,
      );
    }
    const target = yield* resolveInWorkspace(input.workspaceRoot, input.path).pipe(
      Effect.provideService(Path.Path, path),
    );
    const info = yield* fs.stat(target).pipe(Effect.option);
    if (Option.isNone(info)) return yield* failure("invalid_path", `${input.path} does not exist.`);
    const designDirectory = info.value.type === "Directory" ? target : path.dirname(target);
    const converter = yield* findConverter();

    return yield* Effect.scoped(
      Effect.gen(function* () {
        // Convert into a scratch library first: the design's library is only touched once
        // the part has converted and KiCad has rewritten it in its current format.
        // The converter needs the real path: it compares its output against its own cwd.
        const temp = yield* io(
          fs.makeTempDirectoryScoped({ prefix: "kitty-jlc-" }).pipe(Effect.flatMap(fs.realPath)),
        );
        const scratch = path.join(temp, LIBRARY_DIRECTORY);
        yield* io(fs.makeDirectory(scratch, { recursive: true }));
        const base = path.join(scratch, JLC_LIBRARY);
        const converted = yield* io(
          processRunner.run({
            command: converter,
            args: [
              "--full",
              "--lcsc_id",
              lcsc,
              "--output",
              base,
              "--project-relative",
              "--overwrite",
            ],
            cwd: temp,
            timeout: "2 minutes",
            outputMode: "truncate",
            timeoutBehavior: "timedOutResult",
          }),
        );
        const symbolFile = `${base}.kicad_sym`;
        const footprintDirectory = `${base}.pretty`;
        const produced = yield* fs.exists(symbolFile).pipe(Effect.orElseSucceed(() => false));
        if (converted.code !== 0 || converted.timedOut || !produced) {
          return yield* failure(
            "command_failed",
            `Could not import ${lcsc} from JLC. It may have no symbol in JLC's library.\n${logTail(`${converted.stdout}\n${converted.stderr}`, 6)}`,
          );
        }
        yield* io(fs.makeDirectory(footprintDirectory, { recursive: true }));
        yield* kicad.upgradeLibraries({ symbols: symbolFile, footprints: footprintDirectory });

        const incoming = yield* io(fs.readFileString(symbolFile)).pipe(
          Effect.flatMap((converted) =>
            Effect.try({
              try: () => withUsablePinTypes(converted),
              catch: (cause) =>
                failure(
                  "command_failed",
                  `JLC's symbol for ${lcsc} could not be read: ${String(cause)}`,
                ),
            }),
          ),
        );
        const symbol = librarySymbols(parseDoc(incoming))[0];
        if (!symbol) return yield* failure("command_failed", `JLC has no symbol for ${lcsc}.`);
        const described = describeSymbol(symbol);

        const library = path.join(designDirectory, LIBRARY_DIRECTORY);
        yield* io(fs.makeDirectory(library, { recursive: true }));
        const librarySymbolFile = path.join(library, `${JLC_LIBRARY}.kicad_sym`);
        const existing = yield* fs.readFileString(librarySymbolFile).pipe(Effect.option);
        const merged = yield* Effect.try({
          try: () => mergeSymbolLibraries(Option.getOrUndefined(existing), incoming),
          catch: (cause) =>
            failure(
              "command_failed",
              `The design's JLC library could not be read: ${String(cause)}`,
            ),
        });
        yield* io(fs.writeFileString(librarySymbolFile, merged));

        // Footprints and 3D models are one file per part, so they are simply copied over.
        for (const folder of [`${JLC_LIBRARY}.pretty`, `${JLC_LIBRARY}.3dshapes`]) {
          const from = path.join(scratch, folder);
          const names = yield* fs.readDirectory(from).pipe(Effect.orElseSucceed(() => []));
          if (names.length === 0) continue;
          yield* io(fs.makeDirectory(path.join(library, folder), { recursive: true }));
          for (const name of names) {
            yield* io(fs.copyFile(path.join(from, name), path.join(library, folder, name)));
          }
        }

        yield* kicad.seatLibraryModels(designDirectory);

        const tables = [
          ["sym-lib-table", "symbol", `${JLC_LIBRARY}.kicad_sym`],
          ["fp-lib-table", "footprint", `${JLC_LIBRARY}.pretty`],
        ] as const;
        for (const [file, kind, entry] of tables) {
          const tableFile = path.join(designDirectory, file);
          const current = yield* fs.readFileString(tableFile).pipe(Effect.option);
          const next = withLibraryEntry(Option.getOrUndefined(current), kind, {
            name: JLC_LIBRARY,
            uri: `\${KIPRJMOD}/${LIBRARY_DIRECTORY}/${entry}`,
            description: "Parts imported from JLC",
          });
          if (Option.getOrUndefined(current) !== next)
            yield* io(fs.writeFileString(tableFile, next));
        }

        return {
          lcsc,
          symbol: `${JLC_LIBRARY}:${described.name}`,
          footprint: described.properties.Footprint ?? "",
          referencePrefix: described.referencePrefix,
          mpn: described.properties.MPN ?? described.name,
          description:
            described.properties.ki_description ?? described.properties.Description ?? "",
          pins: [...described.pins],
          library: path.relative(input.workspaceRoot, librarySymbolFile),
          model: yield* kicad.footprintModelFit(
            designDirectory,
            (described.properties.Footprint ?? "").split(":").at(-1) ?? "",
          ),
        } satisfies JlcImportedPart;
      }),
    );
  });

  return JlcPartsService.of({ search, importPart });
});

export const layer = Layer.effect(JlcPartsService, make());
