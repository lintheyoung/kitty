import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveUserDataPath } from "./DesktopUserData.ts";

// Kitty runs beside Kitty on the same machine and must never adopt its Electron profiles.
it.effect.each([
  { platform: "win32", isDevelopment: false, expected: "kitty" },
  { platform: "darwin", isDevelopment: false, expected: "kitty" },
  { platform: "darwin", isDevelopment: true, expected: "kitty-dev" },
] as const)(
  "uses its own $expected profile on $platform beside Kitty profiles",
  ({ platform, isDevelopment, expected }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "kitty-profile-" });
      const state = '{"os_crypt":{"encrypted_key":"t3-key"}}';
      for (const name of ["t3code", "t3code-v2", "Kitty (Alpha)", "t3code-dev", "Kitty (Dev)"]) {
        yield* fs.makeDirectory(path.join(directory, name), { recursive: true });
        yield* fs.writeFileString(path.join(directory, name, "Local State"), state);
      }
      const resolved = yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment,
        platform,
      });
      assert.equal(resolved, path.join(directory, expected));
      assert.isFalse(yield* fs.exists(path.join(resolved, "Local State")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
