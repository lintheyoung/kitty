import type { HardwareApproval } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

/**
 * Agent requests to write to a board wait here until the user allows or
 * denies them in the Hardware panel (PRD: flashing needs the user's consent).
 */
export interface HardwareApprovals {
  /** Resolves `true` when allowed; `false` when denied or unanswered in `timeout`. */
  readonly request: (
    approval: Omit<HardwareApproval, "id" | "requestedAt">,
    timeout: Duration.Input,
  ) => Effect.Effect<boolean>;
  readonly respond: (id: string, allow: boolean) => Effect.Effect<boolean>;
  readonly pending: Stream.Stream<ReadonlyArray<HardwareApproval>>;
}

export const makeHardwareApprovals = Effect.fn("makeHardwareApprovals")(function* () {
  const pendingRef = yield* SubscriptionRef.make<ReadonlyArray<HardwareApproval>>([]);
  const answers = new Map<string, Deferred.Deferred<boolean>>();
  let counter = 0;

  const request = Effect.fn("HardwareApprovals.request")(function* (
    approval: Omit<HardwareApproval, "id" | "requestedAt">,
    timeout: Duration.Input,
  ) {
    const now = yield* DateTime.now;
    counter += 1;
    const entry: HardwareApproval = {
      ...approval,
      id: `hw-approval-${DateTime.toEpochMillis(now).toString(36)}-${counter}`,
      requestedAt: DateTime.formatIso(now),
    };
    const answer = yield* Deferred.make<boolean>();
    answers.set(entry.id, answer);
    yield* SubscriptionRef.update(pendingRef, (pending) => [...pending, entry]);
    const decided = yield* Deferred.await(answer).pipe(
      Effect.timeoutOption(timeout),
      Effect.ensuring(
        Effect.gen(function* () {
          answers.delete(entry.id);
          yield* SubscriptionRef.update(pendingRef, (pending) =>
            pending.filter((candidate) => candidate.id !== entry.id),
          );
        }),
      ),
    );
    return Option.getOrElse(decided, () => false);
  });

  const respond = Effect.fn("HardwareApprovals.respond")(function* (id: string, allow: boolean) {
    const answer = answers.get(id);
    if (!answer) return false;
    return yield* Deferred.succeed(answer, allow);
  });

  return {
    request,
    respond,
    pending: SubscriptionRef.changes(pendingRef),
  } satisfies HardwareApprovals;
});
