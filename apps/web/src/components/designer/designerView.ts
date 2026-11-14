import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { DesignerView, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { displayNet } from "@t3tools/shared/kicad/pick";
import { useEffect } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { hardwareDesignView } from "../../state/hardware";
import type { DesignStep } from "./designSteps.ts";
import type { Problem } from "./problems.ts";

const PROBLEMS_SENT = 12;
/** The server forgets a view after a while; an open designer says it again. */
const REPEAT_MS = 5 * 60 * 1000;
const SETTLE_MS = 300;

/** What the designer shows, in the words the agent reads with the user's next message. */
export function designerView(input: {
  readonly project: string;
  readonly drawing: DesignerView["drawing"];
  readonly file?: string | undefined;
  readonly selection?:
    | { readonly ref?: string | undefined; readonly net?: string | undefined }
    | undefined;
  readonly value?: string | undefined;
  readonly steps: ReadonlyArray<DesignStep>;
  readonly problems: ReadonlyArray<Problem>;
}): DesignerView {
  const { ref, net } = input.selection ?? {};
  const picked = ref !== undefined || net !== undefined;
  return {
    project: input.project,
    drawing: input.drawing,
    ...(input.file ? { file: input.file } : {}),
    ...(picked
      ? {
          selection: {
            ...(ref ? { ref } : {}),
            ...(ref && input.value ? { value: input.value } : {}),
            ...(net ? { net: displayNet(net) } : {}),
          },
        }
      : {}),
    steps: input.steps
      .filter((step) => step.id !== "requirements" && step.id !== "order")
      .map((step) => `${step.label}: ${step.status}`),
    problemCount: input.problems.length,
    problems: input.problems.slice(0, PROBLEMS_SENT).map((problem) => {
      const at =
        problem.x === undefined || problem.y === undefined
          ? ""
          : ` at (${problem.x.toFixed(1)}, ${problem.y.toFixed(1)})`;
      return `${problem.severity}: ${problem.title}${problem.subject ? `, ${problem.subject}` : ""}${at}`;
    }),
  };
}

/** Keeps the server told what the designer shows, and tells it when the designer closes. */
export function useDesignerViewReport(
  target: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
  },
  view: DesignerView | undefined,
) {
  const { environmentId, threadId, projectId } = target;
  const key = view ? JSON.stringify(view) : "";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the server's copy of the view, which the agent reads with the next message
  useEffect(() => {
    if (key === "") return;
    const send = () =>
      void runAtomCommand(
        appAtomRegistry,
        hardwareDesignView,
        { environmentId, input: { threadId, projectId, view: JSON.parse(key) as DesignerView } },
        { reportFailure: false },
      );
    const settle = setTimeout(send, SETTLE_MS);
    const repeat = setInterval(send, REPEAT_MS);
    return () => {
      clearTimeout(settle);
      clearInterval(repeat);
    };
  }, [environmentId, threadId, projectId, key]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the server's copy of the view: only a closing designer clears it, a change replaces it
  useEffect(
    () => () =>
      void runAtomCommand(
        appAtomRegistry,
        hardwareDesignView,
        { environmentId, input: { threadId, projectId, view: null } },
        { reportFailure: false },
      ),
    [environmentId, threadId, projectId],
  );
}
