import {
  type HardwareFirmwarePin,
  type HardwarePinChange,
  type HardwarePinIssue,
  KITTY_PROJECT_SCHEMA_VERSION,
  type KittyComponentEntry,
  type KittyComponents,
  type KittyPin,
  type KittyPinmap,
  type KicadComponent,
} from "@t3tools/contracts";

import { componentPins, type KicadNetlist } from "./kicadReports.ts";

export type ChipFamily = "esp32" | "esp32s2" | "esp32s3" | "esp32c3" | "esp32c6" | "esp32h2";

/** The chip family of an MCU or module part name, e.g. `ESP32-S3-WROOM-1-N16R8`. */
export function chipFamily(part: string): ChipFamily | undefined {
  const match = /ESP32[-_ ]?(S2|S3|C3|C6|H2)?/i.exec(part);
  if (!match) return undefined;
  const variant = match[1]?.toLowerCase();
  return variant ? (`esp32${variant}` as ChipFamily) : "esp32";
}

/** UART0 pins that module symbols name TXD0/RXD0 instead of IOn. */
const UART0_PINS: Partial<Record<ChipFamily, { tx: number; rx: number }>> = {
  esp32: { tx: 1, rx: 3 },
  esp32s2: { tx: 43, rx: 44 },
  esp32s3: { tx: 43, rx: 44 },
  esp32c3: { tx: 21, rx: 20 },
  esp32c6: { tx: 16, rx: 17 },
  esp32h2: { tx: 24, rx: 23 },
};

/** The GPIO a symbol pin name refers to: `IO48`, `GPIO4`, `IO20/RXD`, `TXD0`. */
export function gpioFromPinName(name: string, family?: ChipFamily): number | undefined {
  for (const part of name.split("/")) {
    const io = /^(?:GPIO|IO|P)(\d{1,2})$/i.exec(part.trim());
    if (io) return Number(io[1]);
  }
  const uart = family ? UART0_PINS[family] : undefined;
  if (uart && /^U?0?TXD0?$/i.test(name.trim())) return uart.tx;
  if (uart && /^U?0?RXD0?$/i.test(name.trim())) return uart.rx;
  return undefined;
}

const naturalCompare = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

/** The ESP32 chip or module on the schematic, preferring U references. */
export function detectMcu(components: ReadonlyArray<KicadComponent>): KicadComponent | undefined {
  const candidates = components.filter((component) =>
    chipFamily(`${component.value} ${component.footprint ?? ""}`),
  );
  return candidates.toSorted(
    (a, b) =>
      Number(!a.ref.startsWith("U")) - Number(!b.ref.startsWith("U")) ||
      naturalCompare(a.ref, b.ref),
  )[0];
}

/** GPIO pins of `mcu` from a fresh netlist. */
export function schematicPins(netlist: KicadNetlist, mcu: KicadComponent): Array<KittyPin> {
  const family = chipFamily(`${mcu.value} ${mcu.footprint ?? ""}`);
  const pins: Array<KittyPin> = [];
  for (const pin of componentPins(netlist, mcu.ref)) {
    const name = pin.function ?? pin.pin;
    const gpio = gpioFromPinName(name, family);
    if (gpio === undefined) continue;
    pins.push({
      gpio,
      pin: pin.pin,
      pin_name: name,
      net: pin.net,
      connected: pin.connected,
      peers: pin.others,
    });
  }
  return pins.toSorted((a, b) => a.gpio - b.gpio);
}

/** A new pinmap from the schematic, keeping hand-written `function` and `notes`. */
export function buildPinmap(
  mcu: KicadComponent,
  pins: ReadonlyArray<KittyPin>,
  schematic: string,
  previous?: KittyPinmap,
): { pinmap: KittyPinmap; changes: Array<HardwarePinChange> } {
  const before = new Map((previous?.pins ?? []).map((pin) => [pin.gpio, pin]));
  const changes: Array<HardwarePinChange> = [];
  const merged = pins.map((pin): KittyPin => {
    const old = before.get(pin.gpio);
    if (previous && !old) changes.push({ gpio: pin.gpio, change: "added", after: pin.net });
    if (old && old.net !== pin.net) {
      changes.push({ gpio: pin.gpio, change: "net_changed", before: old.net, after: pin.net });
    }
    return {
      ...pin,
      ...(old?.function ? { function: old.function } : {}),
      ...(old?.notes ? { notes: old.notes } : {}),
    };
  });
  const now = new Set(pins.map((pin) => pin.gpio));
  for (const old of previous?.pins ?? []) {
    if (!now.has(old.gpio)) changes.push({ gpio: old.gpio, change: "removed", before: old.net });
  }
  return {
    pinmap: {
      schema_version: KITTY_PROJECT_SCHEMA_VERSION,
      mcu: { ref: mcu.ref, part: mcu.value },
      source: { schematic },
      pins: merged,
    },
    changes: changes.toSorted((a, b) => a.gpio - b.gpio),
  };
}

