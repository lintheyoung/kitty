import { describe, expect, it } from "vite-plus/test";

import { parseNetlist } from "./kicadReports.ts";
import {
  buildComponents,
  buildPinmap,
  checkPins,
  chipFamily,
  detectMcu,
  gpioFromPinName,
  scanFirmwarePins,
  schematicPins,
} from "./projectModel.ts";

// An ESP32-S3-WROOM-1 board: LED on IO48, BOOT button on IO0, USB on IO19/20,
// IO4 left unconnected, UART0 on TXD0/RXD0.
const NETLIST = `(export (components
  (comp (ref "U1") (value "ESP32-S3-WROOM-1-N16R8") (footprint "RF_Module:ESP32-S3-WROOM-1")
    (fields (field (name "LCSC") "C2913206")))
  (comp (ref "D1") (value "LED") (footprint "LED_SMD:LED_0603_1608Metric"))
  (comp (ref "R1") (value "1k") (footprint "Resistor_SMD:R_0402_1005Metric")
    (fields (field (name "LCSC") "C11702"))))
 (nets
  (net (name "/LED") (node (ref "U1") (pin "12") (pinfunction "IO48")) (node (ref "R1") (pin "1")))
  (net (name "/BOOT") (node (ref "U1") (pin "27") (pinfunction "IO0")) (node (ref "SW1") (pin "1")))
  (net (name "/USB_D-") (node (ref "U1") (pin "13") (pinfunction "IO19")) (node (ref "J1") (pin "A7")))
  (net (name "unconnected-(U1-IO4-Pad4)") (node (ref "U1") (pin "4") (pinfunction "IO4")))
  (net (name "/TX") (node (ref "U1") (pin "37") (pinfunction "TXD0")) (node (ref "J2") (pin "2")))
  (net (name "GND") (node (ref "U1") (pin "1") (pinfunction "GND")) (node (ref "D1") (pin "1")))))`;

const netlist = parseNetlist(NETLIST);
const mcu = detectMcu(netlist.components)!;

describe("pin names", () => {
  it("maps symbol pin names to GPIOs", () => {
    expect(gpioFromPinName("IO48")).toBe(48);
    expect(gpioFromPinName("GPIO4")).toBe(4);
    expect(gpioFromPinName("IO20/RXD")).toBe(20);
    expect(gpioFromPinName("TXD0", "esp32s3")).toBe(43);
    expect(gpioFromPinName("RXD0", "esp32c3")).toBe(20);
    expect(gpioFromPinName("GND")).toBeUndefined();
    expect(gpioFromPinName("EN")).toBeUndefined();
  });

  it("knows the chip family from the part", () => {
    expect(chipFamily("ESP32-S3-WROOM-1-N16R8")).toBe("esp32s3");
    expect(chipFamily("ESP32-C3-WROOM-02")).toBe("esp32c3");
    expect(chipFamily("ESP32-WROVER-E")).toBe("esp32");
    expect(chipFamily("STM32F103")).toBeUndefined();
  });
});

describe("pinmap", () => {
  it("finds the MCU and exports its GPIOs", () => {
    expect(mcu.ref).toBe("U1");
    expect(schematicPins(netlist, mcu)).toEqual([
      { gpio: 0, pin: "27", pin_name: "IO0", net: "/BOOT", connected: true, peers: ["SW1.1"] },
      {
        gpio: 4,
        pin: "4",
        pin_name: "IO4",
        net: "unconnected-(U1-IO4-Pad4)",
        connected: false,
        peers: [],
      },
      { gpio: 19, pin: "13", pin_name: "IO19", net: "/USB_D-", connected: true, peers: ["J1.A7"] },
      { gpio: 43, pin: "37", pin_name: "TXD0", net: "/TX", connected: true, peers: ["J2.2"] },
      { gpio: 48, pin: "12", pin_name: "IO48", net: "/LED", connected: true, peers: ["R1.1"] },
    ]);
  });

  it("keeps hand-written notes and reports what the schematic changed", () => {
    const pins = schematicPins(netlist, mcu);
    const first = buildPinmap(mcu, pins, "hardware/board.kicad_sch").pinmap;
    const annotated = {
      ...first,
      pins: first.pins.map((pin) =>
        pin.gpio === 48 ? { ...pin, function: "status LED", notes: "active high" } : pin,
      ),
    };
    const moved = pins
      .filter((pin) => pin.gpio !== 0)
      .map((pin) => (pin.gpio === 48 ? { ...pin, net: "/LED_STATUS" } : pin));
    const { pinmap, changes } = buildPinmap(mcu, moved, "hardware/board.kicad_sch", annotated);
    expect(pinmap.pins.find((pin) => pin.gpio === 48)).toMatchObject({
      net: "/LED_STATUS",
      function: "status LED",
      notes: "active high",
    });
    expect(changes).toEqual([
      { gpio: 0, change: "removed", before: "/BOOT" },
      { gpio: 48, change: "net_changed", before: "/LED", after: "/LED_STATUS" },
    ]);
  });
});

