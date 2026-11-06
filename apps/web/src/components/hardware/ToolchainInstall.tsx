import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  HardwareToolchainInstallResult,
  HardwareToolchainMirror,
} from "@t3tools/contracts";
import { DownloadIcon, LoaderCircleIcon } from "lucide-react";
import { useState } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { hardwareToolchainInstall } from "../../state/hardware";
import { formatEnvironmentQueryError } from "../../state/query";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const MAX_LOG_CHARS = 64_000;

type InstallState =
  | { readonly status: "idle" }
  | { readonly status: "running"; readonly log: string }
  | { readonly status: "done"; readonly result: HardwareToolchainInstallResult }
  | { readonly status: "failed"; readonly message: string };

const MIRRORS: ReadonlyArray<{ readonly id: HardwareToolchainMirror; readonly label: string }> = [
  { id: "china", label: "China mirrors" },
  { id: "global", label: "Global (GitHub)" },
];

/**
 * One-click ESP-IDF for machines without it: Espressif's installer (EIM)
 * fetches the ESP-IDF version Kitty is tested with and its tools.
 */
export function ToolchainInstall(props: {
  readonly environmentId: EnvironmentId;
  readonly onInstalled: () => void;
}) {
  const [mirror, setMirror] = useState<HardwareToolchainMirror>(() =>
    typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("zh")
      ? "china"
      : "global",
  );
  const [state, setState] = useState<InstallState>({ status: "idle" });

  const install = async () => {
    setState({ status: "running", log: "" });
    const onOutput = (text: string) => {
      const clean = text.replace(ANSI, "").replaceAll("\r\n", "\n");
      setState((current) =>
        current.status === "running"
          ? { status: "running", log: (current.log + clean).slice(-MAX_LOG_CHARS) }
          : current,
      );
    };
    const result = await runAtomCommand(
      appAtomRegistry,
      hardwareToolchainInstall,
      { environmentId: props.environmentId, input: { mirror }, onOutput },
      { reportFailure: false },
    );
    if (result._tag === "Success") {
      setState({ status: "done", result: result.value });
      if (result.value.ok) props.onInstalled();
    } else {
      setState({ status: "failed", message: formatEnvironmentQueryError(result.cause) });
    }
  };

  const running = state.status === "running";
  return (
    <section className="mt-3 flex flex-col gap-2 rounded-md border p-2">
      <div>
        <div className="text-sm font-medium">Install ESP-IDF</div>
        <p className="text-xs text-muted-foreground">
          Kitty installs the ESP-IDF version it is tested with, using Espressif&apos;s installer. It
          downloads about 2 GB and can take 10 to 30 minutes.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {MIRRORS.map((option) => (
          <Button
            key={option.id}
            size="xs"
            variant={mirror === option.id ? "secondary" : "ghost"}
            disabled={running}
            onClick={() => setMirror(option.id)}
          >
            {option.label}
          </Button>
        ))}
        <Button size="xs" disabled={running} onClick={() => void install()}>
          {running ? <LoaderCircleIcon className="animate-spin" /> : <DownloadIcon />}
          {running ? "Installing…" : "Install"}
        </Button>
      </div>
      {state.status === "running" ? (
        <div className="flex max-h-48 flex-col-reverse overflow-auto rounded bg-muted p-2">
          <pre className="font-mono text-2xs whitespace-pre-wrap text-muted-foreground">
            {state.log.length > 0 ? state.log : "Starting…"}
          </pre>
        </div>
      ) : null}
      {state.status === "failed" ? (
        <p className="text-xs text-destructive-foreground">{state.message}</p>
      ) : null}
      {state.status === "done" ? (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Badge variant={state.result.ok ? "success" : "error"}>
              {state.result.ok ? "Installed" : "Install failed"}
            </Badge>
            <span>
              ESP-IDF {state.result.idfVersion} · {Math.round(state.result.durationMs / 60_000)} min
            </span>
          </div>
          {state.result.ok ? null : (
            <pre className="max-h-48 overflow-auto rounded bg-muted p-2 text-2xs whitespace-pre-wrap">
              {state.result.logTail}
            </pre>
          )}
        </div>
      ) : null}
    </section>
  );
}
