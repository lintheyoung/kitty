import { HardwareToolError } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";

/**
 * Who may use a serial port. One holder at a time: two programs reading the
 * same port split its bytes, and esptool cannot flash a port someone holds.
 * The panel's monitor yields to a flash or an agent read; anything else waits
 * its turn by failing with `port_busy`.
 */
export type SerialLeaseKind = "flash" | "agent" | "monitor" | "reset";

interface Holder {
  readonly kind: SerialLeaseKind;
  readonly label: string;
  /** Asks the holder to let go (monitors only); resolves when it has. */
  readonly preempt?: ((by: string) => Effect.Effect<void>) | undefined;
  readonly released: Deferred.Deferred<void>;
}

export interface SerialLeases {
  /** Holds `port` until the surrounding scope closes. */
  readonly acquire: (
    port: string,
    kind: SerialLeaseKind,
    label: string,
    preempt?: (by: string) => Effect.Effect<void>,
  ) => Effect.Effect<void, HardwareToolError, Scope.Scope>;
  readonly holders: () => ReadonlyMap<string, string>;
}

export const makeSerialLeases = (): SerialLeases => {
  const held = new Map<string, Holder>();

  const acquire = Effect.fn("SerialLeases.acquire")(function* (
    port: string,
    kind: SerialLeaseKind,
    label: string,
    preempt?: (by: string) => Effect.Effect<void>,
  ) {
    const current = held.get(port);
    if (current) {
      if (current.kind !== "monitor" || kind === "monitor" || !current.preempt) {
        return yield* new HardwareToolError({
          code: "port_busy",
          message: `${port} is in use by ${current.label}. Try again when it finishes.`,
        });
      }
      yield* current.preempt(label);
      yield* Deferred.await(current.released);
      // Someone else may have taken the port while the monitor was closing.
      if (held.has(port)) {
        return yield* new HardwareToolError({
          code: "port_busy",
          message: `${port} is in use by ${held.get(port)?.label ?? "another task"}.`,
        });
      }
    }
    const released = yield* Deferred.make<void>();
    const holder: Holder = { kind, label, preempt, released };
    held.set(port, holder);
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        if (held.get(port) === holder) held.delete(port);
        yield* Deferred.succeed(released, undefined);
      }),
    );
  });

  return {
    acquire,
    holders: () => new Map([...held].map(([port, holder]) => [port, holder.label])),
  };
};
