import { cn } from "~/lib/utils";

import type { Problem } from "./problems.ts";

/** The check results for the drawing on screen; clicking one centres it. */
export function ProblemList(props: {
  readonly problems: ReadonlyArray<Problem>;
  readonly activeKey: string | undefined;
  readonly truncated: boolean;
  readonly onPick: (problem: Problem) => void;
}) {
  return (
    <div className="absolute top-2 right-2 flex max-h-[70%] w-72 flex-col rounded-md border bg-background/95 text-xs shadow-md">
      <div className="border-b px-2 py-1.5 font-medium">
        {props.problems.length === 0 ? "No problems here" : `${props.problems.length} problems`}
        {props.truncated ? (
          <span className="font-normal text-muted-foreground"> (first 100)</span>
        ) : null}
      </div>
      <div className="min-h-0 overflow-y-auto p-1">
        {props.problems.map((problem) => (
          <button
            key={problem.key}
            type="button"
            className={cn(
              "flex w-full gap-2 rounded px-1.5 py-1 text-left hover:bg-accent",
              problem.key === props.activeKey && "bg-accent",
            )}
            onClick={() => props.onPick(problem)}
          >
            <span
              aria-label={problem.severity}
              className={cn(
                "mt-1 size-2 shrink-0 rounded-full",
                problem.severity === "error" ? "bg-destructive" : "bg-warning",
              )}
            />
            <span className="min-w-0">
              <span className="block break-words">{problem.title}</span>
              {problem.subject ? (
                <span className="block break-words text-muted-foreground">{problem.subject}</span>
              ) : null}
              {problem.hint ? (
                <span className="mt-0.5 block text-muted-foreground">{problem.hint}</span>
              ) : null}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
