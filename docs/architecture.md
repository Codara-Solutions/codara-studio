# Architecture

Codara Studio is an Electron app. This page explains how its parts fit
together and why they are built that way. To find a file, use the
[codebase tour](./codebase-tour.md). For the words used here (run, step,
worker, loom, account), see the [glossary](./glossary.md).

## Processes and trust boundaries

| Process | Code | Role |
|---|---|---|
| Main | `src/main/` | Windows, IPC, terminals (node-pty), the agent socket, orchestration, notifications, remote access, auto-update. |
| Preload | `src/preload/index.ts` | Exposes `window.spark`, a typed bridge of about 280 methods. Each method wraps one IPC call (almost always `ipcRenderer.invoke`) or an event subscription with a channel prefix. The raw `ipcRenderer` is never exposed. |
| Renderer | `src/renderer/src/` | React 18 UI. xterm.js with the WebGL addon draws terminals, CodeMirror is the editor, and `@xyflow/react` draws run graphs and looms. |
| Preview guests | `<webview>` tags | Chromium pages with node integration off and a locked preload. Agents drive them through the `codara_preview_*` tools. |
| Child processes | spawned by main | Shells and agent CLIs in PTYs, Cora's Pi processes, `git`, `gh`, `ripgrep`. The CLIs start the MCP server themselves. |

Only the app's own page may call main:

- The main window runs with `sandbox`, `contextIsolation` and
  `nodeIntegration: false` (`src/main/index.ts`).
- A navigation allowlist (`navigation-allowlist.ts`) keeps the main window on
  the app's own page. Every `<webview>` is hardened as it attaches.
- Every `ipcMain.handle` goes through a trusted-sender gate (`handle()` in
  `ipc.ts`, backed by `main-window-trust.ts`). The gate checks the sender
  frame against the live main frame. It does not trust the URL, which a page
  can fake. `scripts/test-ipc-gate-default.cjs` fails if a handler bypasses
  the gate.
- Renderer file **reads** are confined to workspace roots by
  `fs-sandbox.ts`. File writes take any path and rely on the sender gate.

## Terminals

`pty-manager.ts` owns every PTY. A few numbers explain its behavior:

- **16 ms coalescing.** Output is batched and sent to the renderer as one
  `Uint8Array` per pane, which keeps IPC traffic bounded when an agent
  repaints its screen many times a second.
- **Backpressure at 256,000 unacknowledged bytes.** The renderer acknowledges
  what it has drawn. Past that mark main pauses the PTY, and it resumes it
  below 64,000 bytes. A fast producer therefore cannot flood a slow window.
- **A 4 MB tail and a 16 MB detached backlog per session.** The tail lets a
  pane re-attach after its view is rebuilt. The backlog holds output while a
  workspace is hidden.

Shell integration (`resources/shell-integration/`, staged by `shell-init.ts`)
adds OSC 133/633 prompt markers, so Codara knows when a command starts and
ends. The shell files come from the app and are started with it. Your own
`~/.zshrc`, `~/.bashrc` and PowerShell profile are never edited.

`terminal-agent-notify.ts` also reads every pane's raw output. It recognizes
Claude Code, Codex, Grok and Pi from their banners and footers
(`src/shared/agent-patterns.ts`), tracks working, blocked and idle, and
raises "finished" and "needs you" notifications. This runs in main rather
than in the renderer because the renderer cannot see hidden panes. An agent's
exit comes from the shell's prompt markers or from leaving the alternate
screen when those exist. Otherwise it comes from the process tree: once the
agent's process has been seen under the pane's shell, its disappearance is
the exit (`owned-process-tree.ts`, one shared `ps` listing per sweep). Pi
paints OSC 133 marks of its own around every chat message, so in a Pi pane
only the shell's ST-terminated marks count, and the resume line Pi prints
when you quit it is also an exit.

## The agent socket and the MCP server

`agent-socket.ts` runs an HTTP JSON-RPC server on `127.0.0.1`. Callers need
a bearer token: 32 random bytes, compared in constant time. The URL and token
are written to `~/.codarastudio/agent-socket.json` (mode 0600) at every
start. That file is how anything running on the machine for you finds the
app: the MCP server, the `cora` CLI, Cora's Pi processes. Terminals get only
their pane id (`SPARK_AGENT_PANE_ID`), never the token, so programs a pane
runs do not inherit it; a program running as you can still read the file. The
methods cover terminals, preview, chat, accounts, runs, workers,
automations and boards. A dev-only `app.*` namespace lets you inspect the UI
from a terminal. Runs of imported pull requests get a scoped token instead,
limited to a list of methods (`agent-socket-capabilities.ts`).

