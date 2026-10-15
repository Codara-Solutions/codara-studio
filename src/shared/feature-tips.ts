// Feature tips: which Codara features this person has used, kept on this
// computer only (feature-tips.json in the Codara home, never uploaded), and
// at most one gentle tip at a time about a useful feature they have not
// tried. A tip can start a short tour that points at the real control.
//
// The catalog is the one place a feature is described. Each entry has a
// stable id (persisted: never rename one), the signals that mean "used",
// and optionally the tip. Signals are read from the live window by
// src/renderer/src/components/feature-tips/, so most features need no code
// of their own: a click on a control, a keyboard command, a dialog that is
// open, a window event or a preference that is on. Any element carrying
// data-feature-tip="<id>" is both a click signal and a tip target, which is
// how a new control joins without touching this file again. Code that has
// no such control calls recordFeatureUse(id) or dispatches
// FEATURE_USED_EVENT with { id }.

import { COMMAND_RAN_EVENT, FEATURE_TIP_ATTRIBUTE, FEATURE_USED_EVENT } from "./feature-tip-events";
import type { AppPreferences } from "./types";

export type FeatureTipPlacement = "top" | "bottom" | "left" | "right";

export interface FeatureTourStep {
  /** CSS selector of the real control this step points at. */
  target: string;
  title: string;
  /** May name a shortcut as {shortcut:<command id>}. */
  body: string;
  placement?: FeatureTipPlacement;
}

type BooleanPreferenceKey = {
  [K in keyof AppPreferences]-?: NonNullable<AppPreferences[K]> extends boolean ? K : never;
}[keyof AppPreferences];

export interface FeatureSignals {
  /** A click on, or inside, an element matching one of these selectors. */
  clicks?: readonly string[];
  /** A command of the keyboard registry (shortcuts/commands.ts) ran. */
  commands?: readonly string[];
  /** The feature's own surface is on screen: its dialog or page. */
  visible?: readonly string[];
  /** A window CustomEvent the app dispatches when the feature is used. */
  events?: readonly string[];
  /** A preference that is only on when the person turned the feature on. */
  preferences?: readonly BooleanPreferenceKey[];
}

export interface FeatureTip {
  title: string;
  /** May name a shortcut as {shortcut:<command id>}. */
  body: string;
  /**
   * The tip is offered only while this selector is on screen. A tip with a
   * tour also needs its first step's target on screen, so it never offers a
   * tour of a control that is not there.
   */
  when?: string;
  /** How many elements matching `when` must be on screen (default 1). */
  whenAtLeast?: number;
  /** "Show me": a short tour over the real controls. */
  tour?: readonly FeatureTourStep[];
  /** For a feature without a control on screen: a button that opens it. */
  open?: { label: string; event: string; detail?: Record<string, string> };
  /** A new feature: offered before the older ones. */
  fresh?: boolean;
}

export interface FeatureCatalogEntry {
  /** Persisted: never rename. */
  id: string;
  name: string;
  /** What counts as having used the feature, in words. */
  used: string;
  signals: FeatureSignals;
  tip?: FeatureTip;
  /**
   * Built on another branch: its control does not exist here yet. The tip
   * stays dormant until an element with data-feature-tip="<id>" is on
   * screen; usage arrives from clicks on that element or recordFeatureUse.
   */
  awaitsControl?: boolean;
}

export { COMMAND_RAN_EVENT, FEATURE_TIP_ATTRIBUTE, FEATURE_USED_EVENT };

export function featureTipTargetSelector(id: string): string {
  return `[${FEATURE_TIP_ATTRIBUTE}="${id}"]`;
}

const awaitingControl = (
  id: string,
  name: string,
  used: string,
  tip: Omit<FeatureTip, "when" | "tour" | "fresh"> & { tourTitle: string; tourBody: string },
): FeatureCatalogEntry => ({
  id,
  name,
  used,
  awaitsControl: true,
  signals: {},
  tip: {
    title: tip.title,
    body: tip.body,
    fresh: true,
    tour: [{ target: featureTipTargetSelector(id), title: tip.tourTitle, body: tip.tourBody }],
  },
});

