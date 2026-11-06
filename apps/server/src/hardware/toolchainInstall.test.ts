import { expect, it } from "vite-plus/test";

import { eimAsset, eimDownloadUrl, eimInstallArgs, KITTY_IDF_RELEASE } from "./toolchainInstall.ts";

it("picks EIM's CLI build for each OS and CPU", () => {
  expect(eimAsset("darwin", "arm64")?.name).toBe("eim-cli-macos-aarch64.zip");
  expect(eimAsset("darwin", "x64")?.name).toBe("eim-cli-macos-x64.zip");
  expect(eimAsset("linux", "arm64")?.name).toBe("eim-cli-linux-aarch64.zip");
  expect(eimAsset("win32", "x64")).toEqual({ name: "eim-cli-windows-x64.exe", archive: "exe" });
  expect(eimAsset("freebsd", "x64")).toBeUndefined();
  expect(eimDownloadUrl("eim-cli-macos-aarch64.zip")).toBe(
    "https://github.com/espressif/idf-im-ui/releases/download/v0.20.1/eim-cli-macos-aarch64.zip",
  );
});

it("installs Kitty's ESP-IDF without prompts or telemetry, through mirrors when asked", () => {
  const global = eimInstallArgs({ mirror: "global" });
  expect(global).toEqual([
    "install",
    "--idf-versions",
    KITTY_IDF_RELEASE,
    "--target",
    "esp32s3",
    "--non-interactive",
    "true",
    "--do-not-track",
    "true",
    "--cleanup",
    "true",
  ]);
  const china = eimInstallArgs({ mirror: "china", basePath: "/x/esp", registryDir: "/x/reg" });
  expect(china).toContain("https://dl.espressif.cn/github_assets");
  expect(china.slice(china.indexOf("--idf-mirror"), china.indexOf("--idf-mirror") + 4)).toEqual([
    "--idf-mirror",
    "https://gitee.com",
    "--repo-stub",
    "EspressifSystems/esp-idf",
  ]);
  expect(china).toEqual(
    expect.arrayContaining(["--path", "/x/esp", "--esp-idf-json-path", "/x/reg"]),
  );
});
