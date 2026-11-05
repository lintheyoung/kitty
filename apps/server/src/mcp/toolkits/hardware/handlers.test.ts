import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { resolveInWorkspace } from "./handlers.ts";

it.effect("confines project paths to the thread's workspace", () =>
  Effect.gen(function* () {
    assert.equal(
      yield* resolveInWorkspace("/work/repo", "firmware/blink"),
      "/work/repo/firmware/blink",
    );
    assert.equal(yield* resolveInWorkspace("/work/repo/", "."), "/work/repo");
    for (const escape of ["../other", "/etc", "firmware/../../other", "/work/repo-evil"]) {
      const error = yield* Effect.flip(resolveInWorkspace("/work/repo", escape));
      assert.equal(error.code, "invalid_path", escape);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);
