import type { Workspace } from "@shared/types";
import { collectLeaves } from "../../tabs/paneTree";
import { visibleWorkerChip } from "../../tabs/terminalAgentState";
import { isRunOwnedTab, type Tab, type TerminalLeaf, type TerminalTab } from "../../tabs/types";
import { runtimeLabel } from "../../routing/agent-destinations";

// The jump palette's model: what it lists, how a query ranks it, and the
// workspace order the 1 to 9 commands count in. Pure functions of plain data,
// so scripts/test-jump-palette-model.cjs runs them without React.

// The rail order and the worktree source live apart so the window can count
// workspaces at startup without loading the palette's ranking.
export { workspaceRailSequence, worktreeSourceWorkspace } from "./rail-order";

export type JumpEntryKind = "workspace" | "agent" | "terminal" | "editor" | "diff" | "browser";

/** What an agent row shows about its agent. `needs-you` and `done` rank first. */
export type JumpStatus = "needs-you" | "done" | "working" | "background" | "ready" | "starting" | "exited";

export interface JumpTarget {
  workspaceId: string;
  tabId?: string;
  paneId?: string;
}

export interface JumpEntry {
  /** `ws:<id>`, `tab:<id>` or `pane:<id>`; also the key its recency is kept under. */
  id: string;
  kind: JumpEntryKind;
  label: string;
  detail: string;
  /** Lower-weight words a query also matches: path, URL, branch, workspace. */
  keywords: string;
  workspaceId: string;
  workspaceName: string;
  workspaceColor?: string;
  workspaceIcon?: string;
  runtime?: string;
  /** File name an editor row's icon is chosen by. */
  fileName?: string;
  target: JumpTarget;
  status: JumpStatus | null;
  /** 0 needs you, 1 finished and not seen yet, 2 everything else. */
  tier: 0 | 1 | 2;
  /** The workspace or tab on screen now. */
  current: boolean;
  lastUsedAt: number;
  /** Stable base order: rail order, each workspace followed by its tabs. */
  order: number;
}

export interface JumpLayout {
  workspaceId: string;
  tabs: readonly Tab[];
  activeTabId: string | null;
}

export interface JumpSources {
  /** In rail order (see workspaceRailSequence). */
  workspaces: readonly Workspace[];
  /** Loaded tab layouts; a later one for the same workspace wins. */
  layouts: readonly JumpLayout[];
  activeWorkspaceId: string | null;
  branchByWorkspaceId?: Readonly<Record<string, string | null | undefined>>;
  /** The rail's attention tone per workspace ("blocked" means a Cora run needs you). */
  toneByWorkspaceId?: Readonly<Record<string, string | null | undefined>>;
  /** Unseen terminal-agent alerts, workspace to pane. */
  attention?: Readonly<Record<string, Readonly<Record<string, { tabId: string; kind: string }>>>>;
  /** Panes main's monitor reports an agent CLI in, workspace to pane. */
  detectedAgents?: Readonly<Record<string, Readonly<Record<string, true>>>>;
  recency?: Readonly<Record<string, number>>;
}

// ── Entries ───────────────────────────────────────────────────────────────

function normPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

