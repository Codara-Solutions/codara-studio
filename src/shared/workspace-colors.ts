// Workspace colors serve as identifiers throughout the app, so automatic
// assignment should optimize for separation from the colors already on the
// rail instead of walking a short palette and eventually repeating its first
// entry. The curated palette remains the manual color picker's compact set;
// automatic assignment searches a much larger, vivid sRGB gamut below.
import type { Workspace, WorkspaceGroup } from "./types";

export const WORKSPACE_COLORS = [
  "#2AA298",
  "#7FB3FF",
  "#5BD68F",
  "#FF5C2B",
  "#C99BFF",
  "#E0E0E0",
  "#FF8FB1",
  "#5DD6D6",
] as const;

interface OklabColor {
  l: number;
  a: number;
  b: number;
}

interface ColorCandidate {
  hex: string;
  lab: OklabColor;
  tier: number;
}

const AUTO_COLOR_RINGS = [
  // Fill a cohesive mid-lightness ring before introducing lighter/darker
  // variants. That makes hue do the distinguishing on ordinary rails and
  // avoids selecting neon and pastel versions of one hue too early.
  { saturation: 68, lightness: 62 },
  { saturation: 60, lightness: 72 },
  { saturation: 72, lightness: 52 },
] as const;

function hueChannel(p: number, q: number, hue: number): number {
  let h = hue;
  if (h < 0) h += 1;
  if (h > 1) h -= 1;
  if (h < 1 / 6) return p + (q - p) * 6 * h;
  if (h < 1 / 2) return q;
  if (h < 2 / 3) return p + (q - p) * (2 / 3 - h) * 6;
  return p;
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const h = ((hue % 360) + 360) % 360 / 360;
  const s = saturation / 100;
  const l = lightness / 100;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channels = s === 0
    ? [l, l, l]
    : [hueChannel(p, q, h + 1 / 3), hueChannel(p, q, h), hueChannel(p, q, h - 1 / 3)];
  return `#${channels
    .map((channel) => Math.round(channel * 255).toString(16).padStart(2, "0"))
    .join("")}`.toUpperCase();
}

function parseHexColor(value: string): [number, number, number] | null {
  const match = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const digits = match[1];
  const expanded = digits.length === 3
    ? digits.split("").map((digit) => `${digit}${digit}`).join("")
    : digits;
  return [
    Number.parseInt(expanded.slice(0, 2), 16),
    Number.parseInt(expanded.slice(2, 4), 16),
    Number.parseInt(expanded.slice(4, 6), 16),
  ];
}

export function normalizeWorkspaceColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const rgb = parseHexColor(value);
  return rgb
    ? `#${rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`.toUpperCase()
    : null;
}

function rgbToHsl(red: number, green: number, blue: number): {
  hue: number;
  saturation: number;
  lightness: number;
} {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const lightness = (max + min) / 2;
  if (delta === 0) return { hue: 0, saturation: 0, lightness: lightness * 100 };
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue: number;
  if (max === r) hue = 60 * (((g - b) / delta) % 6);
  else if (max === g) hue = 60 * ((b - r) / delta + 2);
  else hue = 60 * ((r - g) / delta + 4);
  return {
    hue: (hue + 360) % 360,
    saturation: saturation * 100,
    lightness: lightness * 100,
  };
}

function srgbChannelToLinear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance([red, green, blue]: [number, number, number]): number {
  return (
    0.2126 * srgbChannelToLinear(red) +
    0.7152 * srgbChannelToLinear(green) +
    0.0722 * srgbChannelToLinear(blue)
  );
}

function rgbToHex([red, green, blue]: [number, number, number]): string {
  return `#${[red, green, blue]
    .map((channel) => Math.round(channel).toString(16).padStart(2, "0"))
    .join("")}`.toUpperCase();
}

function mixRgb(
  source: [number, number, number],
  target: [number, number, number],
  amount: number,
): [number, number, number] {
  return source.map(
    (channel, index) => channel + (target[index] - channel) * amount,
  ) as [number, number, number];
}

