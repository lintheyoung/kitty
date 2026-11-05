import { describe, expect, it } from "vite-plus/test";

import {
  applySdkconfigUpdates,
  decodeSdkconfigValue,
  encodeSdkconfigValue,
  entryValue,
  isSdkconfigKey,
  normalizeSdkconfigKey,
  parseKconfigChoices,
  parseSdkconfig,
  searchSdkconfig,
} from "./sdkconfig.ts";

// Excerpt of an ESP-IDF v5.5 generated sdkconfig.
const SDKCONFIG = `#
# Automatically generated file. DO NOT EDIT.
# Espressif IoT Development Framework (ESP-IDF) 5.5.5 Project Configuration
#
CONFIG_IDF_TARGET="esp32s3"
CONFIG_ESPTOOLPY_FLASHSIZE_4MB=y
# CONFIG_ESPTOOLPY_FLASHSIZE_8MB is not set
CONFIG_ESPTOOLPY_FLASHSIZE="4MB"
CONFIG_FREERTOS_HZ=100
CONFIG_PARTITION_TABLE_OFFSET=0x8000
CONFIG_LOG_DEFAULT_LEVEL_INFO=y
CONFIG_LWIP_LOCAL_HOSTNAME="say \\"hi\\""
`;

describe("parseSdkconfig", () => {
  it("reads set, unset, string, int and hex options", () => {
    const entries = parseSdkconfig(SDKCONFIG);
    expect(entryValue(entries.get("CONFIG_IDF_TARGET")!)).toBe("esp32s3");
    expect(entryValue(entries.get("CONFIG_ESPTOOLPY_FLASHSIZE_4MB")!)).toBe(true);
    expect(entryValue(entries.get("CONFIG_ESPTOOLPY_FLASHSIZE_8MB")!)).toBe(false);
    expect(entryValue(entries.get("CONFIG_FREERTOS_HZ")!)).toBe(100);
    expect(entryValue(entries.get("CONFIG_PARTITION_TABLE_OFFSET")!)).toBe("0x8000");
    expect(entryValue(entries.get("CONFIG_LWIP_LOCAL_HOSTNAME")!)).toBe('say "hi"');
    expect(entries.size).toBe(8);
  });

  it("searches keys and values", () => {
    expect(searchSdkconfig(parseSdkconfig(SDKCONFIG), "flashsize")).toEqual([
      "CONFIG_ESPTOOLPY_FLASHSIZE_4MB",
      "CONFIG_ESPTOOLPY_FLASHSIZE_8MB",
      "CONFIG_ESPTOOLPY_FLASHSIZE",
    ]);
    expect(searchSdkconfig(parseSdkconfig(SDKCONFIG), "esp32s3")).toEqual(["CONFIG_IDF_TARGET"]);
  });
});

describe("encodeSdkconfigValue", () => {
  it("encodes by value type, keeping the existing option's quoting", () => {
    expect(encodeSdkconfigValue(true)).toBe("y");
    expect(encodeSdkconfigValue(false)).toBeNull();
    expect(encodeSdkconfigValue(1000)).toBe("1000");
    expect(encodeSdkconfigValue("0x9000")).toBe("0x9000");
    expect(encodeSdkconfigValue("kitty")).toBe('"kitty"');
    expect(encodeSdkconfigValue("123", '"old"')).toBe('"123"');
    expect(encodeSdkconfigValue("0x10000", "0x8000")).toBe("0x10000");
    expect(encodeSdkconfigValue('a"b')).toBe('"a\\"b"');
  });

  it("round-trips through decode", () => {
    for (const value of [true, 42, "0x8000", 'quote " and \\ slash']) {
      const raw = encodeSdkconfigValue(value);
      expect(raw === null ? false : decodeSdkconfigValue(raw)).toEqual(value);
    }
  });
});

describe("applySdkconfigUpdates", () => {
  it("rewrites existing lines in place and appends new options", () => {
    const next = applySdkconfigUpdates(
      SDKCONFIG,
      new Map([
        ["CONFIG_FREERTOS_HZ", "1000"],
        ["CONFIG_ESPTOOLPY_FLASHSIZE_4MB", null],
        ["CONFIG_ESPTOOLPY_FLASHSIZE_8MB", "y"],
        ["CONFIG_KITTY_NEW", '"x"'],
      ]),
    );
    expect(next).toContain("CONFIG_FREERTOS_HZ=1000\n");
    expect(next).toContain("# CONFIG_ESPTOOLPY_FLASHSIZE_4MB is not set\n");
    expect(next).toContain("CONFIG_ESPTOOLPY_FLASHSIZE_8MB=y\n");
    expect(next.endsWith('CONFIG_KITTY_NEW="x"\n')).toBe(true);
    expect(next.split("\n").length).toBe(SDKCONFIG.split("\n").length + 1);
  });

  it("creates a defaults file from nothing", () => {
    expect(applySdkconfigUpdates("", new Map([["CONFIG_A", "y"]]))).toBe("CONFIG_A=y\n");
  });
});

it("normalizes and validates keys", () => {
  expect(normalizeSdkconfigKey("freertos_hz")).toBe("CONFIG_FREERTOS_HZ");
  expect(normalizeSdkconfigKey("CONFIG_FREERTOS_HZ")).toBe("CONFIG_FREERTOS_HZ");
  expect(isSdkconfigKey("CONFIG_FREERTOS_HZ")).toBe(true);
  expect(isSdkconfigKey("CONFIG_BAD-KEY")).toBe(false);
});

it("reads choice groups from kconfig_menus.json", () => {
  const menus = JSON.stringify([
    {
      type: "menu",
      children: [
        {
          type: "choice",
          name: "ESPTOOLPY_FLASHSIZE",
          children: [
            { type: "bool", name: "ESPTOOLPY_FLASHSIZE_2MB", children: [] },
            { type: "bool", name: "ESPTOOLPY_FLASHSIZE_4MB", children: [] },
            { type: "comment", name: null, children: [] },
          ],
        },
        { type: "int", name: "FREERTOS_HZ", children: [] },
      ],
    },
  ]);
  const choices = parseKconfigChoices(menus);
  expect(choices.get("CONFIG_ESPTOOLPY_FLASHSIZE_4MB")).toEqual(["CONFIG_ESPTOOLPY_FLASHSIZE_2MB"]);
  expect(choices.has("CONFIG_FREERTOS_HZ")).toBe(false);
  expect(parseKconfigChoices("not json").size).toBe(0);
});
