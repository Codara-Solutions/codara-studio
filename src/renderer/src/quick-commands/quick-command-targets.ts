import type { QuickCommand } from "@shared/quick-commands";
import { parseRemotePath } from "@shared/remote";
import type { Workspace } from "@shared/types";
import { findPaneLeaf, leafInjectId } from "../routing/agent-destinations";
import { isDockLeaf } from "../tabs/dock";
import type { Tab, TerminalLeaf, TerminalTab } from "../tabs/types";

// Where a quick command goes, decided from the tab tree alone so the rules
// are testable without React (scripts/test-quick-commands.cjs). The hook in
// useQuickCommandsApi.ts carries the plan out.

export interface PaneRuntimeView {
  cwd?: string;
  altScreenActive?: boolean;
}

export interface FocusedPane {
  tab: TerminalTab;
  leaf: TerminalLeaf;
  /** The id the pty layer and delivery know the pane by. */
  injectId: string;
}

/** What runs in a pane right now: an agent CLI, another full-screen program, or a shell prompt. */
export type PaneActivity = "agent" | "program" | "shell";

/**
 * The repository a workspace belongs to, keyed the way per-repository
 * preferences are: a copy-branch workspace counts as its source repository.
 */
export function repoKeyForWorkspace(workspace: Pick<Workspace, "cwd" | "copyBranch"> | null): string | null {
  if (!workspace) return null;
  return workspace.copyBranch?.repoCwd ?? workspace.cwd;
}

/** A folder as the shell sees it: an SSH workspace's path on its host. */
export function shellFolder(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  return parseRemotePath(cwd)?.path ?? cwd;
}

function terminalCell(tab: Tab | undefined, paneId: string | null | undefined): FocusedPane | null {
  if (!tab || tab.kind !== "terminal" || !paneId) return null;
  const leaf = findPaneLeaf(tab.root, paneId);
  if (!leaf || isDockLeaf(leaf)) return null;
  return { tab, leaf, injectId: leafInjectId(leaf) };
}

/**
 * The terminal a command for "the focused terminal" lands in: the pane named
 * explicitly (a right-click), else the focused pane of the terminal tab on
 * screen, else the terminal pane the user was last in.
 */
export function resolveFocusedPane(
  tabs: readonly Tab[],
  activeTabId: string | null,
  lastPaneId: string | null,
  explicitPaneId?: string | null,
): FocusedPane | null {
  if (explicitPaneId) {
    for (const tab of tabs) {
      if (tab.kind !== "terminal") continue;
      const leaf = findPaneLeaf(tab.root, explicitPaneId);
      if (leaf && !isDockLeaf(leaf)) return { tab, leaf, injectId: leafInjectId(leaf) };
    }
    return null;
  }
  const active = tabs.find((tab) => tab.id === activeTabId);
  if (active?.kind === "terminal") {
    const focused = terminalCell(active, active.activePaneId);
    if (focused) return focused;
  }
  if (!lastPaneId) return null;
  for (const tab of tabs) {
    const found = terminalCell(tab, lastPaneId);
    if (found) return found;
  }
  return null;
}

export function paneActivity(
  leaf: TerminalLeaf,
  runtime: PaneRuntimeView | undefined,
  detected: Readonly<Record<string, true>>,
): PaneActivity {
  const worker = leaf.worker && leaf.worker.agentRunning !== false && leaf.worker.state !== "done" ? leaf.worker : null;
  if (worker || detected[leaf.paneId] || detected[leafInjectId(leaf)]) return "agent";
  if (runtime?.altScreenActive) return "program";
  return "shell";
}

/** The folder a command for this pane runs in. */
export function paneFolder(leaf: TerminalLeaf, runtime: PaneRuntimeView | undefined, workspaceCwd: string | null): string | null {
  return shellFolder(runtime?.cwd ?? leaf.cwd ?? workspaceCwd);
}

export type ShellPlan =
  | { kind: "pane"; pane: FocusedPane }
  /** busy: the focused terminal runs an agent or a full-screen program, so typing there would not reach a shell. */
  | { kind: "new-terminal"; fallback?: "busy" | "none" }
  /** Press Enter is off and no shell can take the text: nothing is typed or run. */
  | { kind: "refuse"; reason: "busy" | "none" };

/**
 * A command with Press Enter off is typed for the user to finish, so it is
 * never run anywhere else: a new terminal would run it at once, which is
 * exactly what the user turned off (think `git reset --hard` kept as a draft).
 */
export function planShellCommand(
  command: Extract<QuickCommand, { kind: "shell" }>,
  focused: FocusedPane | null,
  activity: PaneActivity | null,
): ShellPlan {
  if (command.target === "new") return { kind: "new-terminal" };
  if (focused && activity === "shell") return { kind: "pane", pane: focused };
  const reason = focused ? "busy" : "none";
  if (!command.submit) return { kind: "refuse", reason };
  return { kind: "new-terminal", fallback: reason };
}

export type PromptPlan =
  | { kind: "pane"; pane: FocusedPane }
  | { kind: "chat"; runId: string }
  | { kind: "new-chat" }
  | { kind: "new-agent"; agent: Extract<QuickCommand, { kind: "prompt" }>["agent"] }
  | { kind: "refuse"; reason: "no-agent" };

/**
 * A prompt for the focused agent needs an agent there: pasting it into a
 * shell would run it as a command. Cora takes the chat open in this
 * workspace, or a new chat when none is.
 */
export function planPrompt(
  command: Extract<QuickCommand, { kind: "prompt" }>,
  focused: FocusedPane | null,
  activity: PaneActivity | null,
  openChatRunId: string | null,
): PromptPlan {
  if (command.target === "new") return { kind: "new-agent", agent: command.agent };
  if (command.target === "cora") return openChatRunId ? { kind: "chat", runId: openChatRunId } : { kind: "new-chat" };
  if (!focused || activity !== "agent") return { kind: "refuse", reason: "no-agent" };
  return { kind: "pane", pane: focused };
}

/**
 * A freshly started agent takes a prompt once its runtime reports it idle at
 * its input; until then the paste could land in the shell or the CLI's
 * start-up screen.
 */
export function agentPaneReady(leaf: TerminalLeaf | null): boolean {
  const worker = leaf?.worker;
  return !!worker && worker.agentRunning !== false && worker.runtimeState === "idle";
}

/** The only pane of a tab Codara just opened for a new agent. */
export function newAgentPane(tabs: readonly Tab[], tabId: string): FocusedPane | null {
  const tab = tabs.find((candidate) => candidate.id === tabId);
  if (!tab || tab.kind !== "terminal" || tab.root.kind !== "leaf") return null;
  return { tab, leaf: tab.root, injectId: leafInjectId(tab.root) };
}