`resources/codara-studio-mcp/server.js` holds the agent tools. It runs in
two ways:

- **As a stdio MCP server**, which Claude Code, Codex and Grok start from their
  own config. `mcp-installer.ts` writes the `codara-studio` entry into
  `~/.claude.json`, `~/.codex/config.toml` and Grok's `config.toml`. You can
  turn it off for each CLI in the Capability Center.
- **As a library inside Cora's Pi processes.** Pi has no MCP client, so the
  Pi extension `require`s the same file and registers its tools as Pi tools.
  One tool list and one call path therefore serve both.

`SPARK_MCP_MODE` picks the roster once, at startup:

| Mode | Who gets it | Tools |
|---|---|---|
| unset (studio) | a CLI you run yourself, and Cora's chat workers (the worker extension narrows it further, `worker-policy.ts`) | preview, terminals, board, whiteboard |
| `execute` | Cora's manager in a chat | the studio tools plus orchestration (spawn and wait for workers, ask the user, complete) and managing automations |
| `automation` | Cora's manager in an automation run | the studio tools plus the automation tools |
| `worker` | workers of automation (loom) runs | the studio tools without board and whiteboard writes, plus `codara_ask_user` and `codara_request_next_iteration` |

The full list is in [mcp-tools.md](./mcp-tools.md). `cli/cora.cjs` speaks
the same JSON-RPC (`cli/lib/rpc.cjs`). When the app is closed, it reads run
files from disk instead (`cli/lib/store.cjs`).

## Claude Code hooks

`hook-installer.ts` writes a hooks block into `~/.claude/settings.json` for
SessionStart, PreToolUse, PostToolUse, UserPromptSubmit, Stop,
SubagentStart, SubagentStop, SessionEnd, Notification and PreCompact.
Claude Code reads that file for every session on the machine, including
sessions in other terminal apps. The hook command therefore exits at once
unless `SPARK_PANE_ID` is set, which Codara does in every PTY. Inside a
Codara pane it runs `resources/claude-hooks/codara-hook.py`, which writes one
JSON file per event under `~/.codarastudio/hooks/`. `hook-watcher.ts` watches
that folder and passes each event to three places: the terminal notifier
(for panes you opened), the session registry (so a pane can resume its
session after a restart), and the run store (for panes that belong to a
run). Then it moves the file to `processed/`.

## Orchestration (Cora)

Everything is under `src/main/orchestration/`.

**Runtime.** Cora runs on the Pi coding agent (`@earendil-works/pi-coding-agent`)
with the extension in `resources/pi-cora/`: the prompt, the worker policy,
the repeat guard, compaction, the MCP bridge, deep search, peer comms and
Claude login renewal. `resolveCodaraPiRuntime` in `pi-runtime-electron.ts`
uses the Pi the user installed (0.85.1 or newer, found through the `pi` on
their PATH) when there is one, and otherwise the Pi build bundled with the
app. Settings offers `npm install -g` to install Pi, and updates are the
user's. The bundled copy (`resolveCodaraPiLibrary`) is also what the main
process uses as a library for credential storage, sign-in flows and the
model catalog. `pi-backend.ts` and `pi-rpc-client.ts` run Pi as a child
process in RPC mode. `pi-account-router.ts` picks the subscription.

**Manager and workers.** Each chat has one manager Pi process, loaded with
`resources/pi-cora/index.ts`. It is reused from turn to turn until a
launch setting changes (account, model, effort, mode, policy, fast mode). Each worker
attempt is its own Pi process, loaded with `resources/pi-cora/worker.ts`.
Every autonomous worker runs this way. The worker's runtime (`claude`,
`codex` or `grok`) picks the model provider (Anthropic, OpenAI or xAI), not a
CLI (`pi-worker-providers.ts`). A worker can never call orchestration tools
(`worker-policy.ts`). Main writes a worker's activity into a display-only
PTY, and the renderer attaches a pane to it, so a worker looks like a
terminal but cannot be typed into as a shell. `src/shared/parallel-wave.ts`
decides which ready tasks can run side by side. Cora can also open real
terminals: interactive Claude Code, Codex, Grok or Pi sessions for you to drive
(`codara_spawn_terminals`), and terminals the agent drives itself
(`codara_terminal_create`, tracked by `agent-terminal-lifecycle.ts` and
closed when the run ends).

