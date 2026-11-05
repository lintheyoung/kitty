import { describe, expect, it } from "vite-plus/test";

import {
  classifyIdfVersion,
  classifyKicadVersion,
  matchesIdfPythonEnv,
  parseIdfVersionCmake,
  parseKicadCliVersion,
  selectSerialPorts,
} from "./toolchainVersions.ts";

describe("parseIdfVersionCmake", () => {
  it("reads the version ESP-IDF declares", () => {
    const text = [
      "set(IDF_VERSION_MAJOR 5)",
      "set(IDF_VERSION_MINOR 5)",
      "set(IDF_VERSION_PATCH 5)",
      "",
      'set(ENV{IDF_VERSION} "${IDF_VERSION_MAJOR}.${IDF_VERSION_MINOR}.${IDF_VERSION_PATCH}")',
    ].join("\n");
    expect(parseIdfVersionCmake(text)).toEqual({ major: 5, minor: 5, patch: 5 });
  });

  it("rejects a file missing a component", () => {
    expect(parseIdfVersionCmake("set(IDF_VERSION_MAJOR 5)\nset(IDF_VERSION_MINOR 5)")).toBe(
      undefined,
    );
  });
});

describe("parseKicadCliVersion", () => {
  it.each([
    ["10.0.7\n", { major: 10, minor: 0, patch: 7 }],
    ["9.0.1-1.fc40", { major: 9, minor: 0, patch: 1 }],
    ["", undefined],
  ])("parses %j", (output, expected) => {
    expect(parseKicadCliVersion(output)).toEqual(expected);
  });
});

describe("version policy", () => {
  it("accepts only the pinned ESP-IDF minor", () => {
    expect(classifyIdfVersion({ major: 5, minor: 5, patch: 0 })).toBe("ok");
    expect(classifyIdfVersion({ major: 5, minor: 4, patch: 2 })).toBe("warning");
  });

  it("accepts only the pinned KiCad major", () => {
    expect(classifyKicadVersion({ major: 10, minor: 0, patch: 7 })).toBe("ok");
    expect(classifyKicadVersion({ major: 9, minor: 0, patch: 3 })).toBe("warning");
  });

  it("matches the venv for the same ESP-IDF minor only", () => {
    const version = { major: 5, minor: 5, patch: 5 };
    expect(matchesIdfPythonEnv("idf5.5_py3.14_env", version)).toBe(true);
    expect(matchesIdfPythonEnv("idf5.4_py3.14_env", version)).toBe(false);
    expect(matchesIdfPythonEnv("idf5.55_py3.14_env", version)).toBe(false);
  });
});

describe("selectSerialPorts", () => {
  it("keeps USB serial devices and drops built-in macOS ports", () => {
    expect(
      selectSerialPorts(
        [
          "cu.usbmodem1101",
          "cu.Bluetooth-Incoming-Port",
          "cu.debug-console",
          "tty.usbmodem1101",
          "cu.wchusbserial5",
        ],
        "darwin",
      ),
    ).toEqual(["/dev/cu.usbmodem1101", "/dev/cu.wchusbserial5"]);
  });

  it("keeps ttyUSB and ttyACM on Linux", () => {
    expect(selectSerialPorts(["ttyS0", "ttyUSB0", "ttyACM1", "tty1"], "linux")).toEqual([
      "/dev/ttyACM1",
      "/dev/ttyUSB0",
    ]);
  });
});
