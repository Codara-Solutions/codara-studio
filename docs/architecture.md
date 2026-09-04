# Architecture

Codara Studio is an Electron app. This page maps the moving parts so you can
find the code behind any behavior. File references point at the entry points;
follow the imports from there.

## Processes

| Process | Code | Role |
|---|---|---|
| Main | `src/main/` | Windows, IPC, terminals (node-pty), the agent socket, orchestration, notifications, remote access, auto-update. |
| Preload | `src/preload/index.ts` | Exposes `window.spark`, a typed bridge of about 280 methods over `ipcRenderer.invoke` and prefix-scoped event subscriptions. No raw `ipcRenderer` is exposed. |
| Renderer | `src/renderer/src/` | React 18 UI: `App.tsx` composes workspaces, tabs, terminals, Cora chat, runs, boards, automations, settings. xterm.js with the WebGL addon renders terminals; CodeMirror is the editor; `@xyflow/react` draws run graphs and looms. |
| Preview guests | `<webview>` tags | Chromium guests with node integration off and a locked preload. Driven by the MCP `codara_preview_*` tools through `src/main/main-window-trust.ts` and the preview executor. |
| Child processes | spawned by main | Shells and agent CLIs in PTYs, Pi workers, `git`, `gh`, `ripgrep`, the MCP server (spawned by the CLIs, not by Codara). |

Security boundaries: `sandbox`, `contextIsolation`, and `nodeIntegration: false`
on the main window (`src/main/index.ts`); a navigation allowlist
(`src/main/navigation-allowlist.ts`); every `ipcMain.handle` goes through a
trusted-sender gate (`src/main/ipc.ts`, enforced by
`scripts/test-ipc-gate-default.cjs`); renderer file reads are confined to
workspace roots by `src/main/fs-sandbox.ts`.

## Terminals

`src/main/pty-manager.ts` owns every PTY. Output is coalesced for 16 ms and
shipped to the renderer as a `Uint8Array` per pane with byte-ack backpressure
(256 KB high water). Each session keeps a 4 MB tail for reattach and a 16 MB
detached backlog while a workspace is hidden. Shell integration
(`resources/shell-integration/`, staged by `src/main/shell-init.ts`) adds
OSC 133/633 prompt markers so Codara knows when a command starts and ends.

Every pane's raw stream is also tapped by `src/main/terminal-agent-notify.ts`,
which recognizes Claude Code, Codex, and Grok from their banners and footers
(`src/shared/agent-patterns.ts`), tracks working / blocked / idle, and raises
"finished" and "needs you" notifications through `src/main/notify/`. Hidden
panes are handled here precisely because the renderer cannot see them. An
agent's exit is taken from the shell's prompt markers or the alt-screen
leave when those exist, and otherwise from the process tree: once the agent's
process has been seen under the pane's shell, its disappearance is the exit
(`src/main/owned-process-tree.ts`, one shared `ps` listing per sweep tick).

## The agent socket and MCP server

`src/main/agent-socket.ts` runs a loopback HTTP JSON-RPC server (bearer token,
handshake file `~/.codarastudio/agent-socket.json`). Its methods cover
terminals, preview, chat, accounts, runs, workers, automations, boards, and a
dev-gated `app.*` namespace.

`resources/codara-studio-mcp/server.js` is a stdio MCP server that the CLIs
spawn. It proxies each tool call to the socket. `SPARK_MCP_MODE` selects one of
four rosters at startup: `studio` (preview, terminals, board, whiteboard,
automations for a terminal you run yourself), `worker`, `execute` (spawn and
wait for workers, ask the user, complete), and `automation`. The installer
(`src/main/mcp-installer.ts`) writes the studio entry into `~/.claude.json`,
`~/.codex/config.toml`, and Grok's `config.toml`.

`cli/cora.cjs` speaks the same JSON-RPC (`cli/lib/rpc.cjs`) and reads run
state off disk (`cli/lib/store.cjs`) when the app is closed.

## Claude Code hooks

`src/main/hook-installer.ts` writes a hooks block into
`~/.claude/settings.json` that runs `resources/claude-hooks/codara-hook.py`
for SessionStart, PreToolUse, PostToolUse, UserPromptSubmit, Stop,
SubagentStart, SubagentStop, SessionEnd, Notification, and PreCompact. The
script writes one JSON file per event under `~/.codarastudio/hooks/`;
`src/main/hook-watcher.ts` watches that directory, routes events to the run
store for orchestrated worker panes and to the terminal notifier for panes
you opened yourself, then moves the file to `processed/`. The pane is
identified by the `SPARK_PANE_ID` environment variable Codara sets in every
PTY. Hooks fire for every Claude Code session on the machine, including ones
outside Codara; events without a pane id are dropped.

