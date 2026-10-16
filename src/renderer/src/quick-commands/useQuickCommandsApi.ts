import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  expandQuickCommandText,
  quickCommandShellKind,
  normalizeQuickCommands,
  normalizeTerminalRightClick,
  quickCommandBody,
  quickCommandVariablesIn,
  sameRepoKey,
  type PromptQuickCommand,
  type QuickCommand,
  type QuickCommandAgent,
  type QuickCommandVariable,
  type ShellQuickCommand,
  type TerminalRightClickPref,
} from "@shared/quick-commands";
import { isRemotePath } from "@shared/remote";
import type { RunState, ShellInfo, Workspace } from "@shared/types";
import { emitLocalToast } from "../notifications/local-toast";
import { recordFeatureUse } from "../components/feature-tips/feature-usage";
import { usePreferences } from "../preferences/usePreferences";
import { runtimeLabel } from "../routing/agent-destinations";
import type { SelectionRoutingApi } from "../routing/SelectionRoutingContext";
import type { Tab } from "../tabs/types";
import {
  CLAUDE_LAUNCH_COMMAND,
  CODEX_LAUNCH_COMMAND,
  GROK_LAUNCH_COMMAND,
  PI_LAUNCH_COMMAND,
} from "../workers/launch-commands";
import type { UseTabsApi } from "../tabs/useTabs";
import type { QuickCommandRepoOption, QuickCommandsApi, RunQuickCommandOptions } from "./QuickCommandsContext";
import {
  agentPaneReady,
  newAgentPane,
  paneActivity,
  paneFolder,
  planPrompt,
  planShellCommand,
  repoKeyForWorkspace,
  resolveFocusedPane,
  shellFolder,
  type FocusedPane,
  type PaneRuntimeView,
} from "./quick-command-targets";

// The run path every quick command surface shares, and the saved list. Kept
// out of App.tsx like useSelectionRoutingApi; the decisions themselves are
// the pure functions in quick-command-targets.ts.

const AGENT_READY_TIMEOUT_MS = 60_000;
const AGENT_READY_POLL_MS = 250;
// A runtime reports idle as soon as its input box is drawn; give it a beat to
// take keys before the paste arrives.
const AGENT_READY_SETTLE_MS = 400;

export interface QuickCommandsInputs {
  activeWorkspace: Workspace | null;
  workspaces: readonly Workspace[];
  runs: readonly RunState[];
  activeRunId: string | null;
  tabsRef: { readonly current: UseTabsApi };
  activeTab: Tab | null;
  activePaneId: string | null;
  detectedAgents: Readonly<Record<string, true>>;
  /** The shell terminals open with; decides how {cwd} is quoted. */
  shell: ShellInfo | null;
  paneRuntime: { readonly current: ReadonlyMap<string, PaneRuntimeView> };
  routing: SelectionRoutingApi;
  /** Opens a new terminal tab running an agent launch command and returns its tab id. */
  launchAgent: (launchCommand: string, cwd: string | undefined) => string;
}

const LAUNCH_COMMANDS: Record<QuickCommandAgent, string> = {
  claude: CLAUDE_LAUNCH_COMMAND,
  codex: CODEX_LAUNCH_COMMAND,
  grok: GROK_LAUNCH_COMMAND,
  pi: PI_LAUNCH_COMMAND,
};

function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1) || trimmed;
}

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

function warn(title: string, body = ""): void {
  emitLocalToast(title, body, "warning");
}

function variableProblem(command: QuickCommand, variable: QuickCommandVariable, reason: "missing" | "unsafe", folder: string | null): void {
  if (reason === "missing") {
    warn(
      variable === "branch" ? "No git branch here" : "No folder for {cwd}",
      variable === "branch"
        ? `"${command.label}" uses {branch}, and ${folder ?? "this folder"} is not on a git branch.`
        : `"${command.label}" uses {cwd}, and this terminal has no known folder.`,
    );
    return;
  }
  warn(
    `"${command.label}" did not run`,
    variable === "cwd"
      ? "The folder name has a line break or a character this shell cannot take inside quotes."
      : `The {${variable}} value has characters a shell would read as code.`,
  );
}