**Run store.** `run-store.ts` is the state machine for runs: steps, worker
tasks and attempts, human messages, questions, the board, the whiteboard.
At about 20,000 lines it is the largest file in the repository. A run lives
in `~/.codarastudio/runs/<id>/run.json`, and every change is also appended to
`events.jsonl` (`event-log.ts`). The same events stream to the UI, so the
chat timeline and the Runs view are rebuilt from them. Because runs are
files, the `cora` CLI can read them while the app is closed, and a run can
recover after a crash.

**Automations and looms.** `scheduler.ts` arms triggers (cron, interval,
folder, git, manual, and others). `automation-loop.ts` starts iterations.
`loom-graph.ts`, `loom-resolve.ts` and `loom-steps.ts` run a loom's graph of
workers, guards, merges and fixed steps (shell, script, HTTP, file,
notification).

**Prompts.** Cora's system prompt is built by `buildCoraPiSystemPrompt` in
`resources/pi-cora/prompt.ts`. Worker briefs come from `worker-prompt.ts`.
`resources/orchestration/manager-profile.json` is the shipped prompt profile
(`prompt-profile.ts`).

## Accounts

### Two halves

An account has two halves:

- The **Cora half** is a Pi OAuth login in
  `~/.codarastudio/pi-agent/accounts/<id>/auth.json`.
- The **CLI half** is the login that Claude Code, Codex or Grok uses in a
  terminal. Where it lives depends on the CLI, as described below.

"Account 1" is your own login in the CLI's default home.

### Claude Code and Codex: every account in one home

Both CLIs run every account in the user's own home, `~/.claude` and
`~/.codex`, exactly as they do in any other terminal app.

- The Active account's login is the one in that home. Every other account's
  login waits in a vault file under `~/.codarastudio` (`claude-cli/` and
  `codex-cli/`).
- A switch moves only the login, the way `/login` as another account does.
  For Claude Code that means the account-scoped secure-storage keys and the
  `oauthAccount` identity (`claude-cli-live-login.ts`). For Codex it means
  `auth.json` (`codex-cli-auth-selector.ts`).
- Everything else exists once and survives every switch: MCP sign-ins,
  settings, history, project trust. A terminal outside Codara sees the same
  account.
- A Claude switch holds Claude Code's own refresh and storage locks and
  closes no session. Running sessions pick up the new login on their next
  request.
- Switches for one CLI take turns through `account-selection-lock.ts`, a lock
  file as well as an in-process queue, because a development build and the
  installed app can run side by side and manage the same `~/.claude` and
  `~/.codex`.

### Grok: one home per account

Grok gives each managed account a private `GROK_HOME` under
`~/.codarastudio/grok-cli/`. Its user state (sessions, skills, memory,
config) is symlinked to the personal home from an allowlist in
`native-cli-shared-state.ts`. An allowlist fails safe: a new name that a Grok
update invents stays private to one account until someone classifies it. New
terminals get the Active account's `GROK_HOME` from `pty-manager.ts`.
Running shells follow a later switch through their prompt hooks, which
re-read the pointer file written by `active-cli-env-pointer.ts`.

### One mutation path

`unified-accounts.ts` is the only code that changes accounts (use, share
login, delete, rename). It serializes every change and calls a per-provider
adapter in `account-adapters/`.

### Keeping the two halves in sync

The providers rotate refresh tokens, or may rotate them: after a refresh,
only the new token works. When two copies of one login refresh on their
own, the slower one ends up holding a spent token.

- **The mirror.** `credential-mirror.ts` copies the newer login to the other
  half. The newer expiry wins. A side without a refresh token never wins.
  A login that belongs to another account is never adopted. Writes go
  through Pi's lock and the adapter's atomic store.
