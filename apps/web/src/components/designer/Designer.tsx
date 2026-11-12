import type { KicadDesignSourceResult, ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import { finishingEdits } from "@t3tools/shared/kicad/boardFinish";
import { buildBoardScene } from "@t3tools/shared/kicad/boardScene";
import { displayNet, sameNet } from "@t3tools/shared/kicad/pick";
import { ratsnest } from "@t3tools/shared/kicad/ratsnest";
import { type Box, type Scene, type SceneItem, unionBoxes } from "@t3tools/shared/kicad/scene";
import { diffScenes, type SceneDiff } from "@t3tools/shared/kicad/sceneDiff";
import { buildSchematicScene } from "@t3tools/shared/kicad/schematicScene";
import {
  ArrowLeftRightIcon,
  ArrowRightToLineIcon,
  CheckIcon,
  ChevronRightIcon,
  LayersIcon,
  MessageSquareIcon,
  PackageSearchIcon,
  PaintBucketIcon,
  PencilIcon,
  PencilLineIcon,
  RatioIcon,
  RedoIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  Trash2Icon,
  FileArchiveIcon,
  UndoIcon,
  WaypointsIcon,
  ShieldCheckIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";

import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import {
  hardwareBoardAutoroute,
  hardwareBoardSync,
  hardwareDesigns,
  hardwareDesignSource,
  hardwareFabExport,
} from "../../state/hardware";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { BoardModelView } from "./BoardModelView";
import { boardSyncSummary } from "./boardSyncSummary.ts";
import { DesignCanvas } from "./DesignCanvas";
import { designMention, withMention, withRequest } from "./designMention.ts";
import { currentStep, type DesignStep, designSteps } from "./designSteps.ts";
import { PartSearch } from "./PartSearch";
import { ProblemList } from "./ProblemList";
import { boardProblems, countProblems, sheetProblems } from "./problems.ts";
import {
  DIFF_ADDED_COLOR,
  DIFF_REMOVED_COLOR,
  layerLabel,
  paletteFor,
  shownByDefault,
} from "./scenePaint.ts";
import { type Marker, scenePaints } from "./sceneRenderer.ts";
import { useDesignFocusStore } from "./designFollow.ts";
import { useDesignChecks, useDesignWatcher } from "./useDesignChecks.ts";
import { useSchematicEditor } from "./useSchematicEditor.ts";

const MODEL_TAB = "model";

interface Drawing {
  readonly key: string;
  readonly name: string;
  readonly file: string;
  readonly scene?: Scene;
  readonly error?: string;
  /** The agent's changes to this drawing that are waiting for the user. */
  readonly review?: Review;
}

interface Review {
  readonly diff: SceneDiff;
  readonly summary: ReadonlyArray<string>;
}

/** The agent's unreviewed changes to a sheet, or nothing if they cannot be drawn. */
function reviewOf(
  sheet: KicadDesignSourceResult["sheets"][number],
  scene: Scene,
): Review | undefined {
  if (!sheet.review) return undefined;
  try {
    const before = buildSchematicScene(sheet.review.baseline).scene;
    return { diff: diffScenes(before, scene), summary: sheet.review.summary };
  } catch {
    return undefined;
  }
}

/** What is selected, kept in terms that carry across the schematic and the board. */
interface Selection {
  readonly id: string;
  readonly from: Scene["kind"];
  readonly ref?: string;
  readonly net?: string;
}

function parseDrawings(source: KicadDesignSourceResult): ReadonlyArray<Drawing> {
  const read = (key: string, name: string, file: string, build: () => Scene): Drawing => {
    try {
      return { key, name, file, scene: build() };
    } catch (cause) {
      return { key, name, file, error: cause instanceof Error ? cause.message : String(cause) };
    }
  };
  return [
    ...source.sheets.map((sheet, index) => {
      const drawing = read(
        `sheet:${sheet.file}`,
        index === 0 ? "Schematic" : sheet.name,
        sheet.file,
        () => buildSchematicScene(sheet.source).scene,
      );
      const review = drawing.scene ? reviewOf(sheet, drawing.scene) : undefined;
      return review ? { ...drawing, review } : drawing;
    }),
    ...(source.board
      ? [read("board", "PCB", source.board.file, () => buildBoardScene(source.board?.source ?? ""))]
      : []),
  ];
}

const isPart = (item: SceneItem) => item.kind === "symbol" || item.kind === "footprint";

function onNet(item: SceneItem, scene: Scene, selection: Selection): boolean {
  const net = selection.net;
  if (!net) return true;
  const same = (other: string | undefined) =>
    other !== undefined &&
    (scene.kind === selection.from
      ? other === net
      : selection.from === "schematic"
        ? sameNet(net, other)
        : sameNet(other, net));
  return same(item.net) || (item.pins?.some((pin) => same(pin.net)) ?? false);
}

function selectedIn(scene: Scene, selection: Selection | undefined): ReadonlySet<string> {
  const ids = new Set<string>();
  if (!selection) return ids;
  for (const item of scene.items) {
    if (item.id === selection.id) ids.add(item.id);
    // A part is the same part in both drawings; a pad selects its symbol too.
    else if (selection.ref && isPart(item) && item.ref === selection.ref) ids.add(item.id);
  }
  return ids;
}

const KIND_LABEL: Readonly<Record<SceneItem["kind"], string>> = {
  symbol: "Part",
  footprint: "Part",
  pad: "Pad",
  wire: "Wire",
  junction: "Junction",
  label: "Label",
  "no-connect": "No connection",
  sheet: "Sheet",
  graphic: "Drawing",
  track: "Track",
  via: "Via",
  zone: "Copper zone",
};

/** A net's name as the user would type it; nets KiCad named by itself have none. */
const namedNet = (net: string | undefined) =>
  !net || net.startsWith("Net-(") || net.startsWith("unconnected-") ? "" : displayNet(net);

function Properties(props: {
  readonly item: SceneItem;
  readonly otherName: string | undefined;
  readonly onShowOther: () => void;
  readonly onPickNet: (net: string) => void;
  readonly onClose: () => void;
  /** Present when there is a part or net to bring up with the agent. */
  readonly onAsk?: (() => void) | undefined;
  /** Present when the item is a wire, label or mark that can be removed. */
  readonly onErase?: (() => void) | undefined;
  /** Present when the part can be changed here. */
  readonly edit?:
    | {
        readonly busy: boolean;
        readonly onRotate: () => void;
        readonly onDelete: () => void;
        readonly onValue: (value: string) => void;
        /** Puts a pin on a net; an empty name disconnects it, null marks it unused. */
        readonly onPinNet: (pin: string, net: string | null) => void;
      }
    | undefined;
}) {
  const { item } = props;
  const [editing, setEditing] = useState<{ item: string; pin: string } | undefined>();
  // The pin being edited belongs to one part; picking another part closes it.
  const editingPin = editing?.item === item.id ? editing.pin : undefined;
  const rows: Array<readonly [string, string]> = [
    ...(item.value && item.value !== item.title ? [["Value", item.value] as const] : []),
    ...(item.net ? [["Net", displayNet(item.net)] as const] : []),
    ...(item.layer && item.kind !== "footprint"
      ? [["Layer", layerLabel(item.layer)] as const]
      : []),
    ...(item.facts ?? []).filter(([, value]) => value !== ""),
  ];
  return (
    <div className="absolute bottom-2 left-2 flex max-h-[60%] w-64 flex-col rounded-md border bg-background/95 text-xs shadow-md">
      <div className="flex items-center gap-2 border-b px-2 py-1.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{item.title || KIND_LABEL[item.kind]}</div>
          <div className="text-muted-foreground">{KIND_LABEL[item.kind]}</div>
        </div>
        {props.otherName ? (
          <Button size="xs" variant="outline" onClick={props.onShowOther}>
            <ArrowLeftRightIcon />
            {props.otherName}
          </Button>
        ) : null}
        {props.onAsk ? (
          <Button size="xs" variant="outline" onClick={props.onAsk}>
            <MessageSquareIcon />
            Ask
          </Button>
        ) : null}
        {props.onErase ? (
          <Button size="icon-xs" variant="ghost" aria-label="Delete" onClick={props.onErase}>
            <Trash2Icon />
          </Button>
        ) : null}
        <Button size="icon-xs" variant="ghost" aria-label="Clear selection" onClick={props.onClose}>
          <XIcon />
        </Button>
      </div>
      {props.edit ? (
        <form
          key={`${item.id}:${item.value}`}
          className="flex items-center gap-1 border-b px-2 py-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            const value = new FormData(event.currentTarget).get("value");
            if (typeof value === "string" && value.trim() !== "" && value !== item.value) {
              props.edit?.onValue(value.trim());
            }
          }}
        >
          <Input
            size="compact"
            name="value"
            aria-label="Value"
            defaultValue={item.value ?? ""}
            disabled={props.edit.busy}
          />
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Rotate"
            disabled={props.edit.busy}
            onClick={props.edit.onRotate}
          >
            <RotateCcwIcon />
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Delete part"
            disabled={props.edit.busy}
            onClick={props.edit.onDelete}
          >
            <Trash2Icon />
          </Button>
        </form>
      ) : null}
      <div className="min-h-0 overflow-y-auto px-2 py-1.5">
        {rows.map(([name, value]) => (
          <div key={name} className="flex gap-2 py-0.5">
            <span className="w-20 shrink-0 text-muted-foreground">{name}</span>
            <span className="min-w-0 break-words">{value}</span>
          </div>
        ))}
        {item.pins && item.pins.length > 0 && !item.ref?.startsWith("#") ? (
          <div className="mt-1 border-t pt-1">
            <div className="mb-0.5 text-muted-foreground">Pins</div>
            {item.pins.map((pin) =>
              props.edit && editingPin === pin.number ? (
                <form
                  key={`${pin.number}:${pin.name}`}
                  className="flex items-center gap-1 py-0.5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const net = new FormData(event.currentTarget).get("net");
                    props.edit?.onPinNet(pin.number, typeof net === "string" ? net.trim() : "");
                    setEditing(undefined);
                  }}
                >
                  <span className="w-8 shrink-0 px-1 font-mono">{pin.number}</span>
                  <Input
                    size="compact"
                    name="net"
                    autoFocus
                    aria-label={`Net for pin ${pin.number}`}
                    placeholder="Net name, e.g. SDA"
                    defaultValue={namedNet(pin.net)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setEditing(undefined);
                    }}
                  />
                  <Button type="submit" size="xs" variant="outline">
                    Set
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      props.edit?.onPinNet(pin.number, null);
                      setEditing(undefined);
                    }}
                  >
                    Unused
                  </Button>
                </form>
              ) : (
                <div key={`${pin.number}:${pin.name}`} className="flex items-center">
                  <button
                    type="button"
                    disabled={!pin.net}
                    className="flex min-w-0 flex-1 gap-2 rounded px-1 py-0.5 text-left enabled:hover:bg-accent"
                    onClick={() => pin.net && props.onPickNet(pin.net)}
                  >
                    <span className="w-8 shrink-0 font-mono">{pin.number}</span>
                    <span className="w-16 shrink-0 truncate text-muted-foreground">
                      {pin.name === "~" ? "" : pin.name}
                    </span>
                    <span className="min-w-0 truncate">
                      {pin.net ? displayNet(pin.net) : "none"}
                    </span>
                  </button>
                  {props.edit ? (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Change the net of pin ${pin.number}`}
                      disabled={props.edit.busy}
                      onClick={() => setEditing({ item: item.id, pin: pin.number })}
                    >
                      <PencilIcon />
                    </Button>
                  ) : null}
                </div>
              ),
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The way from an idea to an ordered board, with the step the design is at marked. */
function StepBar(props: {
  readonly steps: ReadonlyArray<DesignStep>;
  readonly onOpen: (step: DesignStep) => void;
  /** Hands the step to the agent by writing the request into the chat box. */
  readonly onAsk: (step: DesignStep) => void;
}) {
  const current = currentStep(props.steps);
  return (
    <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b px-2 py-1 text-xs">
      {props.steps.map((step, index) => (
        <div key={step.id} className="flex shrink-0 items-center gap-0.5">
          {index > 0 ? <ChevronRightIcon className="size-3 text-muted-foreground" /> : null}
          <button
            type="button"
            className={cn(
              "flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent",
              step === current ? "bg-accent font-medium" : "text-muted-foreground",
            )}
            onClick={() => props.onOpen(step)}
          >
            {step.done ? <CheckIcon className="size-3 text-success-foreground" /> : null}
            {step.label}
            {step === current ? (
              <span className="font-normal text-muted-foreground">· {step.status}</span>
            ) : null}
          </button>
        </div>
      ))}
      <div className="min-w-2 flex-1" />
      {current?.prompt ? (
        <Button
          size="xs"
          variant="outline"
          className="shrink-0"
          onClick={() => props.onAsk(current)}
        >
          <SparklesIcon />
          Let Kitty do this
        </Button>
      ) : current ? (
        <span className="shrink-0 text-muted-foreground">
          Kitty cannot do {current.label.toLowerCase()} yet. Use KiCad for this step.
        </span>
      ) : null}
    </div>
  );
}

const inside = (box: Box, outline: Box) =>
  box.minX >= outline.minX &&
  box.minY >= outline.minY &&
  box.maxX <= outline.maxX &&
  box.maxY <= outline.maxY;

/** The radius of the outline's rounded corners, read off its first quarter circle. */
function cornerRadius(scene: Scene): number {
  for (const item of scene.items) {
    if (item.layer !== "Edge.Cuts") continue;
    for (const shape of item.shapes) {
      if (shape.kind !== "arc") continue;
      const chord = Math.hypot(shape.end.x - shape.start.x, shape.end.y - shape.start.y);
      return Math.round((chord / Math.SQRT2) * 10) / 10;
    }
  }
  return 0;
}

/** Sets the board to a rectangle of a given size. */
function BoardSize(props: {
  readonly outline: Box | undefined;
  readonly busy: boolean;
  /** The corner radius the outline has now; 0 for square corners. */
  readonly radius: number;
  readonly onSet: (width: number, height: number, radius: number) => void;
}) {
  const { outline } = props;
  const size = (value: number | undefined) =>
    value === undefined ? "" : String(Math.round(value));
  return (
    <form
      className="absolute top-2 right-2 flex w-56 flex-col gap-1.5 rounded-md border bg-background/95 p-2 text-xs shadow-md"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const width = Number(data.get("width"));
        const height = Number(data.get("height"));
        const radius = Math.max(0, Number(data.get("radius")) || 0);
        if (width > 0 && height > 0) props.onSet(width, height, radius);
      }}
    >
      <div className="font-medium">Board size in mm</div>
      <div className="flex items-center gap-1.5">
        <Input
          size="compact"
          name="width"
          type="number"
          min={1}
          step="any"
          aria-label="Width"
          placeholder="Width"
          defaultValue={size(outline ? outline.maxX - outline.minX : undefined)}
        />
        <span className="text-muted-foreground">×</span>
        <Input
          size="compact"
          name="height"
          type="number"
          min={1}
          step="any"
          aria-label="Height"
          placeholder="Height"
          defaultValue={size(outline ? outline.maxY - outline.minY : undefined)}
        />
      </div>
      <div className="flex items-center gap-1.5">
        <span className="shrink-0 text-muted-foreground">Corner radius</span>
        <Input
          size="compact"
          name="radius"
          type="number"
          min={0}
          step="any"
          aria-label="Corner radius"
          placeholder="0"
          defaultValue={props.radius > 0 ? String(props.radius) : ""}
        />
        <Button type="submit" size="xs" disabled={props.busy}>
          Set
        </Button>
      </div>
      <div className="text-muted-foreground">
        A rectangle; it replaces the outline the board has now.
      </div>
    </form>
  );
}

const REVIEW_LINES = 5;

/** The agent's changes, marked on the drawing, for the user to keep or take back. */
function ReviewBar(props: {
  readonly review: Review;
  readonly busy: boolean;
  readonly onShow: () => void;
  readonly onKeep: () => void;
  readonly onRevert: () => void;
}) {
  const { summary, diff } = props.review;
  const more = summary.length - REVIEW_LINES;
  return (
    <div className="absolute top-2 left-2 flex max-h-[50%] w-72 flex-col rounded-md border bg-background/95 text-xs shadow-md">
      <div className="flex items-center gap-2 border-b px-2 py-1.5">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">Kitty changed the schematic</div>
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <span
              className="size-2 shrink-0 rounded-sm"
              style={{ backgroundColor: DIFF_ADDED_COLOR }}
            />
            {diff.added.size} added or changed
            <span
              className="size-2 shrink-0 rounded-sm"
              style={{ backgroundColor: DIFF_REMOVED_COLOR }}
            />
            {diff.removed.length} removed
          </div>
        </div>
        {diff.box ? (
          <Button size="xs" variant="ghost" onClick={props.onShow}>
            Show
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 overflow-y-auto px-2 py-1.5">
        {summary.slice(0, REVIEW_LINES).map((line, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- the lines are a fixed list and may repeat
          <div key={index} className="break-words py-0.5">
            {line}
          </div>
        ))}
        {more > 0 ? <div className="py-0.5 text-muted-foreground">and {more} more</div> : null}
      </div>
      <div className="flex items-center gap-1.5 border-t px-2 py-1.5">
        <Button size="xs" disabled={props.busy} onClick={props.onKeep}>
          Keep
        </Button>
        <Button size="xs" variant="outline" disabled={props.busy} onClick={props.onRevert}>
          Revert
        </Button>
        <span className="min-w-0 text-muted-foreground">Editing the sheet keeps them too.</span>
      </div>
    </div>
  );
}

function LayerList(props: {
  readonly scene: Scene;
  readonly hidden: ReadonlySet<string>;
  readonly onToggle: (paint: string) => void;
}) {
  const color = paletteFor(props.scene, true);
  // Top of the stack first, the way the layer list reads in KiCad.
  const paints = scenePaints(props.scene).toReversed();
  return (
    <div className="absolute top-2 right-2 max-h-[70%] w-48 overflow-y-auto rounded-md border bg-background/95 p-1 text-xs shadow-md">
      {paints.map((paint) => (
        <label
          key={paint}
          className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-accent"
        >
          <input
            type="checkbox"
            className="size-3"
            checked={!props.hidden.has(paint)}
            onChange={() => props.onToggle(paint)}
          />
          <span
            className="size-2.5 shrink-0 rounded-sm"
            style={{ backgroundColor: color(paint) }}
          />
          <span className="truncate">{layerLabel(paint)}</span>
        </label>
      ))}
    </div>
  );
}

/** The board designer: schematic sheets and the board as live, clickable drawings. */
export function Designer(props: {
  readonly threadRef: ScopedThreadRef;
  /** Null outside a project, where there is no design to open. */
  readonly projectId: ProjectId | null;
}) {
  if (props.projectId === null) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Open a hardware project to design its board.
      </div>
    );
  }
  return <DesignerView threadRef={props.threadRef} projectId={props.projectId} />;
}

function DesignerView(props: {
  readonly threadRef: ScopedThreadRef;
  readonly projectId: ProjectId;
}) {
  const { environmentId, threadId } = props.threadRef;
  const { resolvedTheme } = useTheme();
  const target = { threadId, projectId: props.projectId };
  const designs = useEnvironmentQuery(hardwareDesigns({ environmentId, input: target }));
  const list = designs.data?.designs ?? [];
  const [chosen, setChosen] = useState<string | null>(null);
  const project = list.find((design) => design.project === chosen)?.project ?? list[0]?.project;
  const [tab, setTab] = useState<string | null>(null);
  const followed = useDesignFocusStore((state) =>
    state.focus?.threadId === threadId ? state.focus.call : undefined,
  );
  // Each new tool call of the agent turns the designer to the page it changes.
  const [turnedFor, setTurnedFor] = useState<string | undefined>();
  if (followed && followed.id !== turnedFor) {
    setTurnedFor(followed.id);
    setTab(followed.page === "board" ? "board" : null);
  }
  const [selection, setSelection] = useState<Selection | undefined>();
  const [reveal, setReveal] = useState<SceneItem | undefined>();
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const [showLayers, setShowLayers] = useState(false);
  const [showProblems, setShowProblems] = useState(false);
  const [showParts, setShowParts] = useState(false);
  const [wiring, setWiring] = useState(false);
  const [routeLayer, setRouteLayer] = useState<"F.Cu" | "B.Cu">("F.Cu");
  const [showSize, setShowSize] = useState(false);
  const [activeProblem, setActiveProblem] = useState<string | undefined>();
  const [sync, setSync] = useState<{
    busy: boolean;
    note?: string;
    failed?: boolean;
    routing?: boolean;
  }>({
    busy: false,
  });

  const loaded = useEnvironmentQuery(
    project ? hardwareDesignSource({ environmentId, input: { ...target, path: project } }) : null,
  );
  const source = loaded.data ?? undefined;
  const drawings = source ? parseDrawings(source) : [];
  const current = drawings.find((drawing) => drawing.key === tab) ?? drawings[0];
  // The 3D view is a tab of its own, available once the design has a board.
  const showModel = tab === MODEL_TAB && source?.board !== undefined && project !== undefined;
  const scene = current?.scene;
  const hidden = (() => {
    const result = new Set<string>();
    if (!scene) return result;
    for (const paint of scenePaints(scene)) {
      // A toggle flips a layer away from its default visibility.
      if (shownByDefault(scene, paint) === toggled.has(`${scene.kind}:${paint}`)) result.add(paint);
    }
    return result;
  })();
  const selectedIds = scene ? selectedIn(scene, selection) : new Set<string>();
  const focus =
    scene && selection?.net ? (item: SceneItem) => onNet(item, scene, selection) : undefined;
  const selectedItem =
    scene?.items.find((item) => selectedIds.has(item.id) && item.id === selection?.id) ??
    scene?.items.find((item) => selectedIds.has(item.id));

  // The same part or net in a drawing of the other kind, for "show in PCB / schematic".
  const other = (() => {
    if (!scene || !selection) return undefined;
    for (const drawing of drawings) {
      if (!drawing.scene || drawing.scene.kind === scene.kind) continue;
      const candidate = drawing.scene;
      const match =
        candidate.items.find(
          (item) => selection.ref !== undefined && isPart(item) && item.ref === selection.ref,
        ) ??
        (selection.net
          ? candidate.items.find(
              (item) =>
                item.kind !== "zone" && item.net !== undefined && onNet(item, candidate, selection),
            )
          : undefined);
      if (match) return { drawing, item: match };
    }
    return undefined;
  })();

  const { checks, run: runChecks } = useDesignChecks(
    { environmentId, threadId, projectId: props.projectId, path: project },
    (source?.sheets.length ?? 0) > 0,
    source?.board !== undefined,
  );
  const checked = checks.erc !== undefined || checks.drc !== undefined;
  // A save from KiCad or the agent redraws the design, and re-checks it if checks are on.
  useDesignWatcher({ environmentId, threadId, projectId: props.projectId, path: project }, () => {
    loaded.refresh();
    if (checked) void runChecks();
  });
  const problems = !current
    ? []
    : scene?.kind === "board"
      ? boardProblems(checks.drc)
      : sheetProblems(checks.erc, current.name, current === drawings[0]);
  const markers = showProblems
    ? problems.flatMap((problem): ReadonlyArray<Marker> =>
        problem.x === undefined || problem.y === undefined
          ? []
          : [
              {
                x: problem.x,
                y: problem.y,
                severity: problem.severity,
                active: problem.key === activeProblem,
              },
            ],
      )
    : undefined;
  const counts = countProblems(problems);

  // Only the root sheet is edited here; parts are real parts, not power symbols.
  const editable = scene?.kind === "schematic" && current === drawings[0] && !showModel;
  const editor = useSchematicEditor(
    { environmentId, threadId, projectId: props.projectId, path: project },
    () => {
      loaded.refresh();
      if (checked) void runChecks();
    },
  );
  // On the board, parts are moved, turned and flipped, and tracks are drawn and removed.
  const boardEditable = scene?.kind === "board" && !showModel;
  const outline = boardEditable
    ? unionBoxes(scene.items.filter((item) => item.layer === "Edge.Cuts").map((item) => item.box))
    : undefined;
  // The connections left to route, known whichever drawing is showing.
  const boardScene = drawings.find((drawing) => drawing.scene?.kind === "board")?.scene;
  const boardWires = boardScene ? ratsnest(boardScene) : [];
  const airwires = boardEditable ? boardWires : undefined;
  const selectedFootprint =
    boardEditable && selection?.ref
      ? scene.items.find((item) => item.kind === "footprint" && item.ref === selection.ref)
      : undefined;
  const isEditablePart = (item: SceneItem) =>
    editable && item.kind === "symbol" && item.ref !== undefined && !item.ref.startsWith("#");
  const selectedPart = selectedItem && isEditablePart(selectedItem) ? selectedItem : undefined;
  // Wires, labels and marks are removed by their KiCad id; ids made up here are not real.
  const erasable =
    editable &&
    selectedItem &&
    ["wire", "label", "junction", "no-connect"].includes(selectedItem.kind) &&
    /^[0-9a-f-]{36}$/i.test(selectedItem.id)
      ? selectedItem
      : undefined;
  const copper =
    boardEditable &&
    selectedItem &&
    (selectedItem.kind === "track" || selectedItem.kind === "via") &&
    /^[0-9a-f-]{36}$/i.test(selectedItem.id)
      ? selectedItem
      : undefined;
  const removeSelected = () => {
    if (copper) {
      setSelection(undefined);
      void editor.applyBoard([{ op: "unroute", ids: [copper.id] }]);
    } else if (selectedPart?.ref) {
      setSelection(undefined);
      void editor.apply([{ op: "remove", reference: selectedPart.ref }]);
    } else if (erasable) {
      setSelection(undefined);
      void editor.apply([{ op: "erase", id: erasable.id }]);
    }
  };
  /** Draws a track on the side being routed; with a via at its end, routing moves to the other side. */
  const route = async (points: ReadonlyArray<{ x: number; y: number }>, via: boolean) => {
    const end = points.at(-1);
    const done = await editor.applyBoard([
      { op: "track", layer: routeLayer, points: [...points] },
      ...(via && end ? [{ op: "via" as const, at: end }] : []),
    ]);
    if (done && via) setRouteLayer(routeLayer === "F.Cu" ? "B.Cu" : "F.Cu");
  };
  const rotateSelected = () => {
    if (selectedFootprint?.ref) {
      void editor.applyBoard([{ op: "move", reference: selectedFootprint.ref, rotateBy: 90 }]);
    }
    if (!selectedPart?.ref) return;
    void editor.apply([{ op: "move", reference: selectedPart.ref, rotateBy: 90 }]);
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.target instanceof HTMLInputElement) return;
    const command = event.metaKey || event.ctrlKey;
    if (boardEditable) {
      if (command && event.key.toLowerCase() === "z") {
        event.preventDefault();
        void editor.step(event.shiftKey ? "redo" : "undo", true);
      } else if (!command && event.key.toLowerCase() === "r") {
        event.preventDefault();
        rotateSelected();
      } else if (!command && event.key.toLowerCase() === "f" && selectedFootprint?.ref) {
        event.preventDefault();
        const side = selectedFootprint.layer?.startsWith("B.") ? "front" : "back";
        void editor.applyBoard([{ op: "move", reference: selectedFootprint.ref, side }]);
      } else if (!command && (event.key === "Delete" || event.key === "Backspace")) {
        event.preventDefault();
        removeSelected();
      } else if (!command && event.key.toLowerCase() === "w") {
        event.preventDefault();
        setWiring((on) => !on);
      } else if (event.key === "Escape") {
        setWiring(false);
      }
      return;
    }
    if (!editable) return;
    if (command && event.key.toLowerCase() === "z") {
      event.preventDefault();
      void editor.step(event.shiftKey ? "redo" : "undo");
    } else if (!command && (event.key === "Delete" || event.key === "Backspace")) {
      event.preventDefault();
      removeSelected();
    } else if (!command && event.key.toLowerCase() === "r") {
      event.preventDefault();
      rotateSelected();
    } else if (!command && event.key.toLowerCase() === "w") {
      event.preventDefault();
      setWiring((on) => !on);
    } else if (event.key === "Escape") {
      setWiring(false);
    }
  };

  // Puts the picked part or net into the chat box, for the user to finish the question.
  const mention =
    selectedItem && current
      ? designMention({
          ref: selection?.ref,
          value: selection?.ref ? selectedItem.value : undefined,
          net: selection?.net,
          file: current.file,
        })
      : undefined;
  const askAbout = () => {
    if (!mention) return;
    const store = useComposerDraftStore.getState();
    const prompt = store.getComposerDraft(props.threadRef)?.prompt ?? "";
    store.setPrompt(props.threadRef, withMention(prompt, mention));
  };

  const count = (kind: Scene["kind"], test: (item: SceneItem) => boolean) =>
    drawings
      .filter((drawing) => drawing.scene?.kind === kind)
      .reduce((total, drawing) => total + (drawing.scene?.items.filter(test).length ?? 0), 0);
  const steps = designSteps(
    {
      parts: count("schematic", (item) => item.kind === "symbol" && !item.ref?.startsWith("#")),
      footprints: count("board", (item) => item.kind === "footprint"),
      inside: (() => {
        const board = drawings.find((drawing) => drawing.scene?.kind === "board")?.scene;
        const edge = unionBoxes(
          (board?.items ?? []).filter((item) => item.layer === "Edge.Cuts").map((item) => item.box),
        );
        return edge
          ? board?.items.filter((item) => item.kind === "footprint" && inside(item.box, edge))
              .length
          : undefined;
      })(),
      tracks: count("board", (item) => item.kind === "track"),
      unrouted: checks.drc?.unconnected.length ?? boardWires.length,
      errors: checked
        ? (checks.erc?.summary.errors ?? 0) + (checks.drc?.summary.errors ?? 0)
        : undefined,
    },
    project ?? "this design",
  );
  const openStep = (step: DesignStep) => {
    const kind = step.id === "schematic" ? "schematic" : "board";
    if (step.id === "checks") {
      if (!checked) void runChecks();
      setShowProblems(true);
      setShowLayers(false);
      setShowParts(false);
    } else if (step.id === "schematic" || step.id === "placement" || step.id === "routing") {
      const drawing = drawings.find((candidate) => candidate.scene?.kind === kind);
      if (drawing) setTab(drawing.key);
    }
  };
  const askStep = (step: DesignStep) => {
    if (!step.prompt) return;
    const store = useComposerDraftStore.getState();
    const prompt = store.getComposerDraft(props.threadRef)?.prompt ?? "";
    store.setPrompt(props.threadRef, withRequest(prompt, step.prompt));
  };

  /** Brings the schematic's parts and nets onto the board. */
  const syncBoard = async () => {
    if (!project || sync.busy) return;
    setSync({ busy: true });
    const result = await runAtomCommand(
      appAtomRegistry,
      hardwareBoardSync,
      { environmentId, input: { ...target, path: project } },
      { reportFailure: false },
    );
    if (result._tag === "Success") {
      setSync({ busy: false, note: boardSyncSummary(result.value) });
      loaded.refresh();
      if (checked) void runChecks();
    } else {
      setSync({ busy: false, note: formatEnvironmentQueryError(result.cause), failed: true });
    }
  };

  /** Lets the auto-router draw every track it can. */
  const autoroute = async () => {
    if (!project || sync.busy) return;
    setSync({ busy: true, routing: true, note: "Routing the board. This can take a minute…" });
    const result = await runAtomCommand(
      appAtomRegistry,
      hardwareBoardAutoroute,
      { environmentId, input: { ...target, path: project } },
      { reportFailure: false },
    );
    if (result._tag === "Success") {
      const { narrow, summary } = result.value;
      const thin = narrow > 0 ? ` ${narrow} tracks are thinner than the board allows.` : "";
      setSync({ busy: false, note: `${summary.join(" ")}.${thin}` });
      loaded.refresh();
      if (checked) void runChecks();
    } else {
      setSync({ busy: false, note: formatEnvironmentQueryError(result.cause), failed: true });
    }
  };

  /** Writes the files JLC needs; held back while the board has errors or missing tracks. */
  const exportOrder = async () => {
    if (!project || sync.busy) return;
    setSync({ busy: true, note: "Checking the board and writing the order files…" });
    const result = await runAtomCommand(
      appAtomRegistry,
      hardwareFabExport,
      { environmentId, input: { ...target, path: project } },
      { reportFailure: false },
    );
    if (result._tag === "Success") {
      const { zip, bom, cpl, unsourced, outputDir } = result.value;
      const files = [zip, bom, cpl].filter((file) => file !== undefined).length;
      const missing =
        unsourced.length > 0 ? ` No LCSC number yet: ${unsourced.slice(0, 8).join(", ")}.` : "";
      setSync({ busy: false, note: `Wrote ${files} files for JLC to ${outputDir}.${missing}` });
    } else {
      setSync({ busy: false, note: formatEnvironmentQueryError(result.cause), failed: true });
    }
  };

  const pick = (item: SceneItem | undefined) => {
    setReveal(undefined);
    if (!item || !scene) return setSelection(undefined);
    setSelection({
      id: item.id,
      from: scene.kind,
      ...(item.ref && !item.ref.startsWith("#") ? { ref: item.ref } : {}),
      ...(item.net ? { net: item.net } : {}),
    });
  };

  if (list.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {designs.error
          ? designs.error
          : designs.isPending
            ? "Looking for KiCad designs…"
            : "This project has no KiCad design yet. Create one from the Hardware panel, or ask Kitty to start a board."}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <StepBar steps={steps} onOpen={openStep} onAsk={askStep} />
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
        {drawings.map((drawing) => (
          <Button
            key={drawing.key}
            size="xs"
            variant={drawing === current && !showModel ? "outline" : "ghost-muted"}
            onClick={() => {
              setTab(drawing.key);
              setReveal(undefined);
            }}
          >
            {drawing.name}
          </Button>
        ))}
        {source?.board ? (
          <Button
            size="xs"
            variant={showModel ? "outline" : "ghost-muted"}
            onClick={() => setTab(MODEL_TAB)}
          >
            3D
          </Button>
        ) : null}
        <div className="flex-1" />
        {list.length > 1 ? (
          <select
            aria-label="Design"
            className="h-6 rounded-md border bg-background px-1 text-xs"
            value={project}
            onChange={(event) => {
              setChosen(event.target.value);
              setSelection(undefined);
              setTab(null);
            }}
          >
            {list.map((design) => (
              <option key={design.project} value={design.project}>
                {design.name}
              </option>
            ))}
          </select>
        ) : null}
        {scene && !showModel ? (
          <Button
            size="xs"
            variant={showProblems ? "outline" : "ghost-muted"}
            disabled={checks.running}
            onClick={() => {
              // The first click runs the checks; later clicks show or hide the results.
              if (!checked) void runChecks();
              setShowProblems(!showProblems || !checked);
              setShowLayers(false);
              setShowParts(false);
            }}
          >
            <ShieldCheckIcon className={cn(checks.running && "animate-pulse")} />
            {checks.running
              ? "Checking…"
              : !checked
                ? "Check"
                : counts.errors + counts.warnings === 0
                  ? "No problems"
                  : `${counts.errors} errors · ${counts.warnings} warnings`}
          </Button>
        ) : null}
        {editable || boardEditable ? (
          <>
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label="Undo"
              disabled={editor.busy}
              onClick={() => void editor.step("undo", boardEditable)}
            >
              <UndoIcon />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label="Redo"
              disabled={editor.busy}
              onClick={() => void editor.step("redo", boardEditable)}
            >
              <RedoIcon />
            </Button>
          </>
        ) : null}
        {editable || boardEditable ? (
          <Button
            size="xs"
            variant={wiring ? "outline" : "ghost-muted"}
            onClick={() => setWiring((on) => !on)}
          >
            <PencilLineIcon />
            {boardEditable ? "Route" : "Wire"}
          </Button>
        ) : null}
        {boardEditable && boardWires.length > 0 ? (
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={sync.busy || editor.busy}
            onClick={() => void autoroute()}
          >
            <WaypointsIcon className={cn(sync.routing && "animate-pulse")} />
            Auto-route
          </Button>
        ) : null}
        {boardEditable && scene.items.some((item) => item.kind === "footprint") ? (
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={sync.busy || editor.busy}
            onClick={() => void editor.applyBoard([...finishingEdits(scene)])}
          >
            <PaintBucketIcon />
            Pour & tidy
          </Button>
        ) : null}
        {boardEditable && boardWires.length === 0 && scene.items.length > 0 ? (
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={sync.busy || editor.busy}
            onClick={() => void exportOrder()}
          >
            <FileArchiveIcon />
            Order files
          </Button>
        ) : null}
        {boardEditable && wiring ? (
          <Button
            size="xs"
            variant="ghost-muted"
            onClick={() => setRouteLayer((layer) => (layer === "F.Cu" ? "B.Cu" : "F.Cu"))}
          >
            {routeLayer === "F.Cu" ? "Front copper" : "Back copper"}
          </Button>
        ) : null}
        {editable && project ? (
          <Button
            size="xs"
            variant={showParts ? "outline" : "ghost-muted"}
            onClick={() => {
              setShowParts((shown) => !shown);
              setShowProblems(false);
            }}
          >
            <PackageSearchIcon />
            Parts
          </Button>
        ) : null}
        {scene?.kind === "board" && !showModel && (source?.sheets.length ?? 0) > 0 ? (
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={sync.busy}
            onClick={() => void syncBoard()}
          >
            <ArrowRightToLineIcon className={cn(sync.busy && !sync.routing && "animate-pulse")} />
            {sync.busy && !sync.routing ? "Updating…" : "Update from schematic"}
          </Button>
        ) : null}
        {boardEditable ? (
          <Button
            size="xs"
            variant={showSize ? "outline" : "ghost-muted"}
            onClick={() => {
              setShowSize((shown) => !shown);
              setShowLayers(false);
              setShowProblems(false);
            }}
          >
            <RatioIcon />
            Board size
          </Button>
        ) : null}
        {scene?.kind === "board" && !showModel ? (
          <Button
            size="xs"
            variant={showLayers ? "outline" : "ghost-muted"}
            onClick={() => {
              setShowSize(false);
              setShowLayers((shown) => !shown);
              setShowProblems(false);
              setShowParts(false);
            }}
          >
            <LayersIcon />
            Layers
          </Button>
        ) : null}
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Reload design"
          disabled={loaded.isPending || !project}
          onClick={() => loaded.refresh()}
        >
          <RefreshCwIcon className={cn(loaded.isPending && "animate-spin")} />
        </Button>
      </div>
      <div
        className="relative min-h-0 flex-1 outline-none"
        // Focusable so R, Delete and undo reach the drawing after a click on it.
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onPointerDown={(event) => {
          if (event.target instanceof HTMLCanvasElement) event.currentTarget.focus();
        }}
      >
        {showModel ? (
          <BoardModelView
            className="absolute inset-0"
            threadRef={props.threadRef}
            projectId={props.projectId}
            path={project}
          />
        ) : scene ? (
          <>
            <DesignCanvas
              className="absolute inset-0"
              scene={scene}
              dark={resolvedTheme === "dark"}
              hidden={hidden}
              selectedIds={selectedIds}
              focus={focus}
              reveal={reveal}
              markers={markers}
              diff={current?.review?.diff}
              airwires={airwires}
              airwireNet={scene.kind === selection?.from ? selection.net : undefined}
              onPick={pick}
              onWire={
                editable && wiring
                  ? (points) => void editor.apply([{ op: "wire", points: [...points] }])
                  : boardEditable && wiring
                    ? (points, end) => void route(points, end.via)
                    : undefined
              }
              movable={
                editable
                  ? isEditablePart
                  : boardEditable && !wiring
                    ? (item) => item.kind === "footprint" && item.ref !== undefined
                    : undefined
              }
              moveGrid={boardEditable ? 0.5 : undefined}
              onMove={(item, by) => {
                if (!item.ref) return;
                if (boardEditable) {
                  void editor.applyBoard([{ op: "move", reference: item.ref, by }]);
                } else void editor.apply([{ op: "move", reference: item.ref, by }]);
              }}
            />
            {scene.items.length === 0 ? (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                {scene.kind === "board" ? "The board is empty." : "This sheet is empty."} Ask Kitty
                to design it, or draw it in KiCad.
              </div>
            ) : null}
            {current?.review ? (
              <ReviewBar
                review={current.review}
                busy={editor.busy}
                onShow={() => {
                  const box = current.review?.diff.box;
                  if (box) setReveal({ id: "review", kind: "graphic", shapes: [], box });
                }}
                onKeep={() => void editor.review("keep")}
                onRevert={() => {
                  setSelection(undefined);
                  void editor.review("revert");
                }}
              />
            ) : null}
            {showSize && boardEditable ? (
              <BoardSize
                outline={outline}
                radius={cornerRadius(scene)}
                busy={editor.busy}
                onSet={(width, height, radius) => {
                  // A board with no outline yet gets one around where its parts start.
                  const x = outline?.minX ?? 100;
                  const y = outline?.minY ?? 80;
                  void editor.applyBoard([
                    { op: "outline", x, y, width, height, ...(radius > 0 ? { radius } : {}) },
                  ]);
                  setShowSize(false);
                }}
              />
            ) : null}
            {showLayers && scene.kind === "board" ? (
              <LayerList
                scene={scene}
                hidden={hidden}
                onToggle={(paint) =>
                  setToggled((previous) => {
                    const next = new Set(previous);
                    const key = `${scene.kind}:${paint}`;
                    if (!next.delete(key)) next.add(key);
                    return next;
                  })
                }
              />
            ) : null}
            {showParts && editable && project ? (
              <PartSearch
                environmentId={environmentId}
                threadId={threadId}
                projectId={props.projectId}
                path={project}
                onPlace={async (part) => {
                  const result = await editor.apply([{ op: "place", symbol: part.symbol }]);
                  return result !== undefined;
                }}
              />
            ) : null}
            {showProblems && checked ? (
              <ProblemList
                problems={problems}
                activeKey={activeProblem}
                truncated={
                  (scene.kind === "board" ? checks.drc?.truncated : checks.erc?.truncated) ?? false
                }
                onPick={(problem) => {
                  setActiveProblem(problem.key);
                  if (problem.x === undefined || problem.y === undefined) return;
                  // A small box around the spot is enough for the canvas to centre on it.
                  setReveal({
                    id: problem.key,
                    kind: "graphic",
                    shapes: [],
                    box: {
                      minX: problem.x - 4,
                      minY: problem.y - 4,
                      maxX: problem.x + 4,
                      maxY: problem.y + 4,
                    },
                  });
                }}
              />
            ) : null}
            {selectedItem ? (
              <Properties
                item={selectedItem}
                otherName={other?.drawing.name}
                onShowOther={() => {
                  if (!other) return;
                  setTab(other.drawing.key);
                  setReveal(other.item);
                }}
                onPickNet={(net) => selection && setSelection({ ...selection, net })}
                onClose={() => setSelection(undefined)}
                onAsk={mention ? askAbout : undefined}
                onErase={erasable ? removeSelected : undefined}
                edit={
                  selectedPart?.ref
                    ? {
                        busy: editor.busy,
                        onRotate: rotateSelected,
                        onDelete: removeSelected,
                        onPinNet: (pin, net) =>
                          void editor.apply([
                            {
                              op: "connect",
                              reference: selectedPart.ref ?? "",
                              ...(net === null ? { noConnect: [pin] } : { nets: { [pin]: net } }),
                            },
                          ]),
                        onValue: (value) =>
                          void editor.apply([
                            {
                              op: "set",
                              reference: selectedPart.ref ?? "",
                              property: "Value",
                              value,
                            },
                          ]),
                      }
                    : undefined
                }
              />
            ) : null}
          </>
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
            {loaded.error
              ? loaded.error
              : current?.error
                ? `Could not read ${current.file}: ${current.error}`
                : "Loading design…"}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-3 border-t px-2 py-1 text-xs text-muted-foreground">
        <span className="truncate font-mono">{current?.file}</span>
        {scene ? (
          <span className="shrink-0">
            {scene.items.filter(isPart).length} parts
            {scene.kind === "board" && boardWires.length > 0
              ? ` · ${boardWires.length} to route`
              : ""}
            {selection?.net ? ` · net ${displayNet(selection.net)}` : ""}
          </span>
        ) : null}
        {checks.error ? (
          <span className="truncate text-destructive-foreground">{checks.error}</span>
        ) : null}
        {editor.busy ? <span className="shrink-0">Saving…</span> : null}
        {sync.note && scene?.kind === "board" ? (
          <span className={cn("truncate", sync.failed && "text-destructive-foreground")}>
            {sync.note}
          </span>
        ) : null}
        {boardEditable && !sync.note && !wiring ? (
          <span className="shrink-0">
            Drag a part to move it. R turns it, F flips it to the other side.
          </span>
        ) : null}
        {boardEditable && wiring ? (
          <span className="shrink-0">
            Click a pad to start a track, click to add corners, click a pad to finish. V drops a via
            and changes side. Esc to stop.
          </span>
        ) : null}
        {editable && wiring ? (
          <span className="shrink-0">
            Click a pin to start a wire, click to add corners, click a pin to finish. Esc to stop.
          </span>
        ) : null}
        {editor.message ? (
          <span className="truncate text-destructive-foreground">{editor.message}</span>
        ) : null}
        {source && source.omitted > 0 ? (
          <span className="shrink-0">{source.omitted} file(s) too large to show</span>
        ) : null}
      </div>
    </div>
  );
}