/** WCAG contrast ratio between two hex colors. Invalid values return 1. */
export function workspaceColorContrast(left: string, right: string): number {
  const leftRgb = parseHexColor(left);
  const rightRgb = parseHexColor(right);
  if (!leftRgb || !rightRgb) return 1;
  const lighter = Math.max(relativeLuminance(leftRgb), relativeLuminance(rightRgb));
  const darker = Math.min(relativeLuminance(leftRgb), relativeLuminance(rightRgb));
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Keep a workspace's chosen hue, but move it only as far toward the theme ink
 * as needed for small UI text. This lets arbitrary custom colors remain useful
 * identifiers without allowing near-black blue on a dark theme (or pale yellow
 * on a light theme) to make buttons and labels disappear.
 */
export function readableWorkspaceAccent(
  value: string,
  surface: string,
  themeInk: string,
  minimumContrast = 4.5,
): string {
  const source = parseHexColor(value);
  const background = parseHexColor(surface);
  const preferredTarget = parseHexColor(themeInk);
  if (!source || !background) return normalizeWorkspaceColor(value) ?? WORKSPACE_COLORS[0];

  const normalized = rgbToHex(source);
  if (workspaceColorContrast(normalized, rgbToHex(background)) >= minimumContrast) {
    return normalized;
  }

  const black: [number, number, number] = [0, 0, 0];
  const white: [number, number, number] = [255, 255, 255];
  const target = preferredTarget && workspaceColorContrast(rgbToHex(preferredTarget), rgbToHex(background)) >= minimumContrast
    ? preferredTarget
    : workspaceColorContrast("#000000", rgbToHex(background)) >=
        workspaceColorContrast("#FFFFFF", rgbToHex(background))
      ? black
      : white;

  // One-percent steps are visually finer than a color-picker adjustment and
  // avoid a binary-search result falling below the ratio after hex rounding.
  for (let step = 1; step <= 100; step += 1) {
    const candidate = rgbToHex(mixRgb(source, target, step / 100));
    if (workspaceColorContrast(candidate, rgbToHex(background)) >= minimumContrast) {
      return candidate;
    }
  }
  return rgbToHex(target);
}

/** Text color for controls whose fill is the resolved accessible accent. */
export function workspaceAccentInk(value: string): "#10100E" | "#FFFFFF" {
  return workspaceColorContrast(value, "#10100E") >= workspaceColorContrast(value, "#FFFFFF")
    ? "#10100E"
    : "#FFFFFF";
}

// OKLab is deliberately used for scoring rather than RGB/HSL distance: equal
// numerical steps track perceived color difference much more closely, which
// keeps a crowded rail from collapsing into several nearly identical greens.
function rgbToOklab(red: number, green: number, blue: number): OklabColor {
  const r = srgbChannelToLinear(red);
  const g = srgbChannelToLinear(green);
  const b = srgbChannelToLinear(blue);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function hexToOklab(value: string): OklabColor | null {
  const rgb = parseHexColor(value);
  return rgb ? rgbToOklab(...rgb) : null;
}

function distanceSquared(left: OklabColor, right: OklabColor): number {
  return (
    (left.l - right.l) ** 2 +
    (left.a - right.a) ** 2 +
    (left.b - right.b) ** 2
  );
}

function stableHash(value: string): number {
  // FNV-1a gives folder paths a cheap, stable influence without making color
  // assignment random between launches or platforms.
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function buildAutoColorCandidates(): ColorCandidate[] {
  const unique = new Map<string, ColorCandidate>();
  for (let tier = 0; tier < AUTO_COLOR_RINGS.length; tier += 1) {
    const ring = AUTO_COLOR_RINGS[tier];
    for (let hue = 0; hue < 360; hue += 1) {
      const hex = hslToHex(hue, ring.saturation, ring.lightness);
      const lab = hexToOklab(hex);
      if (lab && !unique.has(hex)) unique.set(hex, { hex, lab, tier });
    }
  }
  return [...unique.values()];
}

const AUTO_COLOR_CANDIDATES = buildAutoColorCandidates();

/**
 * Select a stable, unused workspace color whose nearest existing neighbor is
 * as far away as possible in OKLab. `identity` should be the workspace cwd;
 * it deterministically breaks equally good choices, so folder paths influence
 * their colors without sacrificing visual separation.
 */
export function pickWorkspaceColor(
  existingColors: readonly string[],
  identity: string,
): string {
  const used = new Set(existingColors.map((color) => color.trim().toUpperCase()));
  const existingLabs = existingColors
    .map(hexToOklab)
    .filter((color): color is OklabColor => color !== null);
  const availableTier = AUTO_COLOR_CANDIDATES.find((candidate) => !used.has(candidate.hex))?.tier;
  const availableCandidates = availableTier === undefined
    ? []
    : AUTO_COLOR_CANDIDATES.filter((candidate) => candidate.tier === availableTier);
  const offset = availableCandidates.length === 0
    ? 0
    : stableHash(identity.replace(/\\/g, "/")) % availableCandidates.length;
  let best: ColorCandidate | null = null;
  let bestNearestDistance = -1;

  for (let step = 0; step < availableCandidates.length; step += 1) {
    const candidate = availableCandidates[(offset + step) % availableCandidates.length];
    if (used.has(candidate.hex)) continue;
    const nearestDistance = existingLabs.length === 0
      ? 0
      : existingLabs.reduce(
          (nearest, color) => Math.min(nearest, distanceSquared(candidate.lab, color)),
          Number.POSITIVE_INFINITY,
        );
    // Keep the first candidate for effectively equal scores. Because iteration
    // begins at the cwd-derived offset, the folder only breaks perceptual ties;
    // maximum separation remains the primary rule.
    if (nearestDistance > bestNearestDistance + 1e-12) {
      best = candidate;
      bestNearestDistance = nearestDistance;
    }
  }

  if (best) return best.hex;

  // More than a thousand simultaneous workspaces is far beyond the supported
  // UI scale, but retain the uniqueness contract if that ever happens.
  for (let salt = 0; salt < 0x1000000; salt += 1) {
    const rgb = stableHash(`${identity}\0${salt}`) & 0xffffff;
    const hex = `#${rgb.toString(16).padStart(6, "0")}`.toUpperCase();
    if (!used.has(hex)) return hex;
  }
  return WORKSPACE_COLORS[0];
}

/** Add stable, mutually separated family colors to legacy/new folders. */
export function ensureWorkspaceGroupColors(
  groups: readonly WorkspaceGroup[],
): WorkspaceGroup[] {
  const used = groups
    .map((group) => normalizeWorkspaceColor(group.color))
    .filter((color): color is string => color !== null);
  return groups.map((group) => {
    const existing = normalizeWorkspaceColor(group.color);
    if (existing) return group.color === existing ? group : { ...group, color: existing };
    const color = pickWorkspaceColor(used, group.id);
    used.push(color);
    return { ...group, color };
  });
}

/**
 * Choose an unused lighter/darker shade of one folder's family color. Member
 * separation is scored first; colors outside the folder are also excluded so
 * the rail never contains exact duplicates.
 */
export function pickWorkspaceGroupShade(
  familyColor: string,
  memberColors: readonly string[],
  unavailableColors: readonly string[],
  identity: string,
): string {
  const family = normalizeWorkspaceColor(familyColor) ?? pickWorkspaceColor([], identity);
  const familyRgb = parseHexColor(family)!;
  const hsl = rgbToHsl(...familyRgb);
  const shadeSpecs = [
    [hsl.saturation, hsl.lightness],
    [Math.max(50, hsl.saturation - 10), 78],
    [Math.min(82, hsl.saturation + 8), 48],
    [Math.max(46, hsl.saturation - 16), 70],
    [Math.min(78, hsl.saturation + 4), 56],
    [Math.max(44, hsl.saturation - 20), 74],
    [Math.min(84, hsl.saturation + 10), 52],
    [Math.max(48, hsl.saturation - 14), 66],
    [Math.min(76, hsl.saturation + 2), 60],
    [Math.max(42, hsl.saturation - 22), 80],
    [Math.min(86, hsl.saturation + 12), 45],
    [Math.max(52, hsl.saturation - 8), 72],
  ] as const;
  const candidates = [...new Set(shadeSpecs.map(([saturation, lightness]) =>
    hslToHex(hsl.hue, saturation, lightness)))];
  const used = new Set(unavailableColors.map((color) => normalizeWorkspaceColor(color)).filter(Boolean));
  const memberLabs = memberColors
    .map(hexToOklab)
    .filter((color): color is OklabColor => color !== null);

  if (memberLabs.length === 0 && !used.has(family)) return family;

  const offset = stableHash(identity.replace(/\\/g, "/")) % candidates.length;
  let best: string | null = null;
  let bestDistance = -1;
  for (let step = 0; step < candidates.length; step += 1) {
    const candidate = candidates[(offset + step) % candidates.length];
    if (used.has(candidate)) continue;
    const lab = hexToOklab(candidate)!;
    const nearest = memberLabs.length === 0
      ? distanceSquared(lab, hexToOklab(family)!)
      : memberLabs.reduce(
          (distance, member) => Math.min(distance, distanceSquared(lab, member)),
          Number.POSITIVE_INFINITY,
        );
    if (nearest > bestDistance + 1e-12) {
      best = candidate;
      bestDistance = nearest;
    }
  }
  return best ?? pickWorkspaceColor(unavailableColors, identity);
}

/**
 * Build one folder's workspace shades in rail order. The first member is the
 * darkest and each following member is lighter, so position and color tell the
 * same story. The folder title itself keeps the exact family color.
 */
export function workspaceGroupShades(
  familyColor: string,
  count: number,
): string[] {
  if (count <= 0) return [];
  const family = normalizeWorkspaceColor(familyColor) ?? WORKSPACE_COLORS[0];
  if (count === 1) return [family];
  const hsl = rgbToHsl(...parseHexColor(family)!);
  // Keep the range readable in both themes even when a custom folder color is
  // almost black or almost white. Darker rows retain more chroma; the lower,
  // lighter rows soften slightly instead of turning neon.
  const darkest = Math.max(36, Math.min(58, hsl.lightness - 14));
  const lightest = Math.min(84, Math.max(72, hsl.lightness + 20));
  const darkSaturation = Math.max(52, Math.min(86, hsl.saturation + 5));
  const lightSaturation = Math.max(42, Math.min(72, hsl.saturation - 14));
  return Array.from({ length: count }, (_, index) => {
    const position = index / (count - 1);
    return hslToHex(
      hsl.hue,
      darkSaturation + (lightSaturation - darkSaturation) * position,
      darkest + (lightest - darkest) * position,
    );
  });
}

/** Apply folder shades to selected groups without disturbing loose workspaces. */
export function applyWorkspaceGroupShades(
  workspaces: readonly Workspace[],
  groups: readonly WorkspaceGroup[],
  selectedGroupIds?: readonly string[],
): Workspace[] {
  const selected = selectedGroupIds ? new Set(selectedGroupIds) : null;
  const assignments = new Map<string, string>();
  for (const group of ensureWorkspaceGroupColors(groups)) {
    if (selected && !selected.has(group.id)) continue;
    const members = workspaces.filter((workspace) => workspace.groupId === group.id);
    const shades = workspaceGroupShades(group.color!, members.length);
    members.forEach((workspace, index) => assignments.set(workspace.id, shades[index]));
  }
  let changed = false;
  const next = workspaces.map((workspace) => {
    const color = assignments.get(workspace.id);
    if (!color || workspace.color === color) return workspace;
    changed = true;
    return { ...workspace, color };
  });
  return changed ? next : (workspaces as Workspace[]);
}

/** Rebalance an entire rail into distinct folder families and global singles. */
export function rebalanceWorkspaceColors(
  workspaces: readonly Workspace[],
  groups: readonly WorkspaceGroup[],
): { workspaces: Workspace[]; groups: WorkspaceGroup[] } {
  const coloredGroups = ensureWorkspaceGroupColors(groups);
  const shadedWorkspaces = applyWorkspaceGroupShades(workspaces, coloredGroups);
  const assignments = new Map<string, string>();
  const usedColors: string[] = shadedWorkspaces
    .filter((workspace) => workspace.groupId)
    .map((workspace) => workspace.color);
  const validGroupIds = new Set(coloredGroups.map((group) => group.id));

  for (const workspace of shadedWorkspaces) {
    if (workspace.groupId && validGroupIds.has(workspace.groupId)) continue;
    const color = pickWorkspaceColor(usedColors, workspace.cwd || workspace.id);
    assignments.set(workspace.id, color);
    usedColors.push(color);
  }

  return {
    groups: coloredGroups,
    workspaces: shadedWorkspaces.map((workspace) => {
      const color = assignments.get(workspace.id);
      return color ? { ...workspace, color } : workspace;
    }),
  };
}

// Exported for focused regression tests and any future accessibility tooling.
export function workspaceColorDistance(left: string, right: string): number {
  const leftLab = hexToOklab(left);
  const rightLab = hexToOklab(right);
  return leftLab && rightLab ? Math.sqrt(distanceSquared(leftLab, rightLab)) : 0;
}

export function workspaceColorLightness(value: string): number {
  const rgb = parseHexColor(value);
  return rgb ? rgbToHsl(...rgb).lightness : 0;
}