const LCSC_FIELD = /^(lcsc|jlc)/i;
const MPN_FIELD = /^(mpn|manufacturer[ _]?part|mfr\.?[ _]?part|part[ _]?number|mfg[ _]?part)/i;
const MANUFACTURER_FIELD = /^(manufacturer|mfr|mfg)$/i;
const field = (fields: Readonly<Record<string, string>>, pattern: RegExp) =>
  Object.entries(fields).find(([name, value]) => pattern.test(name) && value.trim())?.[1];

/**
 * components.json from the schematic, grouped like a BOM. Hand-added sources
 * and alternates of a group (matched by its first reference) are kept.
 */
export function buildComponents(
  components: ReadonlyArray<KicadComponent>,
  schematic: string,
  previous?: KittyComponents,
): KittyComponents {
  const old = new Map<string, KittyComponentEntry>();
  for (const entry of previous?.components ?? []) {
    for (const ref of entry.refs) old.set(ref, entry);
  }
  const groups = new Map<string, KittyComponentEntry & { refs: Array<string> }>();
  for (const component of components) {
    if (component.excludeFromBom || component.ref.startsWith("#")) continue;
    const lcsc = field(component.fields, LCSC_FIELD);
    const mpn = field(component.fields, MPN_FIELD);
    const manufacturer = field(component.fields, MANUFACTURER_FIELD);
    const key = [component.value, component.footprint, lcsc, mpn, component.dnp].join("\u0000");
    const group = groups.get(key);
    if (group) {
      group.refs.push(component.ref);
      continue;
    }
    groups.set(key, {
      refs: [component.ref],
      value: component.value,
      ...(component.footprint ? { footprint: component.footprint } : {}),
      ...(manufacturer ? { manufacturer } : {}),
      ...(mpn ? { mpn } : {}),
      sources: lcsc ? [{ supplier: "LCSC", part_number: lcsc }] : [],
      dnp: component.dnp,
    });
  }
  const entries = [...groups.values()].map((group): KittyComponentEntry => {
    const refs = group.refs.toSorted(naturalCompare);
    const kept = refs.map((ref) => old.get(ref)).find(Boolean);
    const sources = [...group.sources];
    for (const source of kept?.sources ?? []) {
      if (!sources.some((existing) => existing.supplier === source.supplier)) sources.push(source);
    }
    return {
      ...group,
      refs,
      sources,
      ...(kept?.alternates?.length ? { alternates: kept.alternates } : {}),
      ...(kept?.datasheet ? { datasheet: kept.datasheet } : {}),
    };
  });
  return {
    schema_version: KITTY_PROJECT_SCHEMA_VERSION,
    source: { schematic },
    components: entries.toSorted((a, b) => naturalCompare(a.refs[0] ?? "", b.refs[0] ?? "")),
  };
}

const PIN_NAME =
  /(PIN|GPIO|SDA|SCL|TXD?|RXD?|LED|BTN|BUTTON|KEY|CS|MOSI|MISO|SCLK|SCK|INT|IRQ|RST|RESET|DC|PWM|ADC|EN)/i;
const DEFINE =
  /^\s*#\s*define\s+(\w+)\s+\(?\s*(?:\(gpio_num_t\)\s*)?(?:GPIO_NUM_)?(\d{1,2})\s*\)?\s*(?:\/[/*].*)?$/;
const ASSIGNMENT =
  /\b(?:static\s+)?(?:const\s+)?(?:gpio_num_t|int|uint8_t|uint32_t|int32_t)\s+(\w+)\s*=\s*\(?\s*(?:GPIO_NUM_)?(\d{1,2})\s*\)?\s*;/;
const GPIO_NUM = /\bGPIO_NUM_(\d{1,2})\b/g;
/** `CONFIG_BLINK_GPIO=48`; never the chip's `CONFIG_SOC_*` capability constants (pin counts). */
const SDKCONFIG_PIN = /^CONFIG_(?!SOC_)(\w*_(?:GPIO|PIN|IO)(?:_NUM)?)=(\d{1,2})$/;

