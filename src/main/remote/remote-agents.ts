import { createHash } from "node:crypto";
import { parseManualAgentStartupCommand } from "../manual-agent-startup";
import { shQuote } from "./connections";

// Agent CLIs on an SSH machine (Machines, phase 1; docs/machines-plan.md).
//
// An agent started in a remote workspace runs the machine's own CLI with the
// machine's own sign-in. With the `machinesEnabled` preference on (the default), it runs
// inside a tmux session on a private tmux server (`tmux -L codara`), one
// session per pane, so the agent keeps working when Studio quits, the laptop
// sleeps or the connection drops. Opening the pane again attaches to the
// session instead of starting the agent a second time.
//
// The private server never reads the user's ~/.tmux.conf (`-f /dev/null`),
// so their key bindings and status bar never change how the pane behaves,
// and Codara's sessions never show up in their own `tmux ls`.

export type RemoteAgentRuntime = "claude" | "codex" | "grok" | "pi";

export const REMOTE_TMUX_SOCKET = "codara";
const TMUX = `tmux -L ${REMOTE_TMUX_SOCKET} -f /dev/null`;

// smcup@/rmcup@ keep tmux in the normal screen, so what scrolls off the top
// lands in the pane's own scrollback and the wheel scrolls it, as it does
// for an agent running without tmux. escape-time 0 keeps Esc instant in the
// agents' TUIs. With no prefix key, C-b reaches the agent (Claude Code's
// background-task key) and no tmux binding can detach the pane or open a
// second window, so the session still ends when the agent exits. Server and
// global options, so they are set on every launch and apply to sessions
// created after them.
const TMUX_OPTIONS = [
  "set-option -g prefix None",
  "set-option -g prefix2 None",
  "set-option -s escape-time 0",
  "set-option -s terminal-overrides '*:RGB:smcup@:rmcup@'",
  "set-option -g status off",
  "set-option -g history-limit 50000",
  "set-option -g mouse off",
].join(" \\; ");

// tmux before 2.1 lacks the mouse option, and one failed set-option cancels
// the whole \; chain, new-session included: such a tmux counts as none. Sets
// t when tmux is usable; `tmux -V` names releases "tmux 3.4", "tmux 3.3a",
// "tmux next-3.6", "tmux master" or "tmux openbsd-7.5".
const OLD_TMUX_CASE = `case "$v" in "tmux "[01].*|"tmux 2.0"*) ;; *) t=1 ;; esac;`;

/** A machine name printed with printf, where % starts a conversion. */
function printfSafe(text: string): string {
  return text.replace(/%/g, "%%");
}

const RUNTIME_LABEL: Record<RemoteAgentRuntime, string> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok",
  pi: "Pi",
};

/** The agent a remote pane's startup command launches, or null for a plain shell. */
export function remoteAgentRuntime(startup: string | null | undefined): RemoteAgentRuntime | null {
  const parsed = parseManualAgentStartupCommand(startup);
  if (parsed) return parsed.runtime;
  // Pi gets no flags from Studio: the pane menu types a bare `pi`.
  return /^pi(?:\s+--resume)?$/.test(startup?.trim() ?? "") ? "pi" : null;
}

/**
 * The tmux session of a pane. Pane ids are Studio's own, but a restored
 * layout could carry anything, so only tmux-safe characters survive; a hash
 * keeps two ids that differ only in dropped characters apart.
 */
export function remoteAgentSessionName(paneId: string): string {
  const safe = paneId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48);
  if (safe === paneId) return `codara-${safe}`;
  const digest = createHash("sha256").update(paneId).digest("hex").slice(0, 8);
  return `codara-${safe}-${digest}`;
}

function sessionTarget(paneId: string): string {
  // "=" makes tmux match the name exactly instead of by prefix.
  return shQuote(`=${remoteAgentSessionName(paneId)}`);
}

export interface RemoteAgentLaunchInput {
  paneId: string;
  /** The machine's name as the user knows it, for messages. */
  hostLabel: string;
  cols: number;
  rows: number;
  /** A Studio agent command (`claude …`, `codex …`, `grok …`, `pi`). */
  startup: string;
  runtime: RemoteAgentRuntime;
}

/**
 * The line typed into the machine's login shell, after a `cd` into the
 * workspace folder, to start an agent there. It runs under `sh -c` whatever
 * the login shell is (bash, zsh, fish), and:
 *
 * - attaches to the pane's session when one is alive, ignoring the startup
 *   command, so a restored pane never starts a second agent;
 * - otherwise checks that the CLI is installed (in the login shell's PATH,
 *   which is where a user's `~/.local/bin` install is found), and says so
 *   in the pane when it is not;
 * - starts the agent in a new session, or without tmux, with a note, when
 *   tmux is missing or older than 2.1.
 *
 * When the agent exits its session ends, the attach returns, and the pane is
 * back at the shell prompt, as a local agent pane is.
 */
