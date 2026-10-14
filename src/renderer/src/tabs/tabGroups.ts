// Tab groups: a named, colored run of adjacent tabs in one workspace's strip,
// like Chrome's. Pure so the rules are testable without the app
// (scripts/test-tab-groups.cjs).
//
// Every member tab carries the whole group record rather than an id into a
// side table. A group then persists, reloads and moves between workspace
// layouts with the tab list alone, and a closed tab takes its membership with
// it. normalizeTabGroups is the one place that keeps the copies equal and the
// members adjacent; every write below ends with it.

import { makeId } from "@shared/ids";
import { normalizeTabGroupName, tabGroupNameKey } from "@shared/tab-group-name";
import { moveTabInList } from "./tabReorder";
import type { Tab, TabGroup, TabGroupColor, TabId } from "./types";

export { normalizeTabGroupName, tabGroupNameKey };

// The order Chrome's group editor shows them in.
export const TAB_GROUP_COLORS: readonly TabGroupColor[] = [
  "grey",
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
];

// A new group takes the first of these no group in its workspace uses. Grey
// comes last: next to the others it reads as no color at all.
const ASSIGN_ORDER: readonly TabGroupColor[] = [
  "blue",
  "red",
  "yellow",
  "green",
  "pink",
  "purple",
  "cyan",
  "orange",
  "grey",
];

const GROUP_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,80}$/;

export function isTabGroupColor(value: unknown): value is TabGroupColor {
  return typeof value === "string" && (TAB_GROUP_COLORS as readonly string[]).includes(value);
}

// A group record read from storage or another layout, or null when it cannot
// be one. An unknown color falls back to grey rather than dropping the group.
export function sanitizeTabGroup(value: unknown): TabGroup | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !GROUP_ID_PATTERN.test(record.id)) return null;
  return {
    id: record.id,
    name: normalizeTabGroupName(record.name),
    color: isTabGroupColor(record.color) ? record.color : "grey",
    ...(record.collapsed === true ? { collapsed: true } : {}),
  };
}

function sameRecord(a: TabGroup, b: TabGroup): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.color === b.color &&
    Boolean(a.collapsed) === Boolean(b.collapsed)
  );
}

function withoutGroup(tab: Tab): Tab {
  const { group: _group, ...rest } = tab;
  return rest as Tab;
}

export function withTabGroup(tab: Tab, group: TabGroup | null): Tab {
  if (!group) return tab.group === undefined && !("group" in tab) ? tab : withoutGroup(tab);
  return tab.group && sameRecord(tab.group, group) ? tab : ({ ...tab, group } as Tab);
}

function sameList(a: readonly Tab[], b: readonly Tab[]): boolean {
  return a.length === b.length && a.every((tab, index) => tab === b[index]);
}

// The first member's record wins for every member, an unreadable record makes
// its tab ungrouped, and each group's members are gathered at the position of
// its first member. Returns the same array when nothing changes.
export function normalizeTabGroups(tabs: Tab[]): Tab[] {
  const records = new Map<string, TabGroup>();
  const fixed = tabs.map((tab) => {
    if (!("group" in tab)) return tab;
    const parsed = tab.group === undefined ? null : sanitizeTabGroup(tab.group);
    if (!parsed) return withoutGroup(tab);
    let canonical = records.get(parsed.id);
    if (!canonical) {
      canonical = parsed;
      records.set(parsed.id, parsed);
    }
    return tab.group && sameRecord(tab.group, canonical) ? tab : ({ ...tab, group: canonical } as Tab);
  });
  const members = new Map<string, Tab[]>();
  for (const tab of fixed) {
    const id = tab.group?.id;
    if (!id) continue;
    const list = members.get(id);
    if (list) list.push(tab);
    else members.set(id, [tab]);
  }
  const ordered: Tab[] = [];
  const placed = new Set<string>();
  for (const tab of fixed) {
    const id = tab.group?.id;
    if (!id) {
      ordered.push(tab);
    } else if (!placed.has(id)) {
      placed.add(id);
      ordered.push(...(members.get(id) ?? []));
    }
  }
  return sameList(ordered, tabs) ? tabs : ordered;
}

export function tabGroupById(tabs: readonly Tab[], groupId: string): TabGroup | null {
  return tabs.find((tab) => tab.group?.id === groupId)?.group ?? null;
}

export function tabGroupMembers(tabs: readonly Tab[], groupId: string): Tab[] {
  return tabs.filter((tab) => tab.group?.id === groupId);
}

// Every group in a layout, once each, in strip order.
export function tabGroupsIn(tabs: readonly Tab[]): TabGroup[] {
  const seen = new Set<string>();
  const groups: TabGroup[] = [];
  for (const tab of tabs) {
    if (!tab.group || seen.has(tab.group.id)) continue;
    seen.add(tab.group.id);
    groups.push(tab.group);
  }
  return groups;
}