/** GPIOs a firmware tree names: `#define LED_PIN 48`, `GPIO_NUM_4`, `CONFIG_BLINK_GPIO=48`. */
export function scanFirmwarePins(
  files: ReadonlyArray<{ readonly path: string; readonly text: string }>,
): Array<HardwareFirmwarePin> {
  const found: Array<HardwareFirmwarePin> = [];
  const seen = new Set<string>();
  const add = (gpio: number, name: string, at: string) => {
    const key = `${gpio}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ gpio, name, at });
  };
  for (const file of files) {
    const sdkconfig = /(^|\/)sdkconfig(\.defaults)?$/.test(file.path);
    file.text.split("\n").forEach((line, index) => {
      const at = `${file.path}:${index + 1}`;
      if (sdkconfig) {
        const match = SDKCONFIG_PIN.exec(line.trim());
        if (match) add(Number(match[2]), `CONFIG_${match[1]}`, at);
        return;
      }
      if (/^\s*(\/\/|\*)/.test(line)) return;
      const define = DEFINE.exec(line);
      if (define && PIN_NAME.test(define[1] ?? "")) {
        add(Number(define[2]), define[1] ?? "", at);
        return;
      }
      const assignment = ASSIGNMENT.exec(line);
      if (assignment && PIN_NAME.test(assignment[1] ?? "")) {
        add(Number(assignment[2]), assignment[1] ?? "", at);
        return;
      }
      for (const match of line.matchAll(GPIO_NUM))
        add(Number(match[1]), `GPIO_NUM_${match[1]}`, at);
    });
  }
  return found.toSorted((a, b) => a.gpio - b.gpio || a.at.localeCompare(b.at));
}

const STRAPPING: Partial<Record<ChipFamily, ReadonlyArray<number>>> = {
  esp32: [0, 2, 5, 12, 15],
  esp32s2: [0, 45, 46],
  esp32s3: [0, 3, 45, 46],
  esp32c3: [2, 8, 9],
  esp32c6: [8, 9, 15],
  esp32h2: [8, 9, 25],
};
const USB_PINS: Partial<Record<ChipFamily, ReadonlyArray<number>>> = {
  esp32s2: [19, 20],
  esp32s3: [19, 20],
  esp32c3: [18, 19],
  esp32c6: [12, 13],
  esp32h2: [26, 27],
};

/**
 * Checks firmware pins against the schematic, and the pinmap against the
 * schematic. `schematic` holds the MCU's GPIO pins from a fresh netlist.
 */
export function checkPins(input: {
  readonly family: ChipFamily | undefined;
  readonly schematic: ReadonlyArray<KittyPin>;
  readonly pinmap: KittyPinmap | undefined;
  readonly firmware: ReadonlyArray<HardwareFirmwarePin>;
}): { issues: Array<HardwarePinIssue>; firmware: Array<HardwareFirmwarePin> } {
  const issues: Array<HardwarePinIssue> = [];
  const byGpio = new Map(input.schematic.map((pin) => [pin.gpio, pin]));

  if (!input.pinmap) {
    issues.push({
      severity: "warning",
      kind: "pinmap_stale",
      message: "No hardware/pinmap.json yet. Run hw_pinmap_sync to export it from the schematic.",
    });
  } else {
    for (const pin of input.pinmap.pins) {
      const now = byGpio.get(pin.gpio);
      if (!now) {
        issues.push({
          severity: "error",
          kind: "pinmap_stale",
          gpio: pin.gpio,
          message: `pinmap.json lists GPIO${pin.gpio} (${pin.net}), but the schematic's MCU has no such pin. Run hw_pinmap_sync.`,
        });
      } else if (now.net !== pin.net) {
        issues.push({
          severity: "error",
          kind: "pinmap_stale",
          gpio: pin.gpio,
          message: `GPIO${pin.gpio} is on ${now.net} in the schematic but ${pin.net} in pinmap.json. Run hw_pinmap_sync before writing code from it.`,
        });
      }
    }
  }

  const names = new Map<number, Set<string>>();
  const firmware = input.firmware.map((use): HardwareFirmwarePin => {
    const pin = byGpio.get(use.gpio);
    names.set(use.gpio, (names.get(use.gpio) ?? new Set()).add(use.name));
    if (!pin) {
      issues.push({
        severity: "error",
        kind: "firmware_pin_unknown",
        gpio: use.gpio,
        message: `${use.name} uses GPIO${use.gpio}, which the schematic's MCU does not expose.`,
        at: use.at,
      });
      return use;
    }
    if (!pin.connected) {
      issues.push({
        severity: "error",
        kind: "firmware_pin_unconnected",
        gpio: use.gpio,
        message: `${use.name} uses GPIO${use.gpio}, which is not connected to anything in the schematic.`,
        at: use.at,
      });
    }
    if (input.family && STRAPPING[input.family]?.includes(use.gpio)) {
      issues.push({
        severity: "warning",
        kind: "strapping_pin",
        gpio: use.gpio,
        message: `GPIO${use.gpio} is a strapping pin: its level at reset selects the boot mode. Make sure ${pin.net} does not hold it the wrong way.`,
        at: use.at,
      });
    }
    if (input.family && USB_PINS[input.family]?.includes(use.gpio)) {
      issues.push({
        severity: "warning",
        kind: "usb_pin",
        gpio: use.gpio,
        message: `GPIO${use.gpio} is a native USB data line; using it as GPIO disconnects USB flashing and logging.`,
        at: use.at,
      });
    }
    return { ...use, net: pin.net };
  });
  for (const [gpio, used] of names) {
    if (used.size > 1) {
      issues.push({
        severity: "warning",
        kind: "pin_conflict",
        gpio,
        message: `GPIO${gpio} has several names in the firmware (${[...used].join(", ")}); check they mean the same signal.`,
      });
    }
  }
  const rank = (issue: HardwarePinIssue) => (issue.severity === "error" ? 0 : 1);
  return { issues: issues.toSorted((a, b) => rank(a) - rank(b)), firmware };
}