- **One refresher for Claude.** While Studio runs, `claude-login-keeper.ts`
  renews the live Claude login ahead of Claude Code. It works under Claude
  Code's own refresh lock and compare-and-swap, so Claude Code never finds
  the login due. It acts only while the live login is still the Active
  account's: after a `/login` as an account Codara does not know, it leaves
  that login alone.
- **Cora never spends a Claude refresh token.** Its Pi processes register an
  OAuth refresh for the `anthropic` provider
  (`resources/pi-cora/anthropic-refresh.ts`) that asks Studio over the agent
  socket (`accounts.anthropic.renew`). The caller must present the account's
  current refresh token, so the method hands out nothing the process does
  not already hold; scoped processes (imported pull requests, workers) reach
  it through their capability claim. Studio adopts the token in the
  account's Claude slot if it is still good, or renews it through that slot
  (the live home when it holds this account, otherwise its vault), and Pi
  stores the answer. The commit-message helper runs Pi without the
  extension, so Studio renews its credential before starting it.
- **Blanked logins are repaired.** Claude Code blanks its stored login after
  a refresh with a spent token. Codara repairs that login from the Cora half
  and never reads it as a sign-out.

### Following sign-ins made in a terminal

A `/login` or `codex login` as another account Codara knows is followed. Once
a minute and on wake, `UnifiedAccountService.followNativeLogin` looks for
such a sign-in:

- Claude's is recognized by the account Claude Code records in
  `.claude.json`, confirmed against the token itself.
- Codex's is recognized by the account id in `auth.json` together with the
  user, because every member of a Team workspace shares one account id.

That account's slot takes the live login and the marker, and both defaults
(Active and Cora) move to it. The login itself is not changed.

## Notifications

`src/main/notify/` is one pipeline for run events, terminal-agent turns and
automations:

- `policy.ts` decides whether to deliver. Nothing is shown while you watch
  the exact source. Alerts are deduplicated per source. A completion guard
  drops the "needs input" that trails a finished turn.
- `deliver.ts` sends to the toast, sound, system notification and the
  notification center.
- `attention.ts` tracks what you are looking at.

Phone delivery goes through `remote-access/phone-notify.ts`.

## Remote access

`src/main/remote-access/` pairs a phone over a local listener or the Codara
relay.

- **Noise IK** is pinned to the desktop's static key. The relay only ever
  sees ciphertext.
- **Pairing** uses a single-use secret from the QR code that expires after
  2 minutes. It is accepted only from a local address, and you approve the
  device on the desktop.
- **Devices** can be revoked one by one.
- **An idempotency ledger** makes a retried write apply once.
- **Terminal leases** let a phone's terminal survive a dropped connection.
- **No more than the desktop.** A phone names a terminal profile and Studio
  picks the command (`terminal-launch.ts`), the same one the desktop's pane
  menu runs. It may not add the home folder, a disk root, Codara's own home
  or a credentials folder as a workspace (`local-policy.ts`), and its
  `cora.send` calls share a per-device budget.

`rpc.ts` is the wire protocol, and `production.ts` binds it to the live
services. SSH workspaces (`src/main/remote/`) are a separate feature. See
[remote-access.md](./remote-access.md).

## Persistence

Everything Codara owns lives under `~/.codarastudio/` (override with
`CODARA_HOME_DIR`). Settings, workspaces and preferences are JSON files that
keep their legacy `spark-` names as an on-disk contract. The secrets Codara
keeps itself, the OpenRouter key and saved SSH passwords, are encrypted by
the operating system through Electron `safeStorage`. Runs are folders of
files. The complete list, with the module that owns each file, is in the
[codebase tour](./codebase-tour.md#4-where-state-lives-on-disk). The
user-facing version is [on-your-machine.md](./on-your-machine.md).

## Build and release

`electron-vite` builds main, preload and renderer into `out/`
(`electron.vite.config.ts`). `electron-builder` packages `out/` plus the
`extraResources` listed in the `build` block of `package.json`: the MCP
server, the Pi extension, the Claude hook, shell integration, the manager
profile and the `cora` CLI. These ship next to the app, not bundled into
it, so Pi can load the extension's TypeScript and the CLIs can start the
MCP server by path.

Releases are nightly. `.github/workflows/release.yml` runs at 02:17 UTC (or
on demand). It tests, builds, signs, saves the build, tags it and then
publishes. A night with nothing new since the last tag makes no release.
See [releasing.md](./releasing.md).