export function useQuickCommandsApi(inputs: QuickCommandsInputs): QuickCommandsApi {
  const { activeWorkspace, workspaces, tabsRef, activeTab, activePaneId } = inputs;
  const { preferences, hydrated, setPreference } = usePreferences();

  const commands = useMemo(() => normalizeQuickCommands(preferences.quickCommands), [preferences.quickCommands]);
  const terminalRightClick = normalizeTerminalRightClick(preferences.terminalRightClick);

  // The terminal pane the user was last in: "the focused terminal" when the
  // command runs from a chat or a browser tab.
  const lastPaneId = useRef<string | null>(null);
  useEffect(() => {
    if (activeTab?.kind === "terminal" && activePaneId) lastPaneId.current = activePaneId;
  }, [activeTab, activePaneId]);

  // The run path reads live state through one ref so the API object only
  // changes when what the surfaces render changes.
  const live = useRef(inputs);
  live.current = inputs;

  const repoKey = repoKeyForWorkspace(activeWorkspace);
  const repoOptions = useMemo<QuickCommandRepoOption[]>(() => {
    const out: Array<{ key: string; names: string[] }> = [];
    for (const workspace of workspaces) {
      const key = repoKeyForWorkspace(workspace);
      if (!key) continue;
      const existing = out.find((option) => sameRepoKey(option.key, key));
      if (existing) {
        if (!existing.names.includes(workspace.name)) existing.names.push(workspace.name);
      } else {
        out.push({ key, names: [workspace.name] });
      }
    }
    return out.map(({ key, names }) => ({
      key,
      label: `${baseName(key)}${names.length && names[0] !== baseName(key) ? ` (${names.slice(0, 2).join(", ")}${names.length > 2 ? `, +${names.length - 2}` : ""})` : ""}`,
    }));
  }, [workspaces]);

  const allTabs = useCallback((): Tab[] => {
    const current = tabsRef.current;
    return [...current.tabs, ...current.inactiveWorkspaceLayouts.flatMap((layout) => layout.tabs)];
  }, [tabsRef]);

  // The pane the command went to takes the keyboard, as if clicked, once
  // its tab is on screen.
  const focusPane = useCallback((pane: FocusedPane) => {
    const current = tabsRef.current;
    if (!current.tabs.some((tab) => tab.id === pane.tab.id)) return;
    current.setActiveTab(pane.tab.id);
    current.setActiveTerminalPane(pane.tab.id, pane.leaf.paneId);
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() => {
        if (document.querySelector('[aria-modal="true"]')) return;
        document
          .querySelector<HTMLElement>(`[data-terminal-pane-id="${CSS.escape(pane.leaf.paneId)}"] .xterm-helper-textarea`)
          ?.focus();
      }),
    );
  }, [tabsRef]);

  const expand = useCallback(
    async (command: QuickCommand, folder: string | null, mode: "shell" | "prompt"): Promise<string | null> => {
      const body = quickCommandBody(command);
      const used = quickCommandVariablesIn(body);
      const workspace = live.current.activeWorkspace;
      const values: Partial<Record<QuickCommandVariable, string | null>> = {};
      if (used.has("cwd")) values.cwd = folder;
      if (used.has("branch")) {
        // An SSH workspace's folders exist only on its host; git there is
        // reached through the workspace's own ssh:// path.
        const where = workspace && isRemotePath(workspace.cwd) ? workspace.cwd : folder ?? workspace?.cwd ?? null;
        values.branch = where ? await window.spark.git.currentBranch(where).catch(() => null) : null;
      }
      const result = expandQuickCommandText(body, values, mode, quickCommandShellKind(live.current.shell));
      if (!result.ok) {
        variableProblem(command, result.variable, result.reason, folder);
        return null;
      }
      return result.text;
    },
    [],
  );

  const runShell = useCallback(
    async (command: ShellQuickCommand, workspace: Workspace, options?: RunQuickCommandOptions) => {
      const state = live.current;
      const current = state.tabsRef.current;
      const focused = resolveFocusedPane(current.tabs, current.activeId, lastPaneId.current, options?.paneId);
      const activity = focused ? paneActivity(focused.leaf, state.paneRuntime.current.get(focused.leaf.paneId), state.detectedAgents) : null;
      const plan = planShellCommand(command, focused, activity);
      if (plan.kind === "refuse") {
        warn(
          `"${command.label}" was not typed`,
          plan.reason === "busy"
            ? "It waits for you to press Enter, and the focused terminal is running an agent or a full-screen program. Click into a shell, then run it again."
            : "It waits for you to press Enter, and no terminal is focused. Click into a terminal, then run it again.",
        );
        return;
      }
      if (plan.kind === "pane") {
        const folder = paneFolder(plan.pane.leaf, state.paneRuntime.current.get(plan.pane.leaf.paneId), workspace.cwd);
        const text = await expand(command, folder, "shell");
        if (text === null) return;
        focusPane(plan.pane);
        await window.spark.pty.inject(plan.pane.injectId, text, { submit: command.submit });
        return;
      }
      const text = await expand(command, shellFolder(workspace.cwd), "shell");
      if (text === null) return;
      tabsRef.current.newTerminalTab(workspace.cwd, text, { title: command.label });
      if (plan.fallback === "busy") {
        emitLocalToast(`"${command.label}" ran in a new terminal`, "The focused terminal is running an agent or a full-screen program.", "success");
      }
    },
    [expand, focusPane, tabsRef],
  );

  const deliverToPane = useCallback(
    async (workspace: Workspace, pane: FocusedPane, text: string, submit: boolean) => {
      await window.spark.agentDelivery.deliver({
        workspaceId: workspace.id,
        target: { kind: "pane", paneId: pane.injectId },
        text,
        submit,
        source: "quick-command",
      });
    },
    [],
  );

  const sendToNewAgent = useCallback(
    async (command: PromptQuickCommand, workspace: Workspace, agent: QuickCommandAgent) => {
      const text = await expand(command, shellFolder(workspace.cwd), "prompt");
      if (text === null) return;
      const tabId = live.current.launchAgent(LAUNCH_COMMANDS[agent], workspace.cwd);
      const name = runtimeLabel(agent) ?? agent;
      const started = Date.now();
      while (Date.now() - started < AGENT_READY_TIMEOUT_MS) {
        await sleep(AGENT_READY_POLL_MS);
        const tabs = allTabs();
        if (!tabs.some((tab) => tab.id === tabId)) return;
        const pane = newAgentPane(tabs, tabId);
        if (pane && agentPaneReady(pane.leaf)) {
          await sleep(AGENT_READY_SETTLE_MS);
          await deliverToPane(workspace, pane, text, command.submit);
          return;
        }
      }
      await window.spark.clipboard.writeText(text).catch(() => undefined);
      warn(`${name} did not get ready in time`, "The prompt was not sent. It is on the clipboard.");
    },
    [allTabs, deliverToPane, expand],
  );

  const runPrompt = useCallback(
    async (command: PromptQuickCommand, workspace: Workspace, options?: RunQuickCommandOptions) => {
      const state = live.current;
      const current = state.tabsRef.current;
      const focused = command.target === "focused"
        ? resolveFocusedPane(current.tabs, current.activeId, lastPaneId.current, options?.paneId)
        : null;
      const activity = focused ? paneActivity(focused.leaf, state.paneRuntime.current.get(focused.leaf.paneId), state.detectedAgents) : null;
      const openChat = state.runs.find((run) => run.id === state.activeRunId && run.workspaceId === workspace.id)?.id ?? null;
      const plan = planPrompt(command, focused, activity, openChat);
      switch (plan.kind) {
        case "refuse":
          warn("No agent in the focused terminal", "Click into a terminal running Claude Code, Codex, Grok or Pi, then run it again.");
          return;
        case "pane": {
          // Nothing runs in a sleeping pane to take the prompt. Opening it
          // wakes the agent; the prompt is not queued behind that.
          if (plan.pane.leaf.hibernation) {
            focusPane(plan.pane);
            warn(`"${command.label}" was not sent`, "The agent in that terminal was asleep and is waking up now. Run the command again once it is back.");
            return;
          }
          const folder = paneFolder(plan.pane.leaf, state.paneRuntime.current.get(plan.pane.leaf.paneId), workspace.cwd);
          const text = await expand(command, folder, "prompt");
          if (text === null) return;
          focusPane(plan.pane);
          await deliverToPane(workspace, plan.pane, text, command.submit);
          return;
        }
        case "chat": {
          const text = await expand(command, shellFolder(workspace.cwd), "prompt");
          if (text === null) return;
          await window.spark.agentDelivery.deliver({
            workspaceId: workspace.id,
            target: { kind: "chat", runId: plan.runId },
            text,
            source: "quick-command",
          });
          tabsRef.current.openChatTab({ runId: plan.runId, focus: true });
          return;
        }
        case "new-chat": {
          const text = await expand(command, shellFolder(workspace.cwd), "prompt");
          if (text === null) return;
          await state.routing.route({ source: "tab", text }, "chat-new");
          return;
        }
        case "new-agent":
          await sendToNewAgent(command, workspace, plan.agent);
          return;
      }
    },
    [deliverToPane, expand, focusPane, sendToNewAgent, tabsRef],
  );

  const run = useCallback(
    async (command: QuickCommand, options?: RunQuickCommandOptions) => {
      const workspace = live.current.activeWorkspace;
      if (!workspace) {
        warn("Open a workspace first", "Quick commands run in the workspace on screen.");
        return;
      }
      recordFeatureUse("quick-commands");
      try {
        if (command.kind === "shell") await runShell(command, workspace, options);
        else await runPrompt(command, workspace, options);
      } catch (error) {
        warn(`"${command.label}" did not run`, error instanceof Error ? error.message : String(error));
      }
    },
    [runPrompt, runShell],
  );

  const save = useCallback(
    (next: QuickCommand[]) => {
      recordFeatureUse("quick-commands");
      return setPreference("quickCommands", normalizeQuickCommands(next));
    },
    [setPreference],
  );
  const setTerminalRightClick = useCallback(
    (pref: TerminalRightClickPref) => setPreference("terminalRightClick", pref),
    [setPreference],
  );

  return useMemo(
    () => ({
      commands,
      hydrated,
      workspaceId: activeWorkspace?.id ?? null,
      repoKey,
      repoName: repoKey ? baseName(repoKey) : null,
      repoOptions,
      terminalRightClick,
      run,
      save,
      setTerminalRightClick,
    }),
    [activeWorkspace?.id, commands, hydrated, repoKey, repoOptions, run, save, setTerminalRightClick, terminalRightClick],
  );
}
