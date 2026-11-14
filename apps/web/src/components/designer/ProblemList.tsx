import { SparklesIcon } from "lucide-react";

import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import type { Problem } from "./problems.ts";

/** The check results for the drawing on screen; clicking one centres it, Fix hands it to the agent. */
export function ProblemList(props: {
  readonly problems: ReadonlyArray<Problem>;
  readonly activeKey: string | undefined;
  readonly truncated: boolean;
  /** The layout review's score out of 100, on the board. */
  readonly score?: number | undefined;
  readonly onPick: (problem: Problem) => void;
  /** Puts a request to fix these in the chat box. */
  readonly onFix: (problems: ReadonlyArray<Problem>) => void;
}) {
  return (
    <div className="absolute top-2 right-2 flex max-h-[70%] w-80 flex-col rounded-md border bg-background/95 text-xs shadow-md">
      <div className="flex items-center gap-2 border-b px-2 py-1.5">
        <div className="min-w-0 flex-1 font-medium">
          {props.problems.length === 0 ? "No problems here" : `${props.problems.length} problems`}
          {props.truncated ? (
            <span className="font-normal text-muted-foreground"> (first 100)</span>
          ) : null}
          {props.score === undefined ? null : (
            <span className="font-normal text-muted-foreground">
              {" "}
              · layout {Math.round(props.score)}/100
            </span>
          )}
        </div>
        {props.problems.length > 0 ? (
          <Button size="xs" variant="outline" onClick={() => props.onFix(props.problems)}>
            <SparklesIcon />
            Fix all with Kitty
          </Button>
        ) : null}
      </div>
      <ul className="min-h-0 overflow-y-auto p-1">
        {props.problems.map((problem) => (
          <li
            key={problem.key}
            className={cn(
              "group flex items-start gap-1 rounded hover:bg-accent",
              problem.key === props.activeKey && "bg-accent",
            )}
          >
            <button
              type="button"
              className="flex min-w-0 flex-1 gap-2 px-1.5 py-1 text-left"
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
                  <span className="mt-0.5 block break-words text-muted-foreground">
                    {problem.hint}
                  </span>
                ) : null}
              </span>
            </button>
            <Button
              size="xs"
              variant="ghost-muted"
              className="mt-0.5 mr-0.5 shrink-0"
              aria-label="Ask Kitty to fix this"
              onClick={() => props.onFix([problem])}
            >
              <SparklesIcon />
              Fix
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
