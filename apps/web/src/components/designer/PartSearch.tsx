import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  JlcImportedPart,
  JlcPart,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { ImageOffIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { hardwareJlcImport, hardwareJlcSearch } from "../../state/hardware";
import { formatEnvironmentQueryError } from "../../state/query";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

const options = { reportFailure: false } as const;

const LIBRARY_BADGES = {
  basic: { variant: "success", label: "Basic" },
  preferred: { variant: "info", label: "Preferred" },
  extended: { variant: "warning", label: "Extended" },
} as const;

/** Short stock figure: 1234567 as 1.2M. */
function formatStock(stock: number): string {
  if (stock <= 0) return "Out of stock";
  if (stock >= 1_000_000) return `${(stock / 1_000_000).toFixed(1)}M in stock`;
  if (stock >= 1_000) return `${Math.round(stock / 1_000)}k in stock`;
  return `${stock} in stock`;
}

/** JLC's photo of a part; an empty tile when there is none or it does not load. */
function PartPhoto(props: { readonly src: string | undefined }) {
  const [failed, setFailed] = useState(false);
  const shown = props.src !== undefined && !failed;
  return (
    <div
      className={cn(
        "flex size-12 shrink-0 items-center justify-center overflow-hidden rounded border",
        shown ? "bg-white" : "bg-muted text-muted-foreground",
      )}
    >
      {shown ? (
        <img
          src={props.src}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="size-full object-contain"
          onError={() => setFailed(true)}
        />
      ) : (
        <ImageOffIcon className="size-4" />
      )}
    </div>
  );
}

interface SearchState {
  readonly busy: boolean;
  readonly parts?: ReadonlyArray<JlcPart>;
  readonly total?: number;
  readonly error?: string;
}

/** Finds parts in JLC's catalogue and places them on the schematic. */
export function PartSearch(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  /** The design's .kicad_pro. */
  readonly path: string;
  /** Puts an imported part on the sheet; resolves to whether it was placed. */
  readonly onPlace: (part: JlcImportedPart) => Promise<boolean>;
}) {
  const [query, setQuery] = useState("");
  const [basicOnly, setBasicOnly] = useState(false);
  const [search, setSearch] = useState<SearchState>({ busy: false });
  const [importing, setImporting] = useState<string | undefined>();
  const [added, setAdded] = useState<Readonly<Record<string, JlcImportedPart>>>({});
  const [importError, setImportError] = useState<string | undefined>();

  const runSearch = async (onlyBasic: boolean) => {
    if (query.trim() === "") return;
    setSearch((previous) => ({ ...previous, busy: true }));
    const result = await runAtomCommand(
      appAtomRegistry,
      hardwareJlcSearch,
      { environmentId: props.environmentId, input: { query, basicOnly: onlyBasic, limit: 20 } },
      options,
    );
    setSearch(
      result._tag === "Success"
        ? { busy: false, parts: result.value.parts, total: result.value.total }
        : { busy: false, error: formatEnvironmentQueryError(result.cause) },
    );
  };

  const add = async (part: JlcPart) => {
    setImporting(part.lcsc);
    setImportError(undefined);
    const result = await runAtomCommand(
      appAtomRegistry,
      hardwareJlcImport,
      {
        environmentId: props.environmentId,
        input: {
          threadId: props.threadId,
          projectId: props.projectId,
          path: props.path,
          lcsc: part.lcsc,
        },
      },
      options,
    );
    if (result._tag === "Success") {
      const imported = result.value;
      if (await props.onPlace(imported)) {
        setAdded((previous) => ({ ...previous, [part.lcsc]: imported }));
      }
    } else {
      setImportError(formatEnvironmentQueryError(result.cause));
    }
    setImporting(undefined);
  };

  return (
    <div className="absolute top-2 right-2 flex max-h-[80%] w-80 flex-col rounded-md border bg-background/95 text-xs shadow-md">
      <form
        className="flex flex-col gap-1.5 border-b p-2"
        onSubmit={(event) => {
          event.preventDefault();
          void runSearch(basicOnly);
        }}
      >
        <div className="flex gap-1.5">
          <Input
            size="compact"
            autoFocus
            aria-label="Search JLC parts"
            placeholder="10k 0603, AMS1117, C25804"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Button type="submit" size="xs" disabled={search.busy || query.trim() === ""}>
            {search.busy ? "Searching…" : "Search"}
          </Button>
        </div>
        <label className="flex items-center gap-1.5 text-muted-foreground">
          <input
            type="checkbox"
            checked={basicOnly}
            onChange={(event) => {
              setBasicOnly(event.target.checked);
              void runSearch(event.target.checked);
            }}
          />
          Basic parts only (no loading fee)
        </label>
      </form>
      <div className="min-h-0 overflow-y-auto p-1">
        {search.error ? <div className="p-1.5 text-destructive">{search.error}</div> : null}
        {importError ? <div className="p-1.5 text-destructive">{importError}</div> : null}
        {search.parts === undefined && !search.error ? (
          <div className="p-1.5 text-muted-foreground">
            Every part comes from JLC, so the board can be assembled as designed. Search by value
            and package, part number or LCSC number.
          </div>
        ) : null}
        {search.parts?.length === 0 ? (
          <div className="p-1.5 text-muted-foreground">JLC has no part matching that.</div>
        ) : null}
        {search.parts?.map((part) => {
          const badge = LIBRARY_BADGES[part.libraryType];
          const imported = added[part.lcsc];
          return (
            <div key={part.lcsc} className="flex gap-2 rounded px-1.5 py-1.5 hover:bg-accent">
              <PartPhoto key={part.image} src={part.image} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-medium">{part.mpn || part.lcsc}</span>
                  <Badge size="sm" variant={badge.variant}>
                    {badge.label}
                  </Badge>
                </div>
                <div className="break-words text-muted-foreground">
                  {[part.lcsc, part.package, part.manufacturer].filter(Boolean).join(" · ")}
                </div>
                {part.description ? <div className="break-words">{part.description}</div> : null}
                <div className="text-muted-foreground">
                  {formatStock(part.stock)}
                  {part.unitPrice !== undefined ? ` · $${part.unitPrice.toFixed(4)}` : ""}
                  {part.datasheet ? (
                    <>
                      {" · "}
                      <a
                        className="underline hover:text-foreground"
                        href={part.datasheet}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Datasheet
                      </a>
                    </>
                  ) : null}
                </div>
                {imported ? (
                  <div className="text-success-foreground">Placed on the sheet</div>
                ) : null}
              </div>
              <Button
                size="xs"
                variant="outline"
                disabled={importing !== undefined}
                onClick={() => void add(part)}
              >
                {importing === part.lcsc ? "Placing…" : imported ? "Place again" : "Place"}
              </Button>
            </div>
          );
        })}
        {search.parts && search.total !== undefined && search.total > search.parts.length ? (
          <div className="p-1.5 text-muted-foreground">
            Showing {search.parts.length} of {search.total}. Add words to narrow it down.
          </div>
        ) : null}
      </div>
    </div>
  );
}
