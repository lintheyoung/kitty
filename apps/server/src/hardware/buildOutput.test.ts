import { describe, expect, it } from "vite-plus/test";

import { logTail, parseAppBinarySize, parseBuildDiagnostics } from "./buildOutput.ts";

// Excerpts of real ESP-IDF v5.5.5 `idf.py build` output for an ESP32-S3 project,
// with local paths replaced.
const PROJECT = "/work/app";
const XTENSA_LD =
  "/home/u/.espressif/tools/xtensa-esp-elf/esp-14.2.0_20260121/xtensa-esp-elf/bin/../lib/gcc/xtensa-esp-elf/14.2.0/../../../../xtensa-esp-elf/bin/ld";

const COMPILE_LOG = `[8/10] Building C object esp-idf/main/CMakeFiles/__idf_main.dir/hello_world_main.c.obj
FAILED: esp-idf/main/CMakeFiles/__idf_main.dir/hello_world_main.c.obj
/work/app/main/hello_world_main.c: In function 'app_main':
/work/app/main/hello_world_main.c:20:5: error: implicit declaration of function 'undefined_function_xyz' [-Wimplicit-function-declaration]
   20 |     undefined_function_xyz(42);
      |     ^~~~~~~~~~~~~~~~~~~~~~
/work/app/main/hello_world_main.c:21:20: error: 'GPIO_NUM_2' undeclared (first use in this function)
/work/app/main/hello_world_main.c:21:20: note: each undeclared identifier is reported only once for each function it appears in
/work/app/main/hello_world_main.c:19:9: warning: unused variable 'unused_var' [-Wunused-variable]
/opt/esp-idf/components/log/include/esp_log.h:10:1: \u001b[01;31merror: \u001b[mbroken include
ninja: build stopped: subcommand failed.`;

const LINK_LOG = `[10/12] Linking CXX executable hello_world.elf
FAILED: hello_world.elf
${XTENSA_LD}: esp-idf/main/libmain.a(hello_world_main.c.obj):(.literal.app_main+0x40): undefined reference to \`kitty_missing_symbol'
${XTENSA_LD}: esp-idf/main/libmain.a(hello_world_main.c.obj): in function \`app_main':
/work/app/main/hello_world_main.c:21:(.text.app_main+0xc): undefined reference to \`kitty_missing_symbol'
collect2: error: ld returned 1 exit status
ninja: build stopped: subcommand failed.`;

const CMAKE_LOG = `CMake Error at /opt/esp-idf/tools/cmake/component.cmake:231 (message):
  CMake Warning (dev) at build_properties.temp.cmake:8:

    Syntax Warning in cmake code at column 106

  CMake Error at
  /work/app/main/CMakeLists.txt:4:

    Parse error.  Function missing ending ")".  End of file reached.

  Call Stack (most recent call first):

    /opt/esp-idf/tools/cmake/scripts/component_get_requirements.cmake:107 (include)

Call Stack (most recent call first):
  CMakeLists.txt:8 (project)

-- Configuring incomplete, errors occurred!`;

describe("parseBuildDiagnostics", () => {
  it("reports compiler errors before warnings, relative to the project, without notes", () => {
    expect(parseBuildDiagnostics(COMPILE_LOG, PROJECT)).toEqual([
      {
        severity: "error",
        source: "compiler",
        file: "main/hello_world_main.c",
        line: 20,
        column: 5,
        message:
          "implicit declaration of function 'undefined_function_xyz' [-Wimplicit-function-declaration]",
      },
      {
        severity: "error",
        source: "compiler",
        file: "main/hello_world_main.c",
        line: 21,
        column: 20,
        message: "'GPIO_NUM_2' undeclared (first use in this function)",
      },
      {
        severity: "error",
        source: "compiler",
        file: "/opt/esp-idf/components/log/include/esp_log.h",
        line: 10,
        column: 1,
        message: "broken include",
      },
      {
        severity: "warning",
        source: "compiler",
        file: "main/hello_world_main.c",
        line: 19,
        column: 9,
        message: "unused variable 'unused_var' [-Wunused-variable]",
      },
    ]);
  });

  it("reports each undefined symbol once, at its source line", () => {
    expect(parseBuildDiagnostics(LINK_LOG, PROJECT)).toEqual([
      {
        severity: "error",
        source: "linker",
        file: "main/hello_world_main.c",
        line: 21,
        message: "undefined reference to 'kitty_missing_symbol'",
      },
    ]);
  });

  it("keeps the project's CMake error and drops ESP-IDF's wrappers around it", () => {
    expect(parseBuildDiagnostics(CMAKE_LOG, PROJECT)).toEqual([
      {
        severity: "error",
        source: "cmake",
        file: "main/CMakeLists.txt",
        line: 4,
        message: 'Parse error.  Function missing ending ")".  End of file reached.',
      },
    ]);
  });
});

describe("parseAppBinarySize", () => {
  it("reads the app size line", () => {
    expect(
      parseAppBinarySize(
        "hello_world.bin binary size 0x27980 bytes. Smallest app partition is 0x100000 bytes. 0xd8680 bytes (85%) free.",
      ),
    ).toEqual({ sizeBytes: 0x27980, partitionBytes: 0x100000, freePercent: 85 });
  });
});

it("logTail keeps the last lines", () => {
  expect(logTail("a\nb\nc\n", 2)).toBe("b\nc");
});