export function findTabGroupByName(groups: readonly TabGroup[], name: unknown): TabGroup | null {
  const key = tabGroupNameKey(name);
  if (!key) return null;
  return groups.find((group) => tabGroupNameKey(group.name) === key) ?? null;
}

export function nextTabGroupColor(groups: readonly TabGroup[]): TabGroupColor {
  const counts = new Map<TabGroupColor, number>();
  for (const group of groups) counts.set(group.color, (counts.get(group.color) ?? 0) + 1);
  let best = ASSIGN_ORDER[0];
  for (const color of ASSIGN_ORDER) {
    if ((counts.get(color) ?? 0) < (counts.get(best) ?? 0)) best = color;
  }
  return best;
}

export function newTabGroup(
  name: unknown,
  existing: readonly TabGroup[],
  color?: TabGroupColor,
): TabGroup {
  return {
    id: makeId("tabgroup"),
    name: normalizeTabGroupName(name),
    color: color ?? nextTabGroupColor(existing),
  };
}

// Put one tab into `group`, at the end of the group's other members, or take
// it out of its group (null), just after the members it leaves. A group with
// no other member yet keeps the tab where it is.
export function moveTabToGroup(tabs: Tab[], tabId: TabId, group: TabGroup | null): Tab[] {
  const index = tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return tabs;
  const tab = tabs[index];
  const currentId = tab.group?.id ?? null;
  if (currentId === (group?.id ?? null)) return tabs;
  const rest = tabs.filter((item) => item.id !== tabId);
  const anchorGroupId = group ? group.id : currentId;
  let at = index;
  if (anchorGroupId) {
    const last = rest.reduce(
      (found, item, position) => (item.group?.id === anchorGroupId ? position : found),
      -1,
    );
    if (last >= 0) at = last + 1;
  }
  const record = group ? tabGroupById(rest, group.id) ?? group : null;
  const next = [...rest.slice(0, at), withTabGroup(tab, record), ...rest.slice(at)];
  return normalizeTabGroups(next);
}

// Join the group of that name (case and spacing aside), or start one with the
// next free color. `known` adds groups the caller can see outside `tabs`, such
// as the saved layout of a workspace whose tabs are not loaded yet, so the tab
// joins that group instead of a second one of the same name. Null when the
// name is empty after cleanup.
export function placeTabInNamedGroup(
  tabs: Tab[],
  tabId: TabId,
  name: unknown,
  known: readonly TabGroup[] = [],
): { tabs: Tab[]; group: TabGroup } | null {
  if (!normalizeTabGroupName(name)) return null;
  const groups = tabGroupsIn(tabs);
  const group =
    findTabGroupByName(groups, name) ??
    findTabGroupByName(known, name) ??
    newTabGroup(name, [...groups, ...known]);
  const next = moveTabToGroup(tabs, tabId, group);
  return { tabs: next, group: tabGroupById(next, group.id) ?? group };
}

// A new tab, appended, then placed in the named group when there is a name.
export function insertTabInNamedGroup(
  tabs: Tab[],
  tab: Tab,
  name: unknown,
  known: readonly TabGroup[] = [],
): { tabs: Tab[]; group: TabGroup | null } {
  const appended = [...tabs, tab];
  const placed = placeTabInNamedGroup(appended, tab.id, name, known);
  return placed ?? { tabs: appended, group: null };
}

function mapGroup(tabs: Tab[], groupId: string, update: (group: TabGroup) => TabGroup | null): Tab[] {
  let changed = false;
  const next = tabs.map((tab) => {
    if (tab.group?.id !== groupId) return tab;
    const updated = update(tab.group);
    const result = withTabGroup(tab, updated);
    if (result !== tab) changed = true;
    return result;
  });
  return changed ? next : tabs;
}

export function renameTabGroup(tabs: Tab[], groupId: string, name: unknown): Tab[] {
  const clean = normalizeTabGroupName(name);
  return mapGroup(tabs, groupId, (group) => ({ ...group, name: clean }));
}

export function recolorTabGroup(tabs: Tab[], groupId: string, color: TabGroupColor): Tab[] {
  if (!isTabGroupColor(color)) return tabs;
  return mapGroup(tabs, groupId, (group) => ({ ...group, color }));
}

export function setTabGroupCollapsed(tabs: Tab[], groupId: string, collapsed: boolean): Tab[] {
  return mapGroup(tabs, groupId, (group) => {
    const { collapsed: _collapsed, ...rest } = group;
    return collapsed ? { ...rest, collapsed: true } : rest;
  });
}

// Ungroup: the tabs stay where they are.
export function ungroupTabGroup(tabs: Tab[], groupId: string): Tab[] {
  return mapGroup(tabs, groupId, () => null);
}

// ── Strip rendering ─────────────────────────────────────────────────────────

export type TabStripEntry =
  | { kind: "group"; group: TabGroup; memberIds: TabId[] }
  | { kind: "tab"; tab: Tab; group: TabGroup | null; lastInGroup: boolean };

