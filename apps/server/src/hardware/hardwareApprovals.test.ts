import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { makeHardwareApprovals } from "./hardwareApprovals.ts";

const request = { kind: "flash" as const, project: "blink", port: "/dev/cu.usbmodem1301" };

const firstPending = (approvals: Effect.Success<ReturnType<typeof makeHardwareApprovals>>) =>
  approvals.pending.pipe(
    Stream.filter((pending) => pending.length > 0),
    Stream.runHead,
    Effect.map((head) => (head._tag === "Some" ? head.value : [])),
  );

it.effect("waits for the user's answer and lists the request meanwhile", () =>
  Effect.gen(function* () {
    const approvals = yield* makeHardwareApprovals();
    const waiting = yield* approvals.request(request, "5 minutes").pipe(Effect.forkChild);
    const pending = yield* firstPending(approvals);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.port, request.port);
    assert.isTrue(yield* approvals.respond(pending[0]?.id ?? "", true));
    assert.isTrue(yield* Fiber.join(waiting));
    assert.isFalse(yield* approvals.respond(pending[0]?.id ?? "", true));
  }),
);

it.effect("treats a denial or no answer as no", () =>
  Effect.gen(function* () {
    const approvals = yield* makeHardwareApprovals();
    const denied = yield* approvals.request(request, "5 minutes").pipe(Effect.forkChild);
    const pending = yield* firstPending(approvals);
    yield* approvals.respond(pending[0]?.id ?? "", false);
    assert.isFalse(yield* Fiber.join(denied));

    const unanswered = yield* approvals.request(request, "5 minutes").pipe(Effect.forkChild);
    yield* firstPending(approvals);
    yield* TestClock.adjust("6 minutes");
    assert.isFalse(yield* Fiber.join(unanswered));
  }),
);