// Order is the offer order within each group (fresh first, then the rest).
export const FEATURE_CATALOG: readonly FeatureCatalogEntry[] = [
  // ── Built on parallel branches. Dormant until their control exists. ──
  awaitingControl("keep-awake", "Keep awake", "The keep-awake control was turned on or changed.", {
    title: "Keep the computer awake while agents work",
    body: "A long run does not stop halfway because the computer went to sleep.",
    tourTitle: "Keep awake",
    tourBody: "Turn this on and the computer stays awake while agents are still working.",
  }),
  awaitingControl("jump-palette", "Jump palette", "The jump palette was opened.", {
    title: "Jump anywhere from the keyboard",
    body: "Switch workspaces, tabs and chats by typing a few letters of their name.",
    tourTitle: "The jump palette",
    tourBody: "Open it here or with its shortcut, then type where you want to go.",
  }),
  awaitingControl("quick-commands", "Quick Commands", "A quick command was run, added or edited.", {
    title: "Keep your usual commands one click away",
    body: "Save the commands you run often and start them in a terminal without typing them again.",
    tourTitle: "Quick Commands",
    tourBody: "Pick a saved command to run it here, or add the one you just typed.",
  }),
  awaitingControl("agent-board", "Agents tab", "The Agents tab in the workspace rail was opened.", {
    title: "See every agent at a glance",
    body: "The Agents tab lists the agents that are working, waiting for you or done, in every workspace.",
    tourTitle: "The Agents tab",
    tourBody: "Open it to see each agent's state and jump to the one that needs you.",
  }),
  awaitingControl("review-notes", "Review notes", "A review note was added to a diff or sent to an agent.", {
    title: "Leave review notes on a diff",
    body: "Add notes on the lines you want changed, then send them all to an agent to fix.",
    tourTitle: "Review notes",
    tourBody: "Add a note on a diff line here. Your notes go to the agent together.",
  }),
  awaitingControl("worktree-cleanup", "Worktree cleanup", "The worktree cleanup screen was opened or used.", {
    title: "Clean up old worktrees",
    body: "See every worktree, how much space it takes and whether it is merged, and remove the ones you are done with.",
    tourTitle: "Worktree cleanup",
    tourBody: "Open it to review your worktrees and free the space the merged ones take.",
  }),

  // ── Features that ship today. ──
  {
    id: "split-panes",
    name: "Split terminal panes",
    used: "A terminal pane was split, from the pane toolbar or a shortcut.",
    signals: {
      clicks: ['button[title^="Split right"]', 'button[title^="Split down"]'],
      commands: ["terminal.splitRight", "terminal.splitDown", "terminal.newBalancedPane"],
    },
    tip: {
      title: "Run things side by side",
      body: "Split a terminal to keep a dev server, tests and an agent in one tab. Shortcut: {shortcut:terminal.splitRight}.",
      tour: [
        {
          target: 'button[title^="Split right"]',
          title: "Split a pane",
          body: "Hover a pane to show its toolbar. These buttons split it right or down, and the new pane opens in the same folder.",
          placement: "bottom",
        },
      ],
    },
  },
  {
    id: "browser-point",
    name: "Point at page elements",
    used: "An element on a browser page was picked to send to an agent.",
    signals: {
      clicks: ['button[title^="Point at an element"]'],
      commands: ["browser.pickElement"],
    },
    tip: {
      title: "Show an agent what you mean",
      body: "In the browser, point at the element you want changed and send it to an agent with its markup and a screenshot.",
      tour: [
        {
          target: 'button[title^="Point at an element"]:not(:disabled)',
          title: "Point at an element",
          body: "Click here, then click anything on the page and choose the agent to send it to. Shortcut: {shortcut:browser.pickElement}.",
          placement: "bottom",
        },
      ],
    },
  },
  {
    id: "browser-comment",
    name: "Comment on a page",
    used: "A comment was started on a browser page.",
    signals: {
      clicks: ['button[title^="Comment on the page"]'],
      commands: ["browser.comment"],
    },
    tip: {
      title: "Leave comments on a page",
      body: "Pin comments where things should change on the page, then hand them to an agent in one go.",
      tour: [
        {
          target: 'button[title^="Comment on the page"]:not(:disabled)',
          title: "Comment on the page",
          body: "Click here, then click the page where you want a comment. Shortcut: {shortcut:browser.comment}.",
          placement: "bottom",
        },
      ],
    },
  },
  {
    id: "automations",
    name: "Automations",
    used: "The Automations page was opened.",
    signals: {
      clicks: ['button[aria-label$="Open the Automations tab"]'],
      commands: ["automations.open"],
      events: ["spark:open-automations-tab"],
    },
    tip: {
      title: "Put repeat work on a schedule",
      body: "Automations run a saved task by hand, on a schedule or after a git push, and keep every run for you to check.",
      tour: [
        {
          target: '.spark-tabbar button[aria-label$="Open the Automations tab"]',
          title: "Automations",
          body: "Open them here, or with {shortcut:automations.open}. Start with a task you run by hand, then give it a schedule.",
          placement: "bottom",
        },
      ],
    },
  },
  {
    id: "notification-center",
    name: "Notification center",
    used: "The notification center was opened.",
    signals: {
      clicks: ["button.nc-bell"],
      visible: [".nc-panel"],
    },
    tip: {
      title: "Catch up on what agents did",
      body: "The bell keeps every agent alert, finished run and question for you, by day or by workspace.",
      tour: [
        {
          target: "button.nc-bell",
          title: "Your notifications",
          body: "Open the bell to answer questions, jump to a finished run or turn on Do Not Disturb.",
          placement: "bottom",
        },
      ],
    },
  },
  {
    id: "usage-panel",
    name: "Usage and limits",
    used: "The Usage page was opened.",
    signals: {
      clicks: ['button[aria-label="Usage analytics"]'],
      commands: ["usage.open"],
      visible: ["[data-usage-page]"],
    },
    tip: {
      title: "See how much of your plan is left",
      body: "Usage shows each agent's limits and when they reset, so a long run does not stop by surprise.",
      tour: [
        {
          target: 'button[aria-label="Usage analytics"]',
          title: "Usage",
          body: "Open it here or with {shortcut:usage.open} to see every account's limits and spend.",
          placement: "bottom",
        },
      ],
    },
  },
  {
    id: "capability-center",
    name: "Capability Center",
    used: "The Capability Center was opened.",
    signals: {
      clicks: [".composer-tools-trigger"],
      commands: ["capabilities.open"],
      events: ["spark:open-capabilities"],
      visible: ['[role="dialog"][aria-label="Capability Center"]'],
    },
    tip: {
      title: "Give Cora more tools",
      body: "The Capability Center adds MCP servers and skills, keeps what Cora remembers and picks the models workers may use.",
      tour: [
        {
          target: ".composer-tools-trigger",
          title: "Tools, skills and memory",
          body: "Open the Capability Center from here.",
          placement: "top",
        },
      ],
    },
  },
  {
    id: "cora-board",
    name: "Cora Board",
    used: "A chat's board was opened.",
    signals: {
      clicks: ['button[aria-label="Kanban"]'],
      commands: ["board.open"],
      events: ["spark:open-cora-board"],
    },
    tip: {
      title: "Queue work for Cora",
      body: "Each chat has a board. Add cards and Cora works through them one by one while you do something else.",
      tour: [
        {
          target: 'button[aria-label="Kanban"]',
          title: "The chat's board",
          body: "Open the board here, or with {shortcut:board.open}.",
          placement: "bottom",
        },
      ],
    },
  },
  {
    id: "isolated-worktree",
    name: "Isolated worktrees",
    used: "The isolated worktree dialog was opened.",
    signals: {
      visible: [".create-copy-scrim"],
    },
    tip: {
      title: "Try an idea without touching your branch",
      body: "An isolated worktree is a copy of the project on its own branch. Agents work there while your folder stays as it is.",
      when: '[title^="On branch "]',
      tour: [
        {
          // The actions of a workspace on a git branch: a plain folder has no
          // branch to copy.
          target: '[data-workspace-id]:has([title^="On branch "]) button[title="Workspace actions"]',
          title: "Create an isolated worktree",
          body: "Open a workspace's actions and choose Create isolated worktree. It shows up under the workspace.",
          placement: "right",
        },
      ],
    },
  },
  {
    id: "run-switcher",
    name: "Run switcher",
    used: "The run switcher was opened.",
    signals: {
      commands: ["runSwitcher.open"],
      visible: ['[role="dialog"][aria-label="Switch Cora run"]'],
    },
    tip: {
      title: "Jump between Cora runs",
      body: "Press {shortcut:runSwitcher.open} to find a recent Cora run in any workspace and open it.",
    },
  },
  {
    id: "quick-open",
    name: "Quick Open",
    used: "A file was searched for by name.",
    signals: {
      commands: ["tab.newEditor"],
      visible: ['[role="dialog"][aria-label="Open file"]'],
    },
    tip: {
      title: "Open any file by name",
      body: "Press {shortcut:tab.newEditor} and type part of a file name to open it in the editor.",
    },
  },
  {
    id: "search-files",
    name: "Search in files",
    used: "The project-wide search was opened.",
    signals: {
      commands: ["search.open"],
      events: ["spark:open-search"],
      visible: ['[role="dialog"][aria-label="Search in files"]'],
    },
    tip: {
      title: "Search the whole project",
      body: "Press {shortcut:search.open} to search every file in the workspace, with regex and whole word options.",
    },
  },
  {
    id: "keyboard-shortcuts",
    name: "Keyboard shortcuts",
    used: "The keyboard shortcuts sheet was opened.",
    signals: {
      commands: ["shortcuts.open"],
      visible: ['[role="dialog"][aria-label="Keyboard shortcuts"]'],
    },
    tip: {
      title: "Every shortcut on one page",
      body: "Press {shortcut:shortcuts.open} to see all keyboard shortcuts. You can change any of them in Settings.",
    },
  },
  {
    id: "zoom-pane",
    name: "Zoom a pane",
    used: "A terminal pane was zoomed.",
    signals: {
      clicks: ['button[title^="Zoom pane"]'],
      commands: ["terminal.toggleZoom"],
    },
    tip: {
      title: "Give one pane the whole tab",
      body: "Zoom a pane to read it full size, then zoom back to see the others. Shortcut: {shortcut:terminal.toggleZoom}.",
      // Zoom only means something with another pane beside it.
      when: 'button[title^="Zoom pane"]',
      whenAtLeast: 2,
      tour: [
        {
          target: 'button[title^="Zoom pane"]',
          title: "Zoom a pane",
          body: "This button zooms the pane. Press it again to bring the other panes back.",
          placement: "bottom",
        },
      ],
    },
  },
  {
    id: "status-chip",
    name: "Servers and sessions",
    used: "The status bar's list of servers and sessions was opened.",
    signals: {
      clicks: ["button.status-chip"],
    },
    tip: {
      title: "Everything running, in one place",
      body: "The status bar lists the dev servers, agent sessions, browser tabs and recordings of this workspace.",
      tour: [
        {
          target: "button.status-chip",
          title: "What is running",
          body: "Open it to jump to a server or session, or to stop one.",
          placement: "top",
        },
      ],
    },
  },
  {
    id: "workspace-folders",
    name: "Workspace folders",
    used: "A workspace folder exists in the rail.",
    signals: {
      visible: [".spark-workspace-folder"],
    },
    tip: {
      title: "Group workspaces into folders",
      body: "With many projects open, put related workspaces in a folder you can collapse and color.",
      when: "[data-workspace-id]",
      whenAtLeast: 3,
      tour: [
        {
          target: 'button[title="New…"]',
          title: "New folder",
          body: "Choose New folder here, then drag workspaces into it.",
          placement: "right",
        },
      ],
    },
  },
  {
    id: "whiteboard",
    name: "Whiteboard",
    used: "A whiteboard was opened.",
    signals: {
      commands: ["tab.newWhiteboard"],
      visible: [".cora-whiteboard-surface"],
    },
    tip: {
      title: "Sketch it on a whiteboard",
      body: "Press {shortcut:tab.newWhiteboard} for a whiteboard tab. Sketch a flow, then ask Cora about it.",
    },
  },
  {
    id: "chat-history",
    name: "Chat history",
    used: "The chat history was opened.",
    signals: {
      clicks: ['button[aria-label="Open chat history"]'],
    },
    tip: {
      title: "Pick up an older chat",
      body: "Every chat with Cora is kept. Open the history to find one and carry on where you left off.",
      tour: [
        {
          target: 'button[aria-label="Open chat history"]',
          title: "Chat history",
          body: "Your earlier chats in this workspace are here.",
          placement: "bottom",
        },
      ],
    },
  },
  {
    id: "remote-access",
    name: "Remote access",
    used: "Remote access to this computer was turned on.",
    signals: {
      preferences: ["remoteAccessEnabled"],
    },
    tip: {
      title: "Follow your agents from your phone",
      body: "Pair the Codara phone app to follow runs, answer questions and get alerts while you are away from this computer.",
      open: { label: "Open Settings", event: "spark:open-settings", detail: { section: "remote-access" } },
    },
  },
  {
    id: "restore-sessions",
    name: "Resume agent sessions",
    used: "Resuming agent sessions after a restart was turned on.",
    signals: {
      preferences: ["restoreAgentSessions"],
    },
    tip: {
      title: "Bring agents back after a restart",
      body: "Codara can resume your Claude Code, Codex, Grok and Pi sessions with their output when it reopens.",
      open: { label: "Open Settings", event: "spark:open-settings", detail: { section: "sessions" } },
    },
  },
];

