import { describe, expect, it } from "vite-plus/test";

import { boardWriteDenial, findBoardWrite } from "./boardWriteGuard.ts";

describe("findBoardWrite", () => {
  it.each([
    "idf.py flash",
    "idf.py -p /dev/cu.usbmodem1301 -b 460800 flash monitor",
    'cd firmware && . "$IDF_PATH/export.sh" && idf.py build flash',
    "idf.py erase-flash",
    "/Users/me/esp/esp-idf/tools/idf.py app-flash",
    "esptool.py --chip esp32s3 -p /dev/cu.usbmodem1301 write_flash 0x0 build/app.bin",
    "python -m esptool --port /dev/ttyUSB0 erase_flash",
    "esptool erase-region 0x9000 0x6000",
    "IDF_PATH=/opt/idf python3 /opt/idf/tools/idf.py flash",
    "bash -c 'idf.py -p /dev/ttyUSB0 flash'",
    "sudo esptool.py write_flash 0 fw.bin",
  ])("blocks a flash: %s", (line) => {
    expect(findBoardWrite(line)?.kind).toBe("flash");
  });

  it.each([
    "espefuse.py --port /dev/ttyUSB0 burn_efuse JTAG_DISABLE",
    "python -m espefuse burn-key BLOCK_KEY0 key.bin",
    "idf.py efuse-burn --do-not-confirm",
  ])("blocks an eFuse burn: %s", (line) => {
    expect(findBoardWrite(line)?.kind).toBe("efuse");
  });

  it.each([
    "idf.py build",
    "idf.py -p /dev/cu.usbmodem1301 monitor",
    "idf.py set-target esp32s3",
    "esptool.py --port /dev/cu.usbmodem1301 read_flash 0 0x400000 backup.bin",
    "python -m esptool flash_id",
    "espefuse.py summary",
    "grep -r 'idf.py flash' docs/",
    "echo flash",
    "git commit -m 'flash fix'",
  ])("allows %s", (line) => {
    expect(findBoardWrite(line)).toBeUndefined();
  });
});

it("tells the agent what to do instead", () => {
  const write = findBoardWrite("idf.py build && idf.py -p X flash");
  expect(write?.command).toBe("idf.py -p X flash");
  expect(boardWriteDenial(write!)).toContain("hw_flash");
  expect(boardWriteDenial({ kind: "efuse", command: "espefuse.py burn_efuse X" })).toContain(
    "cannot be undone",
  );
});
