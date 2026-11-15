/** Kitty's own checks of a schematic's netlist, beyond what KiCad's ERC looks at. */
import type { KicadNetlist } from "./kicadReports.ts";

export interface SchematicAuditPoint {
  readonly type: string;
  readonly description: string;
  readonly fix: string;
}

const GROUND = /^\/?(GND|GNDA|GNDD|AGND|DGND|PGND|VSS|VSSA|EARTH)$/i;
const CAPACITOR = /^C\d/;
const CHIP = /^U\d/;
const CRYSTAL_REF = /^(Y|X|XTAL)\d/i;
const NAMED = 4;

const bare = (net: string) => net.replace(/^\//, "");
/** A capacitor's value without spaces, unit letter case or a trailing F: 22pF and 22p agree. */
const sameValue = (value: string) => value.replace(/\s+/g, "").replace(/f$/i, "").toLowerCase();

export function auditSchematic(netlist: KicadNetlist): ReadonlyArray<SchematicAuditPoint> {
  const valueOf = new Map(netlist.components.map((part) => [part.ref, part.value]));
  const netsOf = new Map<string, Array<string>>();
  for (const net of netlist.nets) {
    for (const node of net.nodes) {
      const nets = netsOf.get(node.ref) ?? [];
      nets.push(net.name);
      netsOf.set(node.ref, nets);
    }
  }
  /** Capacitors from this net to ground. */
  const capsToGround = (net: string) =>
    [...netsOf.entries()]
      .filter(
        ([ref, nets]) =>
          CAPACITOR.test(ref) && nets.includes(net) && nets.some((other) => GROUND.test(other)),
      )
      .map(([ref]) => ref);
  const points: SchematicAuditPoint[] = [];

  // Each chip on a supply net wants a capacitor of its own on that net.
  for (const net of netlist.nets) {
    if (GROUND.test(net.name)) continue;
    const chips = [
      ...new Set(
        net.nodes
          .filter(
            (node) =>
              CHIP.test(node.ref) && (node.type === "power_in" || node.type === "power_out"),
          )
          .map((node) => node.ref),
      ),
    ];
    if (chips.length === 0) continue;
    const caps = capsToGround(net.name);
    if (caps.length >= chips.length) continue;
    const who = `${chips.slice(0, NAMED).join(", ")}${chips.length > NAMED ? " and more" : ""}`;
    points.push({
      type: "audit_decoupling_missing",
      description:
        caps.length === 0
          ? `No decoupling capacitor on ${bare(net.name)}, which supplies ${who}`
          : `${chips.length} chips (${who}) share ${bare(net.name)} with ${caps.length} decoupling capacitor${caps.length === 1 ? "" : "s"}`,
      fix: `Give each chip its own capacitor from ${bare(net.name)} to ground, as its datasheet's typical application shows (100 nF at each supply pin, plus the bulk value a regulator's output asks for), and place it at that pin on the board.`,
    });
  }

  // A crystal wants a capacitor to ground on each side, and the two alike.
  for (const part of netlist.components) {
    if (!CRYSTAL_REF.test(part.ref)) continue;
    const sides = [...new Set((netsOf.get(part.ref) ?? []).filter((net) => !GROUND.test(net)))];
    if (sides.length !== 2) continue;
    const loads = sides.map((net) => capsToGround(net));
    const missing = sides.filter((_, index) => (loads[index]?.length ?? 0) === 0);
    if (missing.length > 0) {
      points.push({
        type: "audit_crystal_load",
        description: `${part.ref} has no load capacitor on ${missing.map(bare).join(" and ")}`,
        fix: `Put a capacitor from each side of ${part.ref} to ground. Its value comes from the crystal's load capacitance in its datasheet: about twice the load capacitance minus the stray capacitance of the pins and tracks.`,
      });
      continue;
    }
    const [first, second] = loads.map((caps) => caps[0]);
    if (!first || !second) continue;
    const [a, b] = [valueOf.get(first) ?? "", valueOf.get(second) ?? ""];
    if (sameValue(a) !== sameValue(b)) {
      points.push({
        type: "audit_crystal_load",
        description: `The load capacitors of ${part.ref} differ: ${first} is ${a}, ${second} is ${b}`,
        fix: `Make ${first} and ${second} the same value unless the crystal's datasheet asks for unequal ones; unequal loads pull the frequency off.`,
      });
    }
  }
  return points;
}
