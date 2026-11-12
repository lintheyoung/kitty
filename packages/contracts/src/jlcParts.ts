import * as Schema from "effect/Schema";

/** How JLC stocks a part for assembly: basic and preferred parts carry no loading fee. */
export const JlcLibraryType = Schema.Literals(["basic", "preferred", "extended"]);
export type JlcLibraryType = typeof JlcLibraryType.Type;

/** A part in JLC's assembly catalogue. */
export const JlcPart = Schema.Struct({
  /** The LCSC part number, e.g. `C25804`. */
  lcsc: Schema.String,
  /** Manufacturer part number. */
  mpn: Schema.String,
  manufacturer: Schema.optional(Schema.String),
  package: Schema.String,
  description: Schema.String,
  category: Schema.optional(Schema.String),
  libraryType: JlcLibraryType,
  stock: Schema.Int,
  /** USD per piece at the smallest quantity. */
  unitPrice: Schema.optional(Schema.Number),
  /** A small photo of the part. The link only works for a short while. */
  image: Schema.optional(Schema.String),
  datasheet: Schema.optional(Schema.String),
});
export type JlcPart = typeof JlcPart.Type;

export const JlcPartSearchInput = Schema.Struct({
  query: Schema.String.annotate({
    description:
      'What to look for: a value and package ("10k 0603"), a part number, or an LCSC number.',
  }),
  basicOnly: Schema.optional(
    Schema.Boolean.annotate({
      description: "Only basic parts, which JLC assembles without a loading fee. Default false.",
    }),
  ),
  limit: Schema.optional(
    Schema.Int.annotate({ description: "At most this many parts. Default 12." }),
  ),
});
export type JlcPartSearchInput = typeof JlcPartSearchInput.Type;

export const JlcPartSearchResult = Schema.Struct({
  /** Basic parts first, then preferred, then extended; in-stock parts before empty ones. */
  parts: Schema.Array(JlcPart),
  /** How many parts JLC matched in total. */
  total: Schema.Int,
});
export type JlcPartSearchResult = typeof JlcPartSearchResult.Type;

export const JlcPartPin = Schema.Struct({ number: Schema.String, name: Schema.String });
export type JlcPartPin = typeof JlcPartPin.Type;

/** A JLC part whose symbol, footprint and 3D model are now in the design's library. */
/**
 * Whether a part's 3D model sits on its footprint. Position only: a model
 * turned the wrong way round on a symmetric body, or pin 1, is not seen.
 */
export const ModelFit = Schema.Struct({
  status: Schema.Literals(["fits", "off", "unchecked"]),
  /** What is wrong, or why it could not be checked. */
  note: Schema.optional(Schema.String),
});
export type ModelFit = typeof ModelFit.Type;

export const JlcImportedPart = Schema.Struct({
  lcsc: Schema.String,
  /** Library id to place in a schematic, e.g. `jlc:AMS1117-3.3`. */
  symbol: Schema.String,
  /** Library id of its footprint, e.g. `jlc:SOT-223-3_L6.5-W3.4-P2.30-LS7.0-BR`. */
  footprint: Schema.String,
  /** Reference prefix: `R`, `C`, `U`. */
  referencePrefix: Schema.String,
  mpn: Schema.String,
  description: Schema.String,
  pins: Schema.Array(JlcPartPin),
  /** The symbol library file, relative to the workspace. */
  library: Schema.String,
  /** Whether the 3D model sits on the footprint. */
  model: ModelFit,
});
export type JlcImportedPart = typeof JlcImportedPart.Type;

export const JlcPartImportInput = Schema.Struct({
  path: Schema.String.annotate({
    description:
      "The design to import into: its .kicad_pro, schematic or directory, relative to the workspace.",
  }),
  lcsc: Schema.String.annotate({ description: "The LCSC part number, e.g. C25804." }),
});
export type JlcPartImportInput = typeof JlcPartImportInput.Type;