function relativeTo(root: string, target: string): string {
  const base = normPath(root);
  const path = normPath(target);
  if (base && path.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return path.slice(base.length + 1);
  return path;
}

function parentDir(path: string): string {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : "";
}

function urlHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function statusOf(
  leaf: TerminalLeaf,
  alert: { kind: string } | undefined,
): { status: JumpStatus | null; tier: 0 | 1 | 2 } {
  const state = visibleWorkerChip(leaf.worker)?.runtimeState;
  if (alert?.kind === "blocked" || state === "blocked") return { status: "needs-you", tier: 0 };
  if (alert?.kind === "complete") return { status: "done", tier: 1 };
  switch (state) {
    case "working":
      return { status: "working", tier: 2 };
    case "background":
      return { status: "background", tier: 2 };
    case "idle":
      return { status: "ready", tier: 2 };
    case "launching":
      return { status: "starting", tier: 2 };
    case "error":
      return { status: "exited", tier: 2 };
    default:
      return { status: null, tier: 2 };
  }
}

/** Every workspace, agent pane, terminal, editor, diff and browser tab, in base order. */
export function buildJumpEntries(sources: JumpSources): JumpEntry[] {
  const layoutByWorkspace = new Map(sources.layouts.map((layout) => [layout.workspaceId, layout]));
  const recency = sources.recency ?? {};
  const out: JumpEntry[] = [];
  let order = 0;

  for (const workspace of sources.workspaces) {
    const isActiveWorkspace = workspace.id === sources.activeWorkspaceId;
    const branch = sources.branchByWorkspaceId?.[workspace.id] ?? workspace.copyBranch?.branch ?? null;
    const shared = {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspaceColor: workspace.color,
      workspaceIcon: workspace.icon,
    };
    const workspaceEntry: JumpEntry = {
      ...shared,
      id: `ws:${workspace.id}`,
      kind: "workspace",
      label: workspace.name,
      detail: branch ?? workspace.cwd,
      keywords: `${workspace.cwd} ${branch ?? ""} workspace worktree`,
      target: { workspaceId: workspace.id },
      status: null,
      tier: 2,
      current: isActiveWorkspace,
      lastUsedAt: recency[`ws:${workspace.id}`] ?? 0,
      order: order++,
    };
    out.push(workspaceEntry);

    const layout = layoutByWorkspace.get(workspace.id);
    const alerts = sources.attention?.[workspace.id] ?? {};
    const detected = sources.detectedAgents?.[workspace.id] ?? {};
    const tabKeywords = `${workspace.name} ${branch ?? ""}`;
    let agentNeedsYou = false;

    for (const tab of layout?.tabs ?? []) {
      if (isRunOwnedTab(tab)) continue;
      const tabIsActive = isActiveWorkspace && layout?.activeTabId === tab.id;
      if (tab.kind === "terminal") {
        const cells = collectLeaves(tab.root).filter((leaf) => leaf.content?.type !== "tab");
        let plainTarget: TerminalLeaf | null = null;
        cells.forEach((leaf, index) => {
          const chip = visibleWorkerChip(leaf.worker);
          const alert = alerts[leaf.paneId];
          const runtime =
            chip?.runtime ?? (leaf.agentSession?.active ? leaf.agentSession.runtime : undefined);
          const isAgent = Boolean(chip) || detected[leaf.paneId] === true || alert !== undefined;
          if (!isAgent) {
            if (!plainTarget || leaf.paneId === tab.activePaneId) plainTarget = leaf;
            return;
          }
          const { status, tier } = statusOf(leaf, alert);
          if (tier === 0) agentNeedsYou = true;
          const name = runtimeLabel(runtime) ?? "Agent";
          const place =
            (chip?.source === "spark" ? chip.title : undefined) ??
            (cells.length > 1 ? `${tab.title || "Terminal"} pane ${index + 1}` : tab.title || "Terminal");
          out.push({
            ...shared,
            id: `pane:${leaf.paneId}`,
            kind: "agent",
            label: `${name} · ${place}`,
            detail: workspace.name,
            keywords: `${tabKeywords} ${runtime ?? ""} agent terminal`,
            runtime: runtime ?? undefined,
            target: { workspaceId: workspace.id, tabId: tab.id, paneId: leaf.paneId },
            status,
            tier,
            current: tabIsActive && tab.activePaneId === leaf.paneId,
            lastUsedAt: recency[`pane:${leaf.paneId}`] ?? 0,
            order: order++,
          });
        });
        const plain = plainTarget as TerminalLeaf | null;
        if (plain) {
          out.push(
            terminalEntry(tab, plain, shared, workspace.cwd, tabKeywords, tabIsActive, recency, order++),
          );
        }
        continue;
      }
      if (tab.kind === "editor" || tab.kind === "diff") {
        const relative = tab.kind === "editor" ? relativeTo(workspace.cwd, tab.path) : tab.path;
        const dir = parentDir(relative);
        out.push({
          ...shared,
          id: `tab:${tab.id}`,
          kind: tab.kind,
          label: tab.title || relative,
          detail: [workspace.name, tab.kind === "diff" ? `${relative} changes` : dir]
            .filter(Boolean)
            .join(" · "),
          keywords: `${tabKeywords} ${relative} ${tab.kind === "diff" ? "diff changes" : "file editor"}`,
          fileName: relative.slice(relative.lastIndexOf("/") + 1),
          target: { workspaceId: workspace.id, tabId: tab.id },
          status: null,
          tier: 2,
          current: tabIsActive,
          lastUsedAt: recency[`tab:${tab.id}`] ?? 0,
          order: order++,
        });
        continue;
      }
      if (tab.kind === "preview") {
        out.push({
          ...shared,
          id: `tab:${tab.id}`,
          kind: "browser",
          label: tab.title || urlHost(tab.url),
          detail: `${workspace.name} · ${tab.url}`,
          keywords: `${tabKeywords} ${tab.url} browser`,
          target: { workspaceId: workspace.id, tabId: tab.id },
          status: null,
          tier: 2,
          current: tabIsActive,
          lastUsedAt: recency[`tab:${tab.id}`] ?? 0,
          order: order++,
        });
      }
    }

    // A Cora run waiting on an answer lights the rail dot without any agent
    // pane to stand for it; the workspace row carries it instead.
    if (!agentNeedsYou && sources.toneByWorkspaceId?.[workspace.id] === "blocked") {
      workspaceEntry.status = "needs-you";
      workspaceEntry.tier = 0;
    }
  }
  return out;
}

function terminalEntry(
  tab: TerminalTab,
  leaf: TerminalLeaf,
  shared: Pick<JumpEntry, "workspaceId" | "workspaceName" | "workspaceColor" | "workspaceIcon">,
  workspaceCwd: string,
  tabKeywords: string,
  tabIsActive: boolean,
  recency: Readonly<Record<string, number>>,
  order: number,
): JumpEntry {
  // The shell's folder only when it has left the workspace's own.
  const cwd = leaf.cwd ?? "";
  const away = cwd !== "" && normPath(cwd) !== normPath(workspaceCwd);
  return {
    ...shared,
    id: `tab:${tab.id}`,
    kind: "terminal",
    label: tab.title || "Terminal",
    detail: away ? `${shared.workspaceName} · ${relativeTo(workspaceCwd, cwd)}` : shared.workspaceName,
    keywords: `${tabKeywords} ${leaf.cwd ?? ""} terminal shell`,
    target: { workspaceId: shared.workspaceId, tabId: tab.id, paneId: leaf.paneId },
    status: null,
    tier: 2,
    current: tabIsActive,
    lastUsedAt: recency[`tab:${tab.id}`] ?? 0,
    order,
  };
}

// ── Matching ──────────────────────────────────────────────────────────────

// Match classes, best first. A query ranks by its weakest token's class, so
// a row matching every word in its own name beats one whose name matches one
// word and its workspace the other. Initials ("fa" for fix-auth) rank under a
// word in a path but over letters that merely occur inside one.
const CLASS_EXACT = 8;
const CLASS_PREFIX = 7;
const CLASS_WORD = 6;
const CLASS_SUBSTRING = 5;
const CLASS_EXTRA_WORD = 4;
const CLASS_INITIALS = 3;
const CLASS_EXTRA_SUBSTRING = 2;
const CLASS_FUZZY = 1;

export interface RankedJumpEntry {
  entry: JumpEntry;
  /** Indices of `entry.label` the query matched, for highlighting. */
  highlights: number[];
}

function isWordStart(text: string, index: number): boolean {
  if (index === 0) return true;
  const prev = text[index - 1];
  const here = text[index];
  if (!/[\p{L}\p{N}]/u.test(prev)) return true;
  return prev === prev.toLowerCase() && here !== here.toLowerCase();
}

interface TokenMatch {
  klass: number;
  score: number;
  highlights: number[];
}

function range(start: number, length: number): number[] {
  return Array.from({ length }, (_, i) => start + i);
}

function matchInText(text: string, lower: string, token: string): { klass: number; index: number } | null {
  if (lower === token) return { klass: CLASS_EXACT, index: 0 };
  if (lower.startsWith(token)) return { klass: CLASS_PREFIX, index: 0 };
  let index = lower.indexOf(token);
  const first = index;
  while (index > 0) {
    if (isWordStart(text, index)) return { klass: CLASS_WORD, index };
    index = lower.indexOf(token, index + 1);
  }
  return first >= 0 ? { klass: CLASS_SUBSTRING, index: first } : null;
}

/**
 * Characters of `token` in order inside `lower`: the next character when it
 * continues the run, else the next word start carrying it, so "fa" lands on
 * the F and A of "fix-auth" rather than the a inside "fix". Falls back to the
 * earliest positions when that choice strands a later character.
 */
function fuzzyIndices(text: string, lower: string, token: string): number[] | null {
  return subsequence(text, lower, token, true) ?? subsequence(text, lower, token, false);
}

function subsequence(text: string, lower: string, token: string, preferWords: boolean): number[] | null {
  const out: number[] = [];
  let from = 0;
  for (const char of token) {
    const prev = out.length > 0 ? out[out.length - 1] : -1;
    let found = -1;
    if (preferWords && prev >= 0 && lower[prev + 1] === char) {
      found = prev + 1;
    } else {
      for (let i = lower.indexOf(char, from); i >= 0; i = lower.indexOf(char, i + 1)) {
        if (found < 0) found = i;
        if (!preferWords || isWordStart(text, i)) {
          found = i;
          break;
        }
      }
    }
    if (found < 0) return null;
    out.push(found);
    from = found + 1;
  }
  return out;
}

function fuzzyScore(text: string, indices: number[]): number {
  let score = 0;
  for (let i = 0; i < indices.length; i += 1) {
    if (isWordStart(text, indices[i])) score += 8;
    if (i > 0 && indices[i] === indices[i - 1] + 1) score += 5;
    if (i > 0) score -= Math.min(6, indices[i] - indices[i - 1] - 1);
  }
  return score - indices[0];
}

function matchToken(entry: JumpEntry, labelLower: string, extraLower: string, token: string): TokenMatch | null {
  const inLabel = matchInText(entry.label, labelLower, token);
  if (inLabel) {
    return {
      klass: inLabel.klass,
      score: 100 - inLabel.index - Math.min(40, entry.label.length - token.length) / 4,
      highlights: range(inLabel.index, token.length),
    };
  }
  const extra = `${entry.detail} ${entry.keywords}`;
  const inExtra = matchInText(extra, extraLower, token);
  if (inExtra && inExtra.klass >= CLASS_WORD) {
    return { klass: CLASS_EXTRA_WORD, score: 40 - Math.min(30, inExtra.index / 4), highlights: [] };
  }
  // Initials in the name outrank letters found inside a path.
  const fuzzy = fuzzyIndices(entry.label, labelLower, token);
  if (fuzzy && isInitials(entry.label, fuzzy)) {
    return { klass: CLASS_INITIALS, score: fuzzyScore(entry.label, fuzzy), highlights: fuzzy };
  }
  if (inExtra) {
    return { klass: CLASS_EXTRA_SUBSTRING, score: 40 - Math.min(30, inExtra.index / 4), highlights: [] };
  }
  if (fuzzy) {
    return { klass: CLASS_FUZZY, score: fuzzyScore(entry.label, fuzzy), highlights: fuzzy };
  }
  return null;
}

/** Every matched run starts at a word start: "fa" or "fiau" in fix-auth. */
function isInitials(text: string, indices: number[]): boolean {
  return indices.every(
    (index, i) => isWordStart(text, index) || (i > 0 && index === indices[i - 1] + 1),
  );
}

/** Recency that ranks: the row on screen counts as used before anything else was. */
function effectiveRecency(entry: JumpEntry): number {
  return entry.current ? 1 : entry.lastUsedAt;
}

/**
 * Empty query: rows that need you, then finished ones you have not seen, then
 * by most recent use, the row on screen last among the used ones. With a
 * query: fuzzy matches only, best match class first, and within a class the
 * same attention and recency order.
 */
export function rankJumpEntries(
  entries: readonly JumpEntry[],
  query: string,
  limit = 60,
): RankedJumpEntry[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return [...entries]
      .sort(
        (a, b) =>
          a.tier - b.tier ||
          effectiveRecency(b) - effectiveRecency(a) ||
          a.order - b.order,
      )
      .slice(0, limit)
      .map((entry) => ({ entry, highlights: [] }));
  }
  const scored: Array<{ entry: JumpEntry; klass: number; score: number; highlights: number[] }> = [];
  for (const entry of entries) {
    const labelLower = entry.label.toLowerCase();
    const extraLower = `${entry.detail} ${entry.keywords}`.toLowerCase();
    let klass = Number.POSITIVE_INFINITY;
    let score = 0;
    const highlights = new Set<number>();
    let ok = true;
    for (const token of tokens) {
      const match = matchToken(entry, labelLower, extraLower, token);
      if (!match) {
        ok = false;
        break;
      }
      klass = Math.min(klass, match.klass);
      score += match.score;
      for (const index of match.highlights) highlights.add(index);
    }
    if (!ok) continue;
    scored.push({ entry, klass, score, highlights: [...highlights].sort((x, y) => x - y) });
  }
  return scored
    .sort(
      (a, b) =>
        b.klass - a.klass ||
        a.entry.tier - b.entry.tier ||
        b.score - a.score ||
        effectiveRecency(b.entry) - effectiveRecency(a.entry) ||
        a.entry.order - b.entry.order,
    )
    .slice(0, limit)
    .map(({ entry, highlights }) => ({ entry, highlights }));
}

// ── Creating a worktree ───────────────────────────────────────────────────

/**
 * The branch name a query offers to create a worktree for: spaces become
 * dashes, and names git's ref rules refuse are not offered at all.
 */
export function worktreeNameFromQuery(query: string): string | null {
  const name = query.trim().replace(/\s+/g, "-");
  if (!name || name === "@") return null;
  if (/[~^:?*[\\\u0000-\u001f\u007f]/.test(name)) return null;
  if (name.includes("..") || name.includes("@{") || name.includes("//")) return null;
  if (name.startsWith("-") || name.startsWith("/") || name.startsWith(".")) return null;
  if (name.endsWith("/") || name.endsWith(".") || name.endsWith(".lock")) return null;
  if (name.split("/").some((part) => part.startsWith("."))) return null;
  return name;
}

/** Offer to create `name` unless a workspace already goes by it or checks it out. */
export function shouldOfferWorktree(name: string | null, workspaces: readonly Workspace[]): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  return !workspaces.some(
    (workspace) =>
      workspace.name.toLowerCase() === lower || workspace.copyBranch?.branch.toLowerCase() === lower,
  );
}
