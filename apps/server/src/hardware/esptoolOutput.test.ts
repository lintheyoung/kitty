import { expect, it } from "vite-plus/test";

import { parseEsptoolChipInfo } from "./esptoolOutput.ts";

// Real esptool v4.12 `flash_id` output from a Waveshare ESP32-S3-Zero.
const FLASH_ID = `esptool.py v4.12.0
Serial port /dev/cu.usbmodem1301
Connecting...
Detecting chip type... ESP32-S3
Chip is ESP32-S3 (QFN56) (revision v0.2)
Features: WiFi, BLE, Embedded Flash 4MB (XMC), Embedded PSRAM 2MB (AP_3v3)
Crystal is 40MHz
USB mode: USB-Serial/JTAG
MAC: e8:06:90:94:eb:c0
Uploading stub...
Running stub...
Stub running...
Manufacturer: 20
Device: 4016
Detected flash size: 4MB
Flash type set in eFuse: quad (4 data lines)
Hard resetting via RTS pin...`;

it("reads chip, flash size and USB mode from esptool flash_id", () => {
  expect(parseEsptoolChipInfo(FLASH_ID, "/dev/cu.usbmodem1301")).toEqual({
    port: "/dev/cu.usbmodem1301",
    chip: "ESP32-S3 (QFN56) (revision v0.2)",
    features: "WiFi, BLE, Embedded Flash 4MB (XMC), Embedded PSRAM 2MB (AP_3v3)",
    mac: "e8:06:90:94:eb:c0",
    usbMode: "USB-Serial/JTAG",
    flashSize: "4MB",
  });
});

it("reads esptool v5 chip wording", () => {
  expect(
    parseEsptoolChipInfo("Chip type:          ESP32-S3 (QFN56) (revision v0.2)\n", "p")?.chip,
  ).toBe("ESP32-S3 (QFN56) (revision v0.2)");
});

it("returns nothing when the chip never answered", () => {
  expect(parseEsptoolChipInfo("A fatal error occurred: Failed to connect", "p")).toBe(undefined);
});
