/** The path from an idea to an ordered board, and how far a design is along it. */
export type StepId = "requirements" | "schematic" | "placement" | "routing" | "checks" | "order";

export interface DesignFacts {
  /** Real parts on the schematic. */
  readonly parts: number;
  /** Parts on the board. */
  readonly footprints: number;
  /** Parts that sit inside the board outline; undefined when the board has no outline. */
  readonly inside?: number | undefined;
  readonly tracks: number;
  /** Connections still to route, when a DRC run has counted them. */
  readonly unrouted?: number | undefined;
  /** Errors of the last ERC and DRC run; undefined when no check has run. */
  readonly errors?: number | undefined;
  /** The layout review's score out of 100, when it has run. */
  readonly score?: number | undefined;
}

export interface DesignStep {
  readonly id: StepId;
  readonly label: string;
  readonly done: boolean;
  /** Where the step stands, in a few words. */
  readonly status: string;
  /** What to ask the agent to do this step; absent when it cannot do it yet. */
  readonly prompt?: string;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** The steps in order; the first one not done is where the design stands. */
export function designSteps(facts: DesignFacts, design: string): ReadonlyArray<DesignStep> {
  const { parts, footprints, inside, tracks, unrouted, errors, score } = facts;
  const layout = score === undefined ? "" : `, layout ${Math.round(score)}/100`;
  const placed = parts > 0 && footprints >= parts && (inside ?? 0) >= footprints;
  const routed = tracks > 0 && (unrouted ?? 0) === 0;
  return [
    {
      id: "requirements",
      label: "Requirements",
      done: parts > 0 || footprints > 0,
      status: "Say what the board should do",
      prompt:
        "I want to build a board that . Before drawing anything, write the short spec: the supply and its current, the blocks from input to output, the board size and where the connectors go, and what you are unsure of.",
    },
    {
      id: "schematic",
      label: "Schematic",
      done: parts > 0,
      status: parts > 0 ? plural(parts, "part") : "No parts yet",
      prompt: `Draw the schematic for ${design} from what we agreed with the copper tool: JLC Basic parts where they exist, each IC wired as its datasheet's typical application, the whole circuit in as few sch_apply batches as it takes. Fix every ERC error its result lists, then run design_review and tell me what you chose and why.`,
    },
    {
      id: "placement",
      label: "Placement",
      done: placed,
      status:
        parts === 0
          ? "Nothing to place"
          : footprints < parts
            ? `${footprints} of ${parts} on the board`
            : inside === undefined
              ? "No board outline yet"
              : `${Math.min(inside, parts)} of ${parts} placed`,
      prompt: `Bring ${design} onto the board with board_build and a size that fits. Then judge the placement before any routing: read pcb_read with what ['elegance'], look at the picture, and move what is wrong by hand (a part auto placement could not seat, a radio module's antenna off the edge, decoupling far from its pin, a connector off the edge). Say what you moved and why.`,
    },
    {
      id: "routing",
      label: "Routing",
      done: placed && routed,
      status:
        tracks === 0
          ? "No tracks yet"
          : unrouted
            ? `${plural(unrouted, "connection")} left`
            : plural(tracks, "track"),
      prompt: `Route ${design} to a plan: read pcb_route_plan, put the nets that matter first (USB pairs, crystals, supply paths), try the plan with dry_run, then route. When nets block each other change the order or rip those nets up and route them again; when a corner will not route, go back and move the parts or swap interchangeable pins rather than add vias. Keep copper out under and beside any antenna. Tell me what you routed first and what you had to redo.`,
    },
    {
      id: "checks",
      label: "Checks",
      done: errors === 0,
      status:
        errors === undefined
          ? "Not run"
          : `${errors === 0 ? "No errors" : plural(errors, "error")}${layout}`,
      prompt: `Review ${design} as a second engineer would: run verify and design_review, read the layout score, and sort every finding into fix now, fix later, or leave with the reason. Fix the first group at its cause, check again, and give me the list of what is left.`,
    },
    {
      id: "order",
      label: "Order",
      done: false,
      status: "Files for JLC",
      prompt: `Make the order pack for ${design} with fab_export once there are no ERC or DRC errors and every part has an LCSC number. Tell me which file goes where on JLC's order page, what the Extended parts cost extra, and what I must check by eye before paying.`,
    },
  ];
}

export const currentStep = (steps: ReadonlyArray<DesignStep>): DesignStep | undefined =>
  steps.find((step) => !step.done);
