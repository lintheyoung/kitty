import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { makeSerialLeases } from "./serialLeases.ts";

const PORT = "/dev/cu.usbmodem1301";

it.effect("gives a port to one holder at a time and frees it with the scope", () =>
  Effect.gen(function* () {
    const leases = makeSerialLeases();
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* leases.acquire(PORT, "flash", "a flash");
        assert.equal(leases.holders().get(PORT), "a flash");
        const busy = yield* Effect.flip(Effect.scoped(leases.acquire(PORT, "agent", "an agent")));
        assert.equal(busy.code, "port_busy");
        assert.include(busy.message, "a flash");
      }),
    );
    assert.equal(leases.holders().size, 0);
    yield* Effect.scoped(leases.acquire(PORT, "agent", "an agent"));
  }),
);

it.effect("a flash preempts the panel monitor and waits until it has closed", () =>
  Effect.gen(function* () {
    const leases = makeSerialLeases();
    const preemptedBy = yield* Deferred.make<string>();
    const monitorOpen = yield* Deferred.make<void>();
    const monitor = yield* Effect.scoped(
      Effect.gen(function* () {
        yield* leases.acquire(PORT, "monitor", "the panel monitor", (by) =>
          Deferred.succeed(preemptedBy, by).pipe(Effect.asVoid),
        );
        yield* Deferred.succeed(monitorOpen, undefined);
        // The monitor runs until it is told to stop.
        yield* Deferred.await(preemptedBy);
      }),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(monitorOpen);

    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* leases.acquire(PORT, "flash", "a flash");
        assert.equal(yield* Deferred.await(preemptedBy), "a flash");
        assert.equal(leases.holders().get(PORT), "a flash");
      }),
    );
    yield* Fiber.join(monitor);

    // A second monitor cannot push the first one off.
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* leases.acquire(PORT, "monitor", "monitor one", () => Effect.void);
        const busy = yield* Effect.flip(
          Effect.scoped(leases.acquire(PORT, "monitor", "monitor two", () => Effect.void)),
        );
        assert.equal(busy.code, "port_busy");
      }),
    );
  }),
);
