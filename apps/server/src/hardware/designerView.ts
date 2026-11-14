import type { DesignerView } from "@t3tools/contracts";

/** A view older than this says nothing about what the user sees now. */
const VIEW_LIFETIME_MS = 30 * 60 * 1000;
const PROBLEMS_SHOWN = 8;

// Kept per thread for the server's lifetime: the designer reports it, the next turn reads it.
const views = new Map<string, { readonly view: DesignerView; readonly at: number }>();

export function rememberDesignerView(threadId: string, view: DesignerView | null, at: number) {
  if (view === null) views.delete(threadId);
  else views.set(threadId, { view, at });
}

/** What the user's designer shows, as a note for the agent; none when it is closed or stale. */
export function designerViewNote(threadId: string, now: number): string | undefined {
  const entry = views.get(threadId);
  if (!entry || now - entry.at > VIEW_LIFETIME_MS) return undefined;
  return describeDesignerView(entry.view);
}

const DRAWINGS = { schematic: "the schematic", board: "the board", model: "the 3D view" } as const;

export function describeDesignerView(view: DesignerView): string {
  const lines = [
    `The user has Kitty's designer open on ${DRAWINGS[view.drawing]} of ${view.project}${view.file ? ` (${view.file})` : ""}.`,
  ];
  const { ref, value, net } = view.selection ?? {};
  const picked = [
    ref ? `${ref}${value ? ` (${value})` : ""}` : undefined,
    net ? `net ${net}` : undefined,
  ].filter(Boolean);
  lines.push(
    picked.length > 0
      ? `Selected: ${picked.join(", ")}. "This" or "here" in their message means it.`
      : "Nothing is selected.",
  );
  if (view.steps.length > 0) lines.push(`Steps: ${view.steps.join("; ")}.`);
  if (view.problemCount > 0) {
    const shown = view.problems.slice(0, PROBLEMS_SHOWN);
    const rest = view.problemCount - shown.length;
    lines.push(
      `Problems listed (${view.problemCount}):`,
      ...shown.map((problem) => `- ${problem}`),
      ...(rest > 0 ? [`- and ${rest} more`] : []),
    );
  } else {
    lines.push("The checks list no problems.");
  }
  return `<designer_view>\n${lines.join("\n")}\n</designer_view>`;
}