const ENTRY_BY_ID = new Map(FEATURE_CATALOG.map((entry) => [entry.id, entry]));

export function featureEntry(id: string): FeatureCatalogEntry | undefined {
  return ENTRY_BY_ID.get(id);
}

export function isCatalogFeatureId(value: unknown): value is string {
  return typeof value === "string" && ENTRY_BY_ID.has(value);
}

/** The selectors that must be on screen for a tip to be offered. */
export function tipConditions(entry: FeatureCatalogEntry): { selector: string; atLeast: number }[] {
  const tip = entry.tip;
  if (!tip) return [];
  const out: { selector: string; atLeast: number }[] = [];
  if (tip.when) out.push({ selector: tip.when, atLeast: Math.max(1, tip.whenAtLeast ?? 1) });
  const first = tip.tour?.[0]?.target;
  if (first) out.push({ selector: first, atLeast: 1 });
  return out;
}

/** Every click selector of an entry, the data-feature-tip one included. */
export function clickSelectors(entry: FeatureCatalogEntry): string[] {
  return [...(entry.signals.clicks ?? []), featureTipTargetSelector(entry.id)];
}

// ── Shortcut tokens ─────────────────────────────────────────────────────────

const SHORTCUT_TOKEN = /\{shortcut:([\w.]+)\}/g;

