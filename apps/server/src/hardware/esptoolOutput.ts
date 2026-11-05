import type { HardwareChipInfo } from "@t3tools/contracts";

const pick = (output: string, pattern: RegExp) => pattern.exec(output)?.[1]?.trim();

/** Reads `esptool flash_id` output (esptool v4 and v5 wording). */
export function parseEsptoolChipInfo(output: string, port: string): HardwareChipInfo | undefined {
  const chip = pick(output, /^Chip is (.+)$/m) ?? pick(output, /^Chip type:\s+(.+)$/m);
  if (!chip) return undefined;
  const features = pick(output, /^Features:\s+(.+)$/m);
  const mac = pick(output, /^MAC:\s+([0-9a-f:]{17})/im);
  const usbMode = pick(output, /^USB mode:\s+(.+)$/m);
  const flashSize = pick(output, /^Detected flash size:\s+(\S+)/m);
  return {
    port,
    chip,
    ...(features ? { features } : {}),
    ...(mac ? { mac } : {}),
    ...(usbMode ? { usbMode } : {}),
    ...(flashSize ? { flashSize } : {}),
  };
}
