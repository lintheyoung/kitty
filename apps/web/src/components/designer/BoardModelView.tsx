import type { ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";
import { useRef, useState } from "react";

import { cn } from "~/lib/utils";

import { hardwareBoardModel } from "../../state/hardware";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import { ModelController, type ModelView } from "./modelController.ts";

function ModelCanvas(props: { readonly glb: string }) {
  const controller = useRef<ModelController | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const attach = (canvas: HTMLCanvasElement) => {
    const created = new ModelController(canvas, props.glb, setState);
    controller.current = created;
    return () => {
      created.destroy();
      controller.current = null;
    };
  };
  const views: ReadonlyArray<readonly [ModelView, string]> = [
    ["angle", "Angle"],
    ["top", "Top"],
    ["bottom", "Bottom"],
  ];
  return (
    <>
      <canvas
        // A new model gets a new canvas, and with it a fresh WebGL context.
        key={props.glb.length}
        ref={attach}
        aria-label="Board in 3D"
        className="absolute inset-0 block size-full cursor-grab touch-none active:cursor-grabbing"
      />
      {state === "ready" ? (
        <div className="absolute right-2 bottom-2 flex gap-1 rounded-md border bg-background/90 p-0.5 shadow-sm">
          {views.map(([view, label]) => (
            <Button
              key={view}
              size="xs"
              variant="ghost"
              onClick={() => controller.current?.look(view)}
            >
              {label}
            </Button>
          ))}
        </div>
      ) : (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          {state === "failed"
            ? "This browser could not show the 3D model."
            : "Preparing the 3D view…"}
        </div>
      )}
    </>
  );
}

/** The board in 3D: drag to turn it, scroll to zoom, right-drag to move. */
export function BoardModelView(props: {
  readonly threadRef: ScopedThreadRef;
  readonly projectId: ProjectId;
  /** The design's .kicad_pro, relative to the workspace. */
  readonly path: string;
  readonly className?: string;
}) {
  const { environmentId, threadId } = props.threadRef;
  const model = useEnvironmentQuery(
    hardwareBoardModel({
      environmentId,
      input: { threadId, projectId: props.projectId, path: props.path },
    }),
  );
  return (
    <div className={cn("relative min-h-0 min-w-0", props.className)}>
      {model.data ? (
        <ModelCanvas glb={model.data.glb} />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted-foreground">
          {model.error ?? "Building the 3D model with KiCad…"}
        </div>
      )}
      <div className="absolute top-2 right-2 flex items-center gap-2 text-xs text-muted-foreground">
        {model.data && !model.data.detailed ? <span>Simplified: no silkscreen</span> : null}
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Rebuild 3D model"
          disabled={model.isPending}
          onClick={() => model.refresh()}
        >
          <RefreshCwIcon className={cn(model.isPending && "animate-spin")} />
        </Button>
      </div>
    </div>
  );
}