/** Commands a text names as {shortcut:<id>}. */
export function shortcutCommands(text: string): string[] {
  return [...text.matchAll(SHORTCUT_TOKEN)].map((match) => match[1]);
}

/** Every command a tip names, in its body and its tour. */
export function tipShortcutCommands(entry: FeatureCatalogEntry): string[] {
  if (!entry.tip) return [];
  const texts = [entry.tip.title, entry.tip.body, ...(entry.tip.tour ?? []).map((step) => step.body)];
  return [...new Set(texts.flatMap(shortcutCommands))];
}

/**
 * Replaces each {shortcut:<id>} with the live chord. Null when a named
 * command has no chord (the person unbound it): the text would point at
 * nothing, so the tip is not offered.
 */
export function renderTipText(text: string, chordFor: (command: string) => string | null): string | null {
  let missing = false;
  const out = text.replace(SHORTCUT_TOKEN, (_token, command: string) => {
    const chord = chordFor(command);
    if (!chord) missing = true;
    return chord ?? "";
  });
  return missing ? null : out;
}

// ── Persisted state ─────────────────────────────────────────────────────────

export type FeatureTipOutcome = "shown" | "dismissed" | "toured" | "opened" | "turned-off";
const OUTCOMES: readonly FeatureTipOutcome[] = ["shown", "dismissed", "toured", "opened", "turned-off"];

