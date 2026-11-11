/** The path from an idea to an ordered board, and how far a design is along it. */
export type StepId = "requirements" | "schematic" | "placement" | "routing" | "checks" | "order";

export interface DesignFacts {
  /** Real parts on the schematic. */
  readonly parts: number;
  /** Parts on the board. */
  readonly footprints: number;
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
  const { parts, footprints, tracks, unrouted, errors } = facts;
  const placed = parts > 0 && footprints >= parts;
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
        parts > 0 ? `${Math.min(footprints, parts)} of ${parts} on the board` : "Nothing to place",
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
