/** Pure helpers for JLC's parts catalogue: request and reply shapes, ranking. */
import type { JlcLibraryType, JlcPart, JlcPartSearchResult } from "@t3tools/contracts";

export const JLC_SEARCH_URL =
  "https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList/v2";

/** JLC's API only answers requests that look like they come from its parts page. */
export const JLC_HEADERS = {
  accept: "application/json, text/plain, */*",
  origin: "https://jlcpcb.com",
  referer: "https://jlcpcb.com/parts/basic_parts",
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Kitty/0.1",
} as const;

/** Where to look for the converter: KITTY_EASYEDA2KICAD, then pipx's bin, then PATH. */
export function easyedaConverterCandidates(
  env: NodeJS.ProcessEnv,
  home: string,
): ReadonlyArray<string> {
  const configured = env.KITTY_EASYEDA2KICAD?.trim();
  return [...(configured ? [configured] : []), `${home}/.local/bin/easyeda2kicad`, "easyeda2kicad"];
}

export const EASYEDA_CONVERTER_MISSING =
  "easyeda2kicad is not installed. It converts JLC's symbols and footprints for KiCad. Install it with `pipx install easyeda2kicad`.";

/** `c25804` or `25804` as `C25804`; undefined when it is not an LCSC number. */
export function normalizeLcsc(code: string): string | undefined {
  const match = /^c?(\d{1,9})$/i.exec(code.trim());
  return match ? `C${match[1]}` : undefined;
}

export function jlcSearchBody(query: string, basicOnly: boolean, limit: number) {
  return {
    currentPage: 1,
    // Ranking happens here, so fetch more than is returned.
    pageSize: Math.min(Math.max(limit * 3, 15), 100),
    keyword: query,
    componentLibraryType: basicOnly ? "base" : null,
    preferredComponentFlag: null,
    stockFlag: null,
    stockSort: null,
    firstSortName: null,
    secondSortName: null,
    componentBrand: null,
    componentSpecification: null,
    componentAttributes: [],
    searchSource: "search",
  };
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
const string = (value: unknown): string => (typeof value === "string" ? value : "");
/** A web address from the catalogue, only if it is a plain https one. */
const link = (value: unknown): string =>
  typeof value === "string" && value.startsWith("https://") ? value : "";
const integer = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;

const RANK: Readonly<Record<JlcLibraryType, number>> = { basic: 0, preferred: 1, extended: 2 };

/** One catalogue row; undefined when it has no LCSC number. */
function toPart(raw: unknown): JlcPart | undefined {
  const row = record(raw);
  const lcsc = normalizeLcsc(string(row.componentCode));
  if (!lcsc) return undefined;
  const libraryType: JlcLibraryType =
    row.componentLibraryType === "base"
      ? "basic"
      : row.preferredComponentFlag === true
        ? "preferred"
        : "extended";
  const price = record(
    Array.isArray(row.componentPrices) ? row.componentPrices[0] : undefined,
  ).productPrice;
  const manufacturer = string(row.componentBrandEn);
  const category = [string(row.secondSortName), string(row.firstSortName)]
    .filter(Boolean)
    .join(" / ");
  const image = link(row.minImageAccessIdUrl) || link(row.productBigImageAccessIdUrl);
  const datasheet = link(row.dataManualUrl);
  return {
    lcsc,
    mpn: string(row.componentModelEn),
    package: string(row.componentSpecificationEn),
    description: string(row.describe),
    libraryType,
    stock: integer(row.stockCount),
    ...(manufacturer ? { manufacturer } : {}),
    ...(category ? { category } : {}),
    ...(typeof price === "number" ? { unitPrice: price } : {}),
    ...(image ? { image } : {}),
    ...(datasheet ? { datasheet } : {}),
  };
}

/**
 * The reply of JLC's parts search, ranked for a beginner: parts in stock
 * first, then basic before preferred before extended, then the deepest stock.
 */
export function parseJlcSearch(reply: unknown, limit: number): JlcPartSearchResult {
  const page = record(record(record(reply).data).componentPageInfo);
  const rows = Array.isArray(page.list) ? page.list : [];
  const parts = rows
    .map(toPart)
    .filter((part): part is JlcPart => part !== undefined)
    .toSorted(
      (a, b) =>
        Number(b.stock > 0) - Number(a.stock > 0) ||
        RANK[a.libraryType] - RANK[b.libraryType] ||
        b.stock - a.stock,
    );
  return { parts: parts.slice(0, limit), total: integer(page.total) };
}