export interface FeatureTipRecord {
  shownAt: number;
  outcome: FeatureTipOutcome;
}

export interface FeatureTipsState {
  version: 1;
  /** Off once the person chose "Don't show tips". Usage is still tracked. */
  enabled: boolean;
  /** Feature id → first time it was used (ms). */
  used: Record<string, number>;
  /** Feature id → the tip about it that was shown. A tip is shown once. */
  tips: Record<string, FeatureTipRecord>;
  lastTipAt: number | null;
}

// Ids from a newer build survive a downgrade, but the file stays bounded.
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_IDS = 256;

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function emptyFeatureTipsState(): FeatureTipsState {
  return { version: 1, enabled: true, used: {}, tips: {}, lastTipAt: null };
}

export function normalizeFeatureTipsState(value: unknown): FeatureTipsState {
  const state = emptyFeatureTipsState();
  if (!value || typeof value !== "object" || Array.isArray(value)) return state;
  const input = value as Record<string, unknown>;
  if (input.version !== 1) return state;
  state.enabled = input.enabled !== false;
  if (input.used && typeof input.used === "object" && !Array.isArray(input.used)) {
    for (const [id, at] of Object.entries(input.used as Record<string, unknown>)) {
      if (Object.keys(state.used).length >= MAX_IDS) break;
      if (ID_PATTERN.test(id) && isTime(at)) state.used[id] = at;
    }
  }
  if (input.tips && typeof input.tips === "object" && !Array.isArray(input.tips)) {
    for (const [id, raw] of Object.entries(input.tips as Record<string, unknown>)) {
      if (Object.keys(state.tips).length >= MAX_IDS) break;
      if (!ID_PATTERN.test(id) || !raw || typeof raw !== "object") continue;
      const record = raw as Record<string, unknown>;
      if (!isTime(record.shownAt)) continue;
      const outcome = OUTCOMES.includes(record.outcome as FeatureTipOutcome)
        ? (record.outcome as FeatureTipOutcome)
        : "shown";
      state.tips[id] = { shownAt: record.shownAt, outcome };
    }
  }
  state.lastTipAt = isTime(input.lastTipAt) ? input.lastTipAt : null;
  return state;
}

