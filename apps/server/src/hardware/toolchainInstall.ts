/**
 * One-click ESP-IDF install through Espressif's own installer, EIM
 * (github.com/espressif/idf-im-ui). Kitty pins the EIM release and the
 * ESP-IDF version it installs, so every machine gets the tested toolchain.
 */

export const EIM_VERSION = "v0.20.1";
/** The ESP-IDF release Kitty is tested against (SUPPORTED_IDF is its minor line). */
export const KITTY_IDF_RELEASE = "v5.5.5";

export type ToolchainMirror = "global" | "china";

/** EIM's CLI asset for this OS and CPU, or undefined where Espressif ships none. */
export function eimAsset(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): { readonly name: string; readonly archive: "zip" | "exe" } | undefined {
  if (platform === "darwin") {
    return {
      name: arch === "arm64" ? "eim-cli-macos-aarch64.zip" : "eim-cli-macos-x64.zip",
      archive: "zip",
    };
  }
  if (platform === "linux") {
    if (arch === "x64") return { name: "eim-cli-linux-x64.zip", archive: "zip" };
    if (arch === "arm64") return { name: "eim-cli-linux-aarch64.zip", archive: "zip" };
    if (arch === "arm") return { name: "eim-cli-linux-armv7.zip", archive: "zip" };
    return undefined;
  }
  if (platform === "win32" && arch === "x64") {
    return { name: "eim-cli-windows-x64.exe", archive: "exe" };
  }
  return undefined;
}

export const eimDownloadUrl = (asset: string) =>
  `https://github.com/espressif/idf-im-ui/releases/download/${EIM_VERSION}/${asset}`;

/** The mirror presets EIM's own wizard offers. */
const MIRRORS: Record<ToolchainMirror, ReadonlyArray<string>> = {
  global: [],
  china: [
    "--mirror",
    "https://dl.espressif.cn/github_assets",
    // Espressif's Gitee mirror lives under EspressifSystems, not espressif.
    "--idf-mirror",
    "https://gitee.com",
    "--repo-stub",
    "EspressifSystems/esp-idf",
    "--pypi-mirror",
    "https://mirrors.aliyun.com/pypi/simple",
  ],
};

/** `eim install` for Kitty's ESP-IDF, without prompts or telemetry. */
export function eimInstallArgs(input: {
  readonly mirror: ToolchainMirror;
  readonly target?: string;
  /** Install root; EIM's default is ~/.espressif. */
  readonly basePath?: string | undefined;
  /** Where EIM records installs (eim_idf.json); default ~/.espressif/tools. */
  readonly registryDir?: string | undefined;
}): ReadonlyArray<string> {
  return [
    "install",
    "--idf-versions",
    KITTY_IDF_RELEASE,
    "--target",
    input.target ?? "esp32s3",
    "--non-interactive",
    "true",
    "--do-not-track",
    "true",
    "--cleanup",
    "true",
    ...(input.basePath ? ["--path", input.basePath] : []),
    ...(input.registryDir ? ["--esp-idf-json-path", input.registryDir] : []),
    ...MIRRORS[input.mirror],
  ];
}