export function buildRemoteAgentLaunch(input: RemoteAgentLaunchInput): string {
  const startup = input.startup.trim();
  const binary = startup.split(/\s+/, 1)[0];
  const label = RUNTIME_LABEL[input.runtime];
  const cols = Math.max(20, input.cols | 0);
  const rows = Math.max(5, input.rows | 0);
  const host = printfSafe(input.hostLabel);
  const missing =
    `\\n${label} is not installed on ${host}, or it is not on the PATH of its login shell.\\n` +
    `Install it on that machine and sign in there, then open a new ${label} tab.\\n\\n`;
  const noTmux =
    `tmux is not installed on ${host}, so this agent stops when Studio disconnects.\\n` +
    `Install tmux there to keep agents running.\\n\\n`;
  // %s takes the version, read on the machine.
  const oldTmux =
    `tmux on ${host} is too old (%s), so this agent stops when Studio disconnects.\\n` +
    `Install tmux 2.1 or newer there to keep agents running.\\n\\n`;
  const session = sessionTarget(input.paneId);
  const script = [
    `t=; v=; if command -v tmux >/dev/null 2>&1; then v=$(tmux -V 2>/dev/null); ${OLD_TMUX_CASE} fi`,
    `if [ -n "$t" ] && ${TMUX} has-session -t ${session} 2>/dev/null; then ` +
      `exec ${TMUX} ${TMUX_OPTIONS} \\; attach-session -t ${session}; fi`,
    `if ! command -v ${shQuote(binary)} >/dev/null 2>&1; then printf ${shQuote(missing)}; exit 0; fi`,
    // -A attaches instead of failing if the session appeared in between. The
    // folder is the one the pane's setup line cd'd into: inside this quoted
    // script a quote in it would break under fish.
    `if [ -n "$t" ]; then exec ${TMUX} ${TMUX_OPTIONS} \\; new-session -A ` +
      `-s ${shQuote(remoteAgentSessionName(input.paneId))} -x ${cols} -y ${rows} -c "$PWD" ${shQuote(startup)}; fi`,
    `if [ -n "$v" ]; then printf ${shQuote(oldTmux)} "\${v#tmux }"; else printf ${shQuote(noTmux)}; fi`,
    `exec ${startup}`,
  ].join("; ");
  return `sh -c ${shQuote(script)}`;
}

// Exec channels run a plain sh, never a login shell: a profile that runs
// `exec fish` or `exec tmux` would swallow the command. tmux may live where
// only the profile's PATH looks (Homebrew, Linuxbrew, Nix, ~/.local/bin),
// so those folders are searched too.
const EXTRA_PATH =
  "/usr/local/bin:/opt/homebrew/bin:/home/linuxbrew/.linuxbrew/bin:/snap/bin:/run/current-system/sw/bin:$HOME/.nix-profile/bin:$HOME/.local/bin:$HOME/bin";

function execScript(command: string): string {
  return `sh -c ${shQuote(`PATH="$PATH:${EXTRA_PATH}"; export PATH; ${command}`)}`;
}

/** Run over an exec channel: exits 0 when the pane has a live agent session. */
export function buildRemoteAgentProbe(paneId: string): string {
  return `${execScript(`${TMUX} has-session -t ${sessionTarget(paneId)}`)} >/dev/null 2>&1`;
}

/** Typed into a plain shell pane whose agent session is alive (a restored pane). */
export function buildRemoteAgentAttach(paneId: string): string {
  return `${TMUX} ${TMUX_OPTIONS} \\; attach-session -t ${sessionTarget(paneId)}`;
}

/** Ends a pane's agent session: the user closed the pane on purpose. */
export function buildRemoteAgentKill(paneId: string): string {
  return `${execScript(`${TMUX} kill-session -t ${sessionTarget(paneId)}`)} >/dev/null 2>&1; true`;
}

/** Printed by `buildRemoteAgentSessionKill` when it ended the session. */
export const SESSION_STOPPED = "codara-stopped";

/**
 * Ends an agent session by its name, for one no pane shows any more (the
 * Machines page lists them). Only Studio's own `codara-` sessions qualify.
 */

export function buildRemoteAgentSessionKill(sessionName: string): string | null {
  if (!/^codara-[A-Za-z0-9_-]{1,64}$/.test(sessionName)) return null;
  const target = shQuote(`=${sessionName}`);
  // Checked on the machine, at the moment of the kill: a client that attached
  // since the last reading is another computer's Codara showing the agent.
  return `${execScript(
    `[ -z "$(${TMUX} list-clients -t ${target} 2>/dev/null)" ] && ${TMUX} kill-session -t ${target} >/dev/null 2>&1 && echo ${SESSION_STOPPED}`,
  )} 2>/dev/null; true`;
}