/** Records first uses. Unknown ids and repeat uses change nothing. */
export function withFeaturesUsed(state: FeatureTipsState, ids: readonly unknown[], now: number): FeatureTipsState {
  const fresh = [...new Set(ids)].filter(
    (id): id is string => isCatalogFeatureId(id) && state.used[id] === undefined,
  );
  if (fresh.length === 0) return state;
  const used = { ...state.used };
  for (const id of fresh) used[id] = now;
  return { ...state, used };
}

export function withTipShown(state: FeatureTipsState, id: unknown, now: number): FeatureTipsState {
  if (!isCatalogFeatureId(id) || !featureEntry(id)?.tip) return state;
  return {
    ...state,
    tips: { ...state.tips, [id]: { shownAt: now, outcome: "shown" } },
    lastTipAt: now,
  };
}

export function withTipOutcome(state: FeatureTipsState, id: unknown, outcome: unknown, now: number): FeatureTipsState {
  if (!isCatalogFeatureId(id) || !OUTCOMES.includes(outcome as FeatureTipOutcome)) return state;
  const shownAt = state.tips[id]?.shownAt ?? now;
  const next: FeatureTipsState = {
    ...state,
    tips: { ...state.tips, [id]: { shownAt, outcome: outcome as FeatureTipOutcome } },
  };
  if (outcome === "turned-off") next.enabled = false;
  return next;
}

export function withTipsEnabled(state: FeatureTipsState, enabled: unknown): FeatureTipsState {
  return { ...state, enabled: enabled === true };
}

/** Tips already shown may come back. What was used stays used. */
export function withTipsReset(state: FeatureTipsState): FeatureTipsState {
  return { ...state, enabled: true, tips: {}, lastTipAt: null };
}

// ── When a tip may appear ───────────────────────────────────────────────────

export interface FeatureTipsTiming {
  /** Quiet time after the app opens before any tip. */
  settleMs: number;
  /** No key pressed for this long: not typing. */
  idleKeyMs: number;
  /** No pointer move, click or scroll for this long. */
  idlePointerMs: number;
  /** At least this long between two tips. */
  gapMs: number;
  /** How often a calm moment is looked for while a tip is due. */
  pollMs: number;
}

