import type { KittyBoard, KittyPinmap } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boardTestProject, boardTestSettings, parseI2cAddress } from "./boardTestFirmware.ts";
import { parseTestPlan } from "./boardTests.ts";

const board = (overrides: Partial<KittyBoard>): KittyBoard => ({
  schema_version: "0.1",
  board_id: "b",
  name: "B",
  mcu: { vendor: "Espressif", model: "ESP32-S3" },
  ...overrides,
});

const pin = (gpio: number, net: string, connected = true) => ({
  gpio,
  pin: String(gpio),
  pin_name: `IO${gpio}`,
  net,
  connected,
  peers: [],
});

describe("Board Test Firmware", () => {
  it("reads I2C addresses in the usual spellings", () => {
    expect(parseI2cAddress("0x6B")).toBe(0x6b);
    expect(parseI2cAddress("68h")).toBe(0x68);
    expect(parseI2cAddress("104")).toBe(104);
    expect(parseI2cAddress("0x02")).toBeUndefined();
    expect(parseI2cAddress("SPI")).toBeUndefined();
    expect(parseI2cAddress(undefined)).toBeUndefined();
  });

  it("takes the bus from board.json first and knows common IMUs", () => {
    const settings = boardTestSettings(
      board({
        interfaces: { i2c: [{ name: "sensors", sda: 8, scl: 9 }] },
        peripherals: [
          { name: "IMU", type: "imu", address: "0x68", part: "MPU-6050" },
          { name: "Display", type: "display", interface: "spi", address: "0x3c" },
        ],
      }),
      undefined,
    );
    expect(settings.i2c).toMatchObject({ sda: 8, scl: 9 });
    expect(settings.devices).toEqual([{ name: "IMU", address: 0x68 }]);
    expect(settings.imu).toEqual({ name: "IMU", address: 0x68, register: 0x75, id: 0x68 });
  });

  it("finds the bus from the schematic's SDA/SCL nets", () => {
    const pinmap: KittyPinmap = {
      schema_version: "0.1",
      mcu: { ref: "U1", part: "ESP32-S3-WROOM-1" },
      source: { schematic: "hw.kicad_sch" },
      pins: [pin(4, "/I2C_SDA"), pin(5, "/I2C_SCL"), pin(6, "SDA2", false)],
    };
    expect(boardTestSettings(undefined, pinmap).i2c).toMatchObject({ sda: 4, scl: 5 });
    expect(boardTestSettings(undefined, undefined)).toEqual({ devices: [] });
  });

  it("writes a plan the runner accepts, with a case per known device", () => {
    const project = boardTestProject({
      product: "KeyCAP",
      target: "esp32s3",
      firmwareDir: "tests/board-test",
      settings: {
        i2c: { sda: 8, scl: 9, from: "board.json" },
        devices: [{ name: "IMU", address: 0x6b }],
        imu: { name: "IMU", address: 0x6b, register: 0x0f },
      },
    });
    const parsed = parseTestPlan(project.plan);
    if (!("plan" in parsed)) throw new Error(parsed.errors.join("\n"));
    expect(parsed.plan.cases.map((testCase) => testCase.id)).toEqual([
      "boot",
      "flash",
      "heap",
      "i2c_bus",
      "i2c_0x6b",
      "imu_id",
    ]);
    expect(parsed.plan.cases[0]?.expect?.equals).toBe("ESP32-S3");
    // An unknown IMU gets a reported-only case and a hint to fill the value in.
    expect(parsed.plan.cases[5]?.expect).toBeUndefined();
    expect(project.plan).toContain("Set the WHO_AM_I value from the datasheet");
    expect(project.firmware["sdkconfig.defaults"]).toContain("CONFIG_KITTY_TEST_IMU_ADDR=0x6b");
  });
});
