import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { KeepAwakeBattery } from "@shared/keep-awake";

// The battery as the lid hold needs it (controller.ts): on battery power or
// not, and its charge. Only Linux offers the lid hold, and there the kernel
// lists every power supply under /sys/class/power_supply: the laptop's
// batteries (type Battery, scope System or none), its mains adapter (type
// Mains) and the batteries of a mouse or a headset (scope Device), which do
// not count.

export const POWER_SUPPLY_DIR = "/sys/class/power_supply";

export interface PowerSupplyProbe {
  /** Entries of a directory, or [] when it cannot be read. */
  readDir(path: string): string[];
  /** A file's text, or "" when it cannot be read. */
  readFile(path: string): string;
}

export interface LinuxPowerReading {
  /** At least one system battery is present. */
  hasBattery: boolean;
  /** Charge in percent over all system batteries, or null. */
  level: number | null;
  /** A battery reports Charging. */
  charging: boolean;
  /** A battery reports Discharging. Full, Not charging and Unknown say neither. */
  discharging: boolean;
  /** A mains adapter reports online (1) or offline (0); null without one. */
  mainsOnline: boolean | null;
}

function number(text: string): number | null {
  const value = Number.parseFloat(text.trim());
  return Number.isFinite(value) ? value : null;
}

export function readLinuxPower(probe: PowerSupplyProbe, dir = POWER_SUPPLY_DIR): LinuxPowerReading {
  const reading: LinuxPowerReading = {
    hasBattery: false,
    level: null,
    charging: false,
    discharging: false,
    mainsOnline: null,
  };
  let energyNow = 0;
  let energyFull = 0;
  let energyComplete = true;
  const capacities: number[] = [];
  for (const name of probe.readDir(dir)) {
    const field = (file: string) => probe.readFile(join(dir, name, file)).trim();
    const type = field("type");
    if (type === "Mains") {
      const online = field("online");
      if (online === "1") reading.mainsOnline = true;
      else if (online === "0" && reading.mainsOnline === null) reading.mainsOnline = false;
      continue;
    }
    if (type !== "Battery" || field("scope") === "Device") continue;
    if (field("present") === "0") continue;
    reading.hasBattery = true;
    const status = field("status");
    if (status === "Charging") reading.charging = true;
    else if (status === "Discharging") reading.discharging = true;
    const capacity = number(field("capacity"));
    if (capacity !== null) capacities.push(Math.max(0, Math.min(100, capacity)));
    // Two batteries drain one after the other: their joint charge is the
    // sum of what they hold, not the mean of their percentages.
    const now = number(field("energy_now")) ?? number(field("charge_now"));
    const full = number(field("energy_full")) ?? number(field("charge_full"));
    if (now !== null && full !== null && full > 0) {
      energyNow += now;
      energyFull += full;
    } else {
      energyComplete = false;
    }
  }
  if (energyComplete && energyFull > 0) {
    reading.level = Math.max(0, Math.min(100, Math.round((energyNow / energyFull) * 100)));
  } else if (capacities.length) {
    reading.level = Math.round(capacities.reduce((sum, value) => sum + value, 0) / capacities.length);
  }
  return reading;
}

/**
 * The battery for the controller, or null without one. The kernel's own
 * report wins; Electron's powerMonitor (UPower) answers when the kernel's is
 * unclear, such as a battery that reports Unknown. A battery that drains
 * counts as on battery even with an adapter plugged in: a charger too weak
 * for the load still lets it run flat.
 */
export function batteryFrom(reading: LinuxPowerReading, electronOnBattery: boolean): KeepAwakeBattery | null {
  if (!reading.hasBattery) return null;
  let onBattery: boolean;
  if (reading.discharging) onBattery = true;
  else if (reading.charging) onBattery = false;
  else if (reading.mainsOnline !== null) onBattery = !reading.mainsOnline;
  else onBattery = electronOnBattery;
  return { onBattery, level: reading.level };
}

export function systemPowerSupplyProbe(): PowerSupplyProbe {
  return {
    readDir: (path) => {
      try {
        return readdirSync(path);
      } catch {
        return [];
      }
    },
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return "";
      }
    },
  };
}