export const FEATURE_TIPS_TIMING: FeatureTipsTiming = {
  settleMs: 3 * 60_000,
  idleKeyMs: 10_000,
  idlePointerMs: 3_000,
  gapMs: 20 * 60 * 60_000,
  pollMs: 5_000,
};

/** Timing for an e2e spec that asked for tips (CODARA_E2E_FEATURE_TIPS=1). */
export const FEATURE_TIPS_TEST_TIMING: FeatureTipsTiming = {
  settleMs: 1_000,
  idleKeyMs: 1_200,
  idlePointerMs: 800,
  gapMs: 0,
  pollMs: 200,
};

export interface FeatureTipsBoot {
  state: FeatureTipsState;
  /** False under the e2e runner unless the spec asked for tips. */
  autoTips: boolean;
  timing: FeatureTipsTiming;
}

/**
 * Whether tips may appear on their own, from the environment. The e2e runner
 * sets SPARK_E2E_BACKGROUND for every spec (playwright.config.ts) and nothing
 * else ever sets it, so its presence alone means a test is driving the app;
 * a spec opts in with CODARA_E2E_FEATURE_TIPS=1.
 */
export function featureTipsMode(env: Record<string, string | undefined>): Omit<FeatureTipsBoot, "state"> {
  if (env.CODARA_E2E_FEATURE_TIPS === "1") return { autoTips: true, timing: FEATURE_TIPS_TEST_TIMING };
  if (env.SPARK_E2E_BACKGROUND !== undefined) return { autoTips: false, timing: FEATURE_TIPS_TIMING };
  return { autoTips: true, timing: FEATURE_TIPS_TIMING };
}

export interface CalmInput {
  now: number;
  startedAt: number;
  lastKeyAt: number;
  lastPointerAt: number;
  timing: FeatureTipsTiming;
}

/** Settled in, not typing, not mid-click. The DOM checks are the caller's. */
export function isCalmMoment(input: CalmInput): boolean {
  return (
    input.now - input.startedAt >= input.timing.settleMs &&
    input.now - input.lastKeyAt >= input.timing.idleKeyMs &&
    input.now - input.lastPointerAt >= input.timing.idlePointerMs
  );
}

/** A tip is due: tips are on, none yet this session, and the gap has passed. */
export function tipDue(state: FeatureTipsState, now: number, timing: FeatureTipsTiming, shownThisSession: boolean): boolean {
  if (!state.enabled || shownThisSession) return false;
  return state.lastTipAt === null || now - state.lastTipAt >= timing.gapMs;
}

/**
 * How long until a tip can be due: the app has settled and the gap since the
 * last tip has passed. The host looks for a calm moment only after that, so a
 * session does not wake every few seconds through a whole day for nothing.
 * Never longer than one full wait, so a clock set back (a last tip in the
 * future) cannot push it out of a timer's range.
 */
export function tipCheckDelay(state: FeatureTipsState, now: number, startedAt: number, timing: FeatureTipsTiming): number {
  const settled = startedAt + timing.settleMs;
  const gapEnds = state.lastTipAt === null ? 0 : state.lastTipAt + timing.gapMs;
  return Math.min(Math.max(0, Math.max(settled, gapEnds) - now), timing.settleMs + timing.gapMs);
}

/** Tips not yet shown about features not yet used, in offer order. */
export function pendingTips(state: FeatureTipsState): FeatureCatalogEntry[] {
  const pending = FEATURE_CATALOG.filter(
    (entry) => entry.tip && state.used[entry.id] === undefined && state.tips[entry.id] === undefined,
  );
  return [...pending.filter((entry) => entry.tip?.fresh), ...pending.filter((entry) => !entry.tip?.fresh)];
}

/** The next tip to offer, the first pending one whose control is on screen. */
export function pickNextTip(
  state: FeatureTipsState,
  isOffered: (entry: FeatureCatalogEntry) => boolean,
): FeatureCatalogEntry | null {
  for (const entry of pendingTips(state)) {
    if (isOffered(entry)) return entry;
  }
  return null;
}