it("components.json keeps hand-added sources and alternates", () => {
  const first = buildComponents(netlist.components, "s.kicad_sch");
  expect(first.components.map((entry) => [entry.refs, entry.sources])).toEqual([
    [["D1"], []],
    [["R1"], [{ supplier: "LCSC", part_number: "C11702" }]],
    [["U1"], [{ supplier: "LCSC", part_number: "C2913206" }]],
  ]);
  const edited = {
    ...first,
    components: first.components.map((entry) =>
      entry.refs[0] === "D1"
        ? {
            ...entry,
            sources: [{ supplier: "Mouser", part_number: "710-150060VS75000" }],
            alternates: ["19-217/GHC-YR1S2/3T"],
          }
        : entry,
    ),
  };
  const again = buildComponents(netlist.components, "s.kicad_sch", edited);
  expect(again.components[0]).toMatchObject({
    refs: ["D1"],
    sources: [{ supplier: "Mouser", part_number: "710-150060VS75000" }],
    alternates: ["19-217/GHC-YR1S2/3T"],
  });
});

describe("firmware pins", () => {
  const files = [
    {
      path: "firmware/main/board.h",
      text: [
        "#define LED_PIN 48 // status LED",
        "#define BUTTON_GPIO GPIO_NUM_0",
        "// #define OLD_PIN 5",
        "#define I2C_SDA_PIN (4)",
        "#define TIMEOUT_MS 100",
      ].join("\n"),
    },
    {
      path: "firmware/main/main.c",
      text: "static const gpio_num_t usb_pin = GPIO_NUM_19;\ngpio_set_level(GPIO_NUM_21, 1);",
    },
    {
      path: "firmware/sdkconfig",
      text: [
        "CONFIG_BLINK_GPIO=48",
        'CONFIG_IDF_TARGET="esp32s3"',
        "CONFIG_SOC_GPIO_PIN_COUNT=49",
        "CONFIG_SOC_GPIO_PORT=1",
        "CONFIG_SOC_DEDIC_GPIO_OUT_CHANNELS_NUM=8",
        "CONFIG_ESP_CONSOLE_UART_NUM=0",
      ].join("\n"),
    },
  ];

  it("finds defines, constants, GPIO_NUM_n and Kconfig pins", () => {
    expect(scanFirmwarePins(files).map((use) => [use.gpio, use.name, use.at])).toEqual([
      [0, "BUTTON_GPIO", "firmware/main/board.h:2"],
      [4, "I2C_SDA_PIN", "firmware/main/board.h:4"],
      [19, "usb_pin", "firmware/main/main.c:1"],
      [21, "GPIO_NUM_21", "firmware/main/main.c:2"],
      [48, "LED_PIN", "firmware/main/board.h:1"],
      [48, "CONFIG_BLINK_GPIO", "firmware/sdkconfig:1"],
    ]);
  });

  it("reports unconnected, unknown, strapping and USB pins, and a stale pinmap", () => {
    const pins = schematicPins(netlist, mcu);
    const stale = buildPinmap(
      mcu,
      pins.map((pin) => (pin.gpio === 48 ? { ...pin, net: "/OLD_LED" } : pin)),
      "s",
    ).pinmap;
    const { issues, firmware } = checkPins({
      family: "esp32s3",
      schematic: pins,
      pinmap: stale,
      firmware: scanFirmwarePins(files),
    });
    expect(issues.map((issue) => [issue.severity, issue.kind, issue.gpio])).toEqual([
      ["error", "pinmap_stale", 48],
      ["error", "firmware_pin_unconnected", 4],
      ["error", "firmware_pin_unknown", 21],
      ["warning", "strapping_pin", 0],
      ["warning", "usb_pin", 19],
      ["warning", "pin_conflict", 48],
    ]);
    expect(firmware.find((use) => use.name === "LED_PIN")?.net).toBe("/LED");
  });
});