// What the strip draws, in order: a chip in front of each group's members,
// then the members unless the group is collapsed.
export function tabStripEntries(tabs: readonly Tab[]): TabStripEntry[] {
  const entries: TabStripEntry[] = [];
  const chipped = new Set<string>();
  for (let index = 0; index < tabs.length; index += 1) {
    const tab = tabs[index];
    const group = tab.group ?? null;
    if (group && tabs[index - 1]?.group?.id !== group.id && !chipped.has(group.id)) {
      chipped.add(group.id);
      const memberIds: TabId[] = [];
      for (let next = index; next < tabs.length && tabs[next].group?.id === group.id; next += 1) {
        memberIds.push(tabs[next].id);
      }
      entries.push({ kind: "group", group, memberIds });
    }
    if (group?.collapsed) continue;
    entries.push({
      kind: "tab",
      tab,
      group,
      lastInGroup: Boolean(group) && tabs[index + 1]?.group?.id !== group?.id,
    });
  }
  return entries;
}

// ── Dragging a tab into or out of a group ───────────────────────────────────

// One box in the strip during a drag: a tab or a group chip, in strip content
// coordinates (see tabReorder.ts).
export interface StripDropSlot {
  id: string;
  start: number;
  end: number;
  chip: boolean;
  groupId: string | null;
  collapsed: boolean;
}

export interface StripDrop {
  // Where the tab goes, relative to another tab; null keeps its place.
  anchor: { toId: TabId; position: "before" | "after" } | null;
  groupId: string | null;
}

// The group a dragged tab joins where it would land. `insertIndex` is
// planTabReorder's, over the same slots. Landing right after a chip joins that
// group in front; landing between two members joins it; landing after a
// group's last tab joins it only while the pointer is still over that tab, so
// moving past its edge leaves the group. A collapsed group takes no tabs. At
// the tab's own place the edge is the tab itself: pull it left over the group
// to join, or right past its own edge to leave. Null when the drop changes
// nothing.
export function resolveStripDrop(input: {
  slots: readonly StripDropSlot[];
  draggedId: TabId;
  insertIndex: number;
  pointerX: number;
  // A group's member tab ids in strip order, hidden ones included.
  membersOf: (groupId: string) => readonly TabId[];
}): StripDrop | null {
  const { slots, draggedId, insertIndex, pointerX, membersOf } = input;
  const fromIndex = slots.findIndex((slot) => slot.id === draggedId && !slot.chip);
  if (fromIndex < 0) return null;
  const dragged = slots[fromIndex];
  const others = slots.filter((_, index) => index !== fromIndex);
  const left = others[insertIndex - 1];
  const right = others[insertIndex];
  const home = insertIndex === fromIndex;
  const current = dragged.groupId;

  let groupId: string | null = null;
  if (left?.chip) {
    groupId = left.collapsed ? null : left.groupId;
  } else if (left?.groupId) {
    if (right && !right.chip && right.groupId === left.groupId) groupId = left.groupId;
    else if (!home) groupId = pointerX < left.end ? left.groupId : null;
    else if (pointerX < dragged.start) groupId = left.groupId;
    else if (pointerX > dragged.end) groupId = null;
    else groupId = current;
  }

  const othersOf = (groupId: string | null) =>
    groupId ? membersOf(groupId).filter((id) => id !== draggedId) : [];
  let anchor: StripDrop["anchor"] = null;
  if (!home) {
    if (left && !left.chip) {
      anchor = { toId: left.id, position: "after" };
    } else if (left?.chip && left.collapsed) {
      const members = othersOf(left.groupId);
      if (members.length) anchor = { toId: members[members.length - 1], position: "after" };
    } else if (right && !right.chip) {
      anchor = { toId: right.id, position: "before" };
    } else if (right?.chip) {
      const members = othersOf(right.groupId);
      if (members.length) anchor = { toId: members[0], position: "before" };
    }
  }
  if (!anchor && groupId === current) return null;
  return { anchor, groupId };
}

// Apply a strip drop to the full tab list (strip tabs plus the ones the strip
// does not show). Returns the same array when nothing changes.
export function applyStripDrop(tabs: Tab[], draggedId: TabId, drop: StripDrop): Tab[] {
  const moved = drop.anchor
    ? moveTabInList(tabs, draggedId, drop.anchor.toId, drop.anchor.position) ?? tabs
    : tabs;
  const index = moved.findIndex((tab) => tab.id === draggedId);
  if (index < 0) return tabs;
  const group = drop.groupId ? tabGroupById(tabs, drop.groupId) : null;
  const tab = moved[index];
  const regrouped = withTabGroup(tab, group);
  const next = regrouped === tab ? moved : moved.map((item, at) => (at === index ? regrouped : item));
  const normalized = normalizeTabGroups(next);
  return sameList(normalized, tabs) ? tabs : normalized;
}