## Orchestration (Cora)

Everything under `src/main/orchestration/`. The vocabulary is in
[glossary.md](./glossary.md).

- **Runtime.** Cora runs on the bundled Pi coding-agent
  (`@earendil-works/pi-coding-agent`) with the extension in
  `resources/pi-cora/` (prompt, worker policy, repeat guard, compaction, MCP
  bridge, deep search, peer comms). `pi-runtime.ts` and `pi-backend.ts` host
  it; `pi-account-router.ts` picks the subscription.
- **Run store.** `run-store.ts` (20k lines, the largest file in the repo) is
  the state machine for runs: steps, worker tasks and attempts, human
  messages, questions, board, whiteboard, events. State lives in
  `~/.codarastudio/runs/<id>/run.json` plus an `events.jsonl` journal.
- **Workers.** `worker-launch.ts` and `agent-terminal-lifecycle.ts` open a
  pane per worker attempt (Claude, Codex, Grok, or Pi), inject the run's MCP
  roster, and reconcile pane exit with attempt state. Parallel batches are
  computed by `src/shared/parallel-wave.ts`.
- **Automations and looms.** `scheduler.ts` arms triggers (cron, git,
  manual); `automation-loop.ts` drives iterations; `loom-resolve.ts` and
  `loom-steps.ts` execute node graphs of workers, guards, merges, and
  deterministic steps (shell, script, HTTP, file, notification).
- **Manager prompts** live in `resources/orchestration/manager-profile.json`.

## Accounts

One account has two halves. The Cora half is a Pi OAuth credential in
`~/.codarastudio/pi-agent/accounts/<id>/auth.json`. The CLI half is a private
login directory for Claude Code (`CLAUDE_CONFIG_DIR`), Codex (`CODEX_HOME`),
or Grok, with user-state surfaces (projects, settings, history) symlinked to
your personal home by `native-cli-shared-state.ts` so switching feels like
logout and login on one home. "Account 1" is your personal login in the CLI's
default home.

`unified-accounts.ts` is the single mutation path (use, share login, delete,
rename) with per-provider adapters in `account-adapters/`. The Active
account for new terminals is resolved by `active-cli-env-pointer.ts` and
injected into PTY environments by `pty-manager.ts`; running shells follow a
switch through the prompt hooks.

`credential-mirror.ts` keeps the two halves converged: both sides refresh the
same OAuth grant independently and refresh tokens rotate, so whichever side
refreshed last holds the only valid refresh token, and the mirror copies it to
the other side (newer expiry wins, a side without a refresh token never wins,
foreign logins are never adopted, writes go through Pi's lock and the
adapter's atomic store). This is the most bug-prone area of the app because
two independent refreshers share one grant; see the review notes in
`REVIEW.md` for the recommended simplification.

## Notifications

`src/main/notify/` is one pipeline for run events, terminal-agent turns, and
automations: `policy.ts` decides delivery (suppressed while you watch the
exact source, deduped per source, a completion guard swallows the trailing
"needs input"), `deliver.ts` fans out to toast, sound, system notification,
and the notification center, and `attention.ts` tracks what you are looking
at. Phone delivery goes through `remote-access/phone-notify.ts`.

## Remote access

`src/main/remote-access/` pairs a phone over a local listener or the Codara
relay: Noise IK pinned to the desktop's static identity, single-use pairing
secrets with a 2 minute TTL, per-device revocation, an idempotency ledger for
mutations, and terminal leases. `rpc.ts` is the wire protocol; `production.ts`
binds it to the live services. See [remote-access.md](./remote-access.md).

## Persistence

Everything lives under `~/.codarastudio/` (override with `CODARA_HOME_DIR`):
`spark-state.json` (workspaces, tabs), `spark-settings.json`,
`spark-preferences.json`, `runs/`, `hooks/`, `pi-agent/`, `cli/` (managed
account homes), `remote/` (identity, paired devices), `logs/main.log`. The
`spark-` prefixes are the legacy product name kept as an on-disk contract.

## Build and release

`electron-vite` builds main, preload, and renderer into `out/`;
`electron-builder` packages from `out/` plus `extraResources`
(`package.json` build block). `.github/workflows/release.yml` tests, builds,
signs, publishes, and tags on every push to `main`. See
[releasing.md](./releasing.md).
