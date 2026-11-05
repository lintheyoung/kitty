import type { HardwareSerialPort, HardwareSerialPortKind } from "@t3tools/contracts";

/**
 * Serial access goes through pyserial in ESP-IDF's Python environment (it is
 * always there with esptool), so Kitty needs no native Node modules.
 */

/** Prints the ports pyserial sees as JSON. */
export const LIST_PORTS_SCRIPT = `
import json, serial.tools.list_ports as lp
print(json.dumps([dict(device=p.device, vid=p.vid, pid=p.pid, serial=p.serial_number,
  description=p.description, manufacturer=p.manufacturer) for p in lp.comports()]))
`;

/**
 * Streams a port to stdout: argv = port, baud, reset (1/0), seconds (0 = until killed).
 * The port opens with DTR and RTS released so opening never resets the board or
 * holds it in the bootloader; a reset pulses RTS (EN) with DTR (IO0) high, the
 * same sequence idf.py monitor uses, which also works on native USB-Serial/JTAG.
 */
export const MONITOR_SCRIPT = `
import sys, time, serial
port, baud, reset, seconds = sys.argv[1], int(sys.argv[2]), sys.argv[3] == "1", float(sys.argv[4])
s = serial.Serial()
s.port, s.baudrate, s.timeout = port, baud, 0.05
s.dtr, s.rts = False, False
s.open()
if reset:
    try:
        s.rts = True
        time.sleep(0.1)
        s.rts = False
    except OSError:
        sys.stderr.write("kitty-monitor-reset-unsupported\\n")
sys.stderr.write("kitty-monitor-open\\n")
sys.stderr.flush()
end = time.time() + seconds if seconds > 0 else None
out = sys.stdout.buffer
while end is None or time.time() < end:
    data = s.read(4096)
    if data:
        out.write(data)
        out.flush()
`;

const KNOWN: ReadonlyArray<{
  readonly vid: number;
  readonly pids: ReadonlyArray<number> | "any";
  readonly kind: HardwareSerialPortKind;
  readonly label: string;
}> = [
  {
    vid: 0x303a,
    pids: [0x1001],
    kind: "esp-usb-jtag",
    label: "ESP32 native USB (USB-Serial/JTAG)",
  },
  { vid: 0x10c4, pids: [0xea60, 0xea70], kind: "cp210x", label: "CP210x USB-UART" },
  { vid: 0x1a86, pids: "any", kind: "ch34x", label: "CH34x/CH910x USB-UART" },
  { vid: 0x0403, pids: "any", kind: "ftdi", label: "FTDI USB-UART" },
];

function classifyPort(
  vid: number | undefined,
  pid: number | undefined,
): { kind: HardwareSerialPortKind; label: string } {
  const match = KNOWN.find(
    (known) => known.vid === vid && (known.pids === "any" || known.pids.includes(pid ?? -1)),
  );
  return match ? { kind: match.kind, label: match.label } : { kind: "other", label: "Serial port" };
}

const IGNORED_DEVICES = /(Bluetooth-Incoming-Port|debug-console|wlan-debug)$/;

/** Turns LIST_PORTS_SCRIPT output into Kitty's ports, boards first. */
export function parsePortList(json: string): Array<HardwareSerialPort> {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const ports: Array<HardwareSerialPort> = [];
  for (const entry of raw as ReadonlyArray<Record<string, unknown>>) {
    const device = typeof entry?.device === "string" ? entry.device : undefined;
    if (!device || IGNORED_DEVICES.test(device)) continue;
    // macOS lists every port twice; the call-out device (cu.*) is the one to open.
    if (device.startsWith("/dev/tty.")) continue;
    const vid = typeof entry.vid === "number" ? entry.vid : undefined;
    const pid = typeof entry.pid === "number" ? entry.pid : undefined;
    const serialNumber =
      typeof entry.serial === "string" && entry.serial ? entry.serial : undefined;
    const description =
      typeof entry.description === "string" && entry.description !== "n/a"
        ? entry.description
        : undefined;
    ports.push({
      device,
      ...classifyPort(vid, pid),
      ...(vid !== undefined ? { vid } : {}),
      ...(pid !== undefined ? { pid } : {}),
      ...(serialNumber ? { serialNumber } : {}),
      ...(description ? { description } : {}),
    });
  }
  const rank = (port: HardwareSerialPort) => (port.kind === "other" ? 1 : 0);
  return ports.toSorted((a, b) => rank(a) - rank(b) || a.device.localeCompare(b.device));
}

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** Keeps the last `maxChars` of a serial log, without colour codes. */
export function monitorTail(text: string, maxChars = 16_384): { text: string; truncated: boolean } {
  const clean = text.replace(ANSI, "").replaceAll("\r\n", "\n");
  return clean.length > maxChars
    ? { text: clean.slice(-maxChars), truncated: true }
    : { text: clean, truncated: false };
}
