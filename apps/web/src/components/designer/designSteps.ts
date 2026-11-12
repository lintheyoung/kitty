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
  const { parts, footprints, inside, tracks, unrouted, errors } = facts;
  const placed = parts > 0 && footprints >= parts && (inside ?? 0) >= footprints;
  const routed = tracks > 0 && (unrouted ?? 0) === 0;
  return [
    {
      id: "requirements",
      label: "Requirements",
      done: parts > 0 || footprints > 0,
      status: "Say what the board should do",
      prompt: "I want to build a board that ",
    },
    {
      id: "schematic",
      label: "Schematic",
      done: parts > 0,
      status: parts > 0 ? plural(parts, "part") : "No parts yet",
      prompt: `Draw the schematic for ${design} from what we agreed, with JLC parts only. Explain each block as you add it.`,
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
      prompt: `Bring the schematic of ${design} onto the board, set an outline that fits, and place the parts: blocks together, connectors at the edges, decoupling capacitors beside their chips. Explain your choices.`,
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
      prompt: `Route ${design}: keep copper out from under any antenna, run the auto-router, then finish what it leaves by hand and tell me what you did.`,
    },
    {
      id: "checks",
      label: "Checks",
      done: errors === 0,
      status:
        errors === undefined ? "Not run" : errors === 0 ? "No errors" : plural(errors, "error"),
      prompt: `Run ERC and DRC on ${design}, explain each problem in plain words and fix what you can.`,
    },
    {
      id: "order",
      label: "Order",
      done: false,
      status: "Files for JLC",
      prompt: `Export the JLC fabrication files for ${design} and tell me what to upload.`,
    },
  ];
}

export const currentStep = (steps: ReadonlyArray<DesignStep>): DesignStep | undefined =>
  steps.find((step) => !step.done);