// ── Where a card goes ───────────────────────────────────────────────────────

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export function boxesOverlap(a: Box, b: Box, pad = 0): boolean {
  return (
    a.left < b.left + b.width + pad &&
    b.left < a.left + a.width + pad &&
    a.top < b.top + b.height + pad &&
    b.top < a.top + a.height + pad
  );
}

export interface CornerInput {
  viewport: Size;
  size: Size;
  /** Boxes the card must not cover: the composer, dialogs, menus, toasts. */
  avoid: readonly Box[];
  margin: number;
  /** Bands at the top and bottom the card stays clear of (title and status bars). */
  topInset: number;
  bottomInset: number;
}

/** A corner for the tip card, bottom right first, or null when none is clear. */
export function placeInCorner(input: CornerInput): { left: number; top: number } | null {
  const { viewport, size, margin, topInset, bottomInset } = input;
  if (size.width + margin * 2 > viewport.width) return null;
  if (size.height + margin * 2 + topInset + bottomInset > viewport.height) return null;
  const right = viewport.width - margin - size.width;
  const bottom = viewport.height - bottomInset - margin - size.height;
  const top = topInset + margin;
  const candidates = [
    { left: right, top: bottom },
    { left: margin, top: bottom },
    { left: right, top },
    { left: margin, top },
  ];
  return (
    candidates.find((spot) => !input.avoid.some((box) => boxesOverlap({ ...spot, ...size }, box, 4))) ?? null
  );
}

export interface BesideInput {
  target: Box;
  size: Size;
  viewport: Size;
  avoid: readonly Box[];
  preferred?: FeatureTipPlacement;
  gap: number;
  margin: number;
  /**
   * Bands at the top and bottom the card never enters (title and status
   * bars). The title bar is a window drag region and holds the window
   * controls on Windows, so a card over it would swallow clicks there.
   */
  topInset?: number;
  bottomInset?: number;
}

const FALLBACKS: Record<FeatureTipPlacement, FeatureTipPlacement[]> = {
  bottom: ["bottom", "top", "right", "left"],
  top: ["top", "bottom", "right", "left"],
  right: ["right", "left", "bottom", "top"],
  left: ["left", "right", "bottom", "top"],
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function containsBox(outer: Box, inner: Box): boolean {
  return (
    inner.left >= outer.left &&
    inner.top >= outer.top &&
    inner.left + inner.width <= outer.left + outer.width &&
    inner.top + inner.height <= outer.top + outer.height
  );
}

/**
 * A spot beside the target that fits the window and covers neither the
 * target nor any avoided box. A target inside an avoided box (a button in
 * the composer) is approached from outside that box. Null when no side works.
 */
export function placeBeside(input: BesideInput): { left: number; top: number; placement: FeatureTipPlacement } | null {
  const { target, size, viewport, gap, margin } = input;
  const anchor = input.avoid.find((box) => containsBox(box, target)) ?? target;
  const centerX = target.left + target.width / 2;
  const centerY = target.top + target.height / 2;
  const minTop = Math.max(margin, input.topInset ?? 0);
  const maxBottom = viewport.height - Math.max(margin, input.bottomInset ?? 0);
  for (const placement of FALLBACKS[input.preferred ?? "bottom"]) {
    let left: number;
    let top: number;
    if (placement === "bottom" || placement === "top") {
      top = placement === "bottom" ? anchor.top + anchor.height + gap : anchor.top - gap - size.height;
      left = clamp(centerX - size.width / 2, margin, viewport.width - margin - size.width);
      if (top < minTop || top + size.height > maxBottom) continue;
    } else {
      left = placement === "right" ? anchor.left + anchor.width + gap : anchor.left - gap - size.width;
      top = clamp(centerY - size.height / 2, minTop, maxBottom - size.height);
      if (top < minTop || top + size.height > maxBottom) continue;
      if (left < margin || left + size.width > viewport.width - margin) continue;
    }
    const box = { left, top, ...size };
    if (boxesOverlap(box, target)) continue;
    if (input.avoid.some((avoided) => boxesOverlap(box, avoided, 4))) continue;
    return { left, top, placement };
  }
  return null;
}
