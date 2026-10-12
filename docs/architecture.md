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
than in the renderer because the renderer cannot see hidden panes.

A turn starts when a prompt is submitted (Enter outside a paste, an injected
prompt, or Claude's UserPromptSubmit hook) and is announced at most once.
The end comes from the most trusted signal the pane has. For Claude Code that
is the Stop hook of the lead session (subagent stops, tool calls and
background-task follow-ups are not turn ends) and Claude's OSC 7501 program
status, which Codara asks for by answering Claude's `?` query from main. For
Codex it is the notify program (`codex-notify-installer.ts`,
`resources/codex-hooks/`) and the `task_complete` record in Codex's session
file (`codex-rollout-tail.ts`), deduplicated by turn id. Subagents and a
nested `codex exec` run the notify program too, so a notify whose thread is
not the one the pane's Codex holds open is ignored. Permission prompts
come from the Notification hook, AskUserQuestion, OSC 7501 `blocked`,
Codex's "Action Required" window title and its approval notifications. Only agents without any of these
fall back to the screen, and an idle frame must then hold for 1.5 s, because
Claude redraws its "done" footer in the middle of a turn. An Esc or Ctrl+C
pressed during the turn closes it without an alert when the screen is the
only signal; with hooks a Stop still decides, since Claude sends none for a
turn the user stopped. An agent's
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

- **As a stdio MCP server**, which Claude Code and Codex start because Codara
  names it on their command line (see [Per-launch integration](#per-launch-integration)),
  and Grok from the private `config.toml` of a Codara account home. Only the
  opt-in **Codara tools in other apps** setting (`studioToolsInOtherApps`)
  makes `mcp-installer.ts` write the `codara-studio` entry into
  `~/.claude.json`, `~/.codex/config.toml` and Grok's `config.toml`. You can
  turn the server off for each CLI in the Capability Center.
- **As a library inside Cora's Pi processes.** Pi has no MCP client, so the
  Pi extension `require`s the same file and registers its tools as Pi tools.
  One tool list and one call path therefore serve both.

`SPARK_MCP_MODE` picks the roster once, at startup:

| Mode | Who gets it | Tools |
|---|---|---|
| unset (studio) | a CLI you run yourself, and Cora's chat workers (the worker extension narrows it further, `worker-policy.ts`) | preview, terminals, board, whiteboard; a CLI outside a Cora chat also gets the worktree tools |
| `execute` | Cora's manager in a chat | the studio tools plus orchestration (spawn and wait for workers, ask the user, complete), managing automations, and the worktree tools |
| `automation` | Cora's manager in an automation run | the studio tools plus the automation tools |
| `worker` | workers of automation (loom) runs | the studio tools without board and whiteboard writes, plus `codara_ask_user` and `codara_request_next_iteration` |

The full list is in [mcp-tools.md](./mcp-tools.md). `cli/cora.cjs` speaks
the same JSON-RPC (`cli/lib/rpc.cjs`). When the app is closed, it reads run
files from disk instead (`cli/lib/store.cjs`).

### Agent worktrees

`codara_worktree_create`, `_list` and `_remove` map to `worktree.*` on the
socket. The policy lives in `agent-worktrees.ts`, which imports no Electron:
`agent-socket.ts` passes the app in (state, preferences, runs, panes, the
renderer's terminal list, `gh`, the audit log) and the unit suite passes
fakes, against real throwaway repositories.

Who is asking comes from the launch environment only. The MCP server stamps
`runId` (from `SPARK_RUN_ID`), the caller's pane and pid, the client name from
`initialize`, and a role from its mode: `manager` for `execute` and a direct
Cora chat, `worker`, `automation`, `talk` for any other process with a run id,
and `studio` otherwise. The socket refuses workers and automation, and accepts
a run id only from a manager whose run is active and is not an automation.
The repository is the caller's: its run's workspace, or the workspace of the
pane it runs in, resolved to the repository root (a caller inside an agent
worktree acts on the same repository). Imported pull-request runs are refused
like the other execution methods.

Removal is the dangerous half, so it checks twice. A first pass outside any
lock fetches the target, looks for a merged pull request, and collects every
blocker. Then, under a per-repository lock that create and remove share, it
checks again against the commits already fetched, so a commit, an edit or a
new terminal in between is caught (`WORKTREE_CHANGED`). Only then does it
write the recovery ref (create-only), run `git worktree remove` without
`--force`, delete the branch with a compare-and-delete `update-ref`, and drop
the rail row. If git refuses, the refusal stands: the orphan cleanup the
rail's delete uses (a recursive delete once git no longer lists the path) is
off here, because a worktree reached through a symlinked path never matches
git's canonical listing. That order means a failure leaves at worst a stale row, never a
hidden worktree. The renderer hears about the new state through
`state:changed`, disposes what it held for a vanished workspace, and shows a
toast from `workspace:agentEvent`.

## Per-launch integration

Codara never puts its hooks, MCP server or notify program into the user's
own CLI config. `agent-launch-integration.ts` writes them under
`~/.codarastudio/integrations/` at every start (paths of the running binary,
so a moved app never leaves a stale one) and inserts them after the binary
of every Claude Code and Codex launch `pty-manager.ts` makes:

- Claude Code: `--settings integrations/claude/settings.json` (the hooks) and
  `--mcp-config=integrations/claude/mcp-<mode>.json`, one file per
  `SPARK_MCP_MODE`. The `=` form matters: Claude's `--mcp-config` is
  variadic, and in its two-word form a prompt or subcommand after it would
  be read as another config file. A user's own `--settings` wins, since
  Claude keeps the last one, and `--strict-mcp-config` gets no server.
- Codex: `-c mcp_servers.codara-studio={...}`, `-c notify=[...]` chaining the
  user's own `notify`, `-c tui.notifications=true` only when the user left it
  unset, and, for a folder Codara itself launches Codex in, an inline
  `projects` trust entry instead of a write to `config.toml`. Values are
  TOML literal strings, because cmd.exe and Windows PowerShell rewrite
  double quotes and backslashes on the way to the child.

Management subcommands (`claude mcp`, `codex login` and the like) get
nothing. For a command typed in a pane, the shell integration
(`resources/shell-integration/`) defines pane-scoped `claude` and `codex`
functions when `SPARK_AGENT_ARGS_DIR` is set and the user has no function of
that name (an alias that runs the CLI itself still reaches them); they read
`integrations/<cli>/args.txt`, one argument per line, at every call. Fish and
cmd panes have no such functions, so a CLI typed there runs without Codara's
flags and the notifier reads its turns from the screen.

`global-config-cleanup.ts` runs once per start and removes what earlier
builds wrote globally (the hooks block, `_sparkManaged` MCP entries unless
the opt-in is on, the Codex `notify` and its marker block). An MCP entry is
removed only when its `SPARK_HOME_DIR` is this instance's home (or one it was
renamed from, or none for the default home): another home's entry is that
home's opt-in. A temporary home, or a build running from a temporary folder or
a worktree, leaves the user's own CLI configs alone and cleans only throwaway
ones and Codara's managed homes. It backs every
file up under `backups/global-config-cleanup/<time>/` with a manifest,
re-reads each file right before writing and leaves it for the next start if
it changed, and records a report that Settings, About shows.

## Claude Code hooks

The hooks block Codara passes with `--settings` covers SessionStart,
PreToolUse, PostToolUse, UserPromptSubmit, Stop, SubagentStart,
SubagentStop, SessionEnd, Notification and PreCompact. The hook command
exits at once unless `SPARK_PANE_ID` is set, which Codara does in every PTY.
Inside a Codara pane it runs `resources/claude-hooks/codara-hook.py`, which
writes one JSON file per event under `~/.codarastudio/hooks/`. `hook-watcher.ts` watches
that folder and passes each event to three places: the terminal notifier
(for panes you opened), the session registry (so a pane can resume its
session after a restart), and the run store (for panes that belong to a
run). Then it moves the file to `processed/`. Codex's notify program writes into the same
folder with the hook name `CodexNotify`; those events go to the terminal
notifier only.

## Orchestration (Cora)

Everything is under `src/main/orchestration/`.

**Runtime.** Cora runs on the Pi coding agent (`@earendil-works/pi-coding-agent`)
with the extension in `resources/pi-cora/`: the prompt, the worker policy,
the repeat guard, compaction, the MCP bridge, deep search, peer comms and
Claude login renewal. `resolveCodaraPiRuntime` in `pi-runtime-electron.ts`
uses the Pi the user installed (0.85.1 or newer, found through the `pi` on
their PATH) when there is one, and otherwise the Pi build bundled with the
app. If the user's Pi fails to start, that version is skipped until Codara
restarts and the turn retries once on the bundled build, with a note in
the chat. Settings offers `npm install -g` to install Pi, pinned to the tested
minor line (`CODARA_PI_INSTALL_SPEC` in `pi-runtime.ts`), and updates are the
user's. The bundled copy (`resolveCodaraPiLibrary`) is also what the main
process uses as a library for credential storage, sign-in flows and the
model catalog. `pi-backend.ts` and `pi-rpc-client.ts` run Pi as a child
process in RPC mode. `pi-account-router.ts` picks the subscription. Every
launch merges Codara's provider retry budget (and, on Windows, the Git Bash
path) into the `settings.json` of Cora's isolated Pi config directory, so Pi
itself rides out a busy or briefly unreachable provider. Cora runs on local
folders only; an `ssh://` workspace gets a clear error instead of a broken
launch.

**Manager and workers.** Each chat has one manager Pi process, loaded with
`resources/pi-cora/index.ts`. It is reused from turn to turn until a
launch setting changes (account, model, effort, mode, policy, fast mode), and
the restart note names what changed. After an interrupt the same process is
reused once Pi confirms it is idle, unless Pi had not yet accepted the
interrupted prompt (Pi would start that prompt's run after the abort). A
manager process idle for 10 minutes is
stopped, and at most 4 stay alive at once (the least recently used idle one
goes first); the next turn starts a fresh process on the saved session. If
the process crashes mid-turn, the turn fails at once with Pi's stderr in the
technical details, and the run parks with the turn saved for a retry instead
of failing outright. Each worker
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

**Direct lane.** A chat's first message goes through `shouldUseDirectExecution`
(`direct-execution.ts`). A bounded request (a question, a focused fix) runs as
one direct worker that answers you itself, without a manager turn or a
verifier. Broad, parallel, plan-shaped or Studio-surface requests (whiteboard,
board, scheduling) start the manager instead, and a direct chat switches to
the manager in place when a follow-up needs it. In Auto mode the manager also
makes small, low-risk edits (one to three files) itself and spawns workers
only for real work; the `coraAlwaysVerifyEdits` setting (Capability Center > Behavior) restores
the rule that every edit goes through a worker and a verifier.

**Long runs.** The manager records a plan with `codara_plan_update`
(`manager-plan.ts`); a `[CORA RUN STATE]` block with that plan and the newest
worker tasks rides the dynamic part of resume, replay and plan-carrying turns,
and `codara_complete` waits for open milestones. The verification-round
ceiling scales with the number of implementation areas, the spawn brake trips
on batches that keep failing rather than on a raw count and asks you instead
of landing the run, and a Pi worker's continuation after compaction re-sends
its acceptance, verification and report sections and its scratchpad.

**Compaction.** The owner picks the limit in Settings > Behavior
(`coraAutoCompactPercent`, a percentage of the model's window; Auto is the
256k-capped default in `@shared/context-compaction`). It reaches every
runtime per launch and never through a CLI's own config: Pi sessions through
`CODARA_PI_COMPACT_PERCENT`, Codex terminals through
`-c model_auto_compact_token_limit`, Claude terminals through a `--settings`
file in Codara's home (`cli-autocompact.ts`). Inside a Pi session the
extension (`resources/pi-cora/compaction.ts`) pauses at a tool-round
boundary, so a cut never splits a tool call and never lands before the model
has read the round that crossed the limit, and the host compacts and
resumes the same turn (`pi-manager-compaction.ts`, `pi-worker-compaction.ts`).
A failed summary is retried once with a shorter brief and then replaced by a
summary built without a model (`pi-compaction-pipeline.ts`); a compaction
that cannot shrink the context waits for real growth before the next one.
After every compaction the extension re-injects a ledger built from the
transcript (`compaction-ledger.ts`): the user's instructions verbatim, files
changed, errors and their fixes, the plan, workers and artifacts. The
manager never pauses mid-turn after a tool that ends its turn (asking the
user, completing, spawning terminals); it compacts at the turn's end
instead. Between turns the run store can still cut a conversation over to a
fresh session; its note pairs the summary with a block rebuilt from the run
record (`conversation-compaction.ts`), and the ledger carries that note's
verbatim user messages forward into later compactions. `scripts/test-compaction-eval.mjs` replays
240-tool-call runs through all of it.

**Run store.** `run-store.ts` is the state machine for runs: steps, worker
tasks and attempts, human messages, questions, the board, the whiteboard.
At about 20,000 lines it is the largest file in the repository. A run lives
in `~/.codarastudio/runs/<id>/run.json`, and every change is also appended to
`events.jsonl` (`event-log.ts`). The same events stream to the UI, so the
chat timeline and the Runs view are rebuilt from them. Because runs are
files, the `cora` CLI can read them while the app is closed, and a run can
recover after a crash.

**Manager turns.** A run runs one manager turn at a time. `askManagerBackend`
takes a per-run lock (`keyed-task-queue.ts`), and Resume, Retry, answers,
queued-message follow-ups and planning all go through it, because a second
prompt on a Pi session that is still streaming fails, and that failure used
to stop the live turn's process. Resume and Send now return once the run is
"running" and schedule their turn behind the lock. A message sent during a
turn is queued: the live turn never sees it, and the follow-up scheduler
starts the next turn with every queued message once the turn ends. **Send
now** on a queued message (`deliverQueuedMessagesNow`) interrupts the live
turn through `interruptChat` as soon as Pi has accepted its prompt, keeps
that turn's input delivered (its prompt and partial reply are already in
Cora's transcript), and starts the next turn right away, still under the turn
lock, as a chat turn with the queue and a note that the user stopped the
previous reply. A request covers the messages queued when it was made, so a
turn that already took them is never stopped for a later message. Workers
keep running, and Pi's process is reused once it confirms it is idle;
`resources/pi-cora/index.ts` passes the turn's abort to
`codara_wait_for_workers` and `codara_wait_for_automation` so a long wait
does not keep Pi busy. Waiting for Pi to accept the prompt matters: a turn
stopped in its preflight can still record that prompt after the next turn
sent it again.

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
  terminal. It is either the **System login** (whatever the CLI is signed in
  to in its own home, `~/.claude`, `~/.codex` or `~/.grok`) or a **managed**
  login that lives entirely under `~/.codarastudio`.

The list of accounts changes only through the user (`pi-account-profiles.ts`,
registry version 2). A signed-in System login is offered as one line ("Use in
Codara") and never registered on its own. A delete writes a tombstone in the
same registry write, so no later scan, file or sign-in can bring the account
back; only an explicit add does.

### The user's homes are read-only

Codara never writes inside `~/.claude`, `~/.claude.json`, `~/.codex`,
`~/.grok`, a home the user set through `CLAUDE_CONFIG_DIR`, `CODEX_HOME` or
`GROK_HOME`, or the base Claude Code Keychain item. Every write helper asks
`outside-write-guard.ts` first, which also refuses writes through a symlink
into those homes. The few writes the user asks for (the opt-in global
integrations, deleting a session) carry a capability, and the files allowed
to mint one are pinned by `test-outside-write-guard.cjs`. The System login is
read for its identity alone (`system-cli-login.ts`), never for a token, and
Codara never refreshes it or signals a process it did not start.

### Managed homes

`cli-account-homes.ts` builds every managed home under `~/.codarastudio`. Shared
state (projects, sessions, skills, settings, history) is linked into the
user's own home from an allowlist; the login and everything account-scoped
stays private. A name a CLI update invents stays private until someone
classifies it.

Managed Claude homes link `projects` and `sessions` too, because `/resume`
and session pickers list `projects/*.jsonl` and read `sessions/*.json`.

- **Claude Code** runs every managed account in one Codara-owned live slot,
  `claude-cli/live/home`, which is the `CLAUDE_CONFIG_DIR` of every managed
  launch. Each account's login waits in `claude-cli/accounts/<id>/login.json`.
  "Use" swaps the login in the slot atomically under Claude Code's own locks
  (`claude-cli-live-login.ts`), so running managed sessions pick up the new
  account on their next request and nothing is closed. The System login
  means no `CLAUDE_CONFIG_DIR` at all.
- **Codex** gets one `CODEX_HOME` per account, `codex-cli/accounts/<id>/home`.
  A running Codex loads `auth.json` once and refuses a file that names
  another account on its next refresh, so "Use" only changes which home new
  sessions start in.
- **Grok** gets one `GROK_HOME` per account, `grok-cli/accounts/<id>`, with a
  private copy of the user's `config.toml`.

New terminals get the Active account's variable from `pty-manager.ts`.
Running shells follow a later switch through their prompt hooks, which
re-read the pointer file written by `active-cli-env-pointer.ts`.

### One mutation path

`unified-accounts.ts` is the only code that changes accounts (use, share
login, delete, rename). It serializes every change and calls a per-provider
adapter in `account-adapters/`. Deleting an account purges its managed home
at once, or, for a Codex or Grok home a terminal still runs in, once that
terminal exits; the pending purge is recorded in the registry so a crash
cannot leave it behind.

### Keeping the two halves in sync

The providers rotate refresh tokens, or may rotate them: after a refresh,
only the new token works. When two copies of one login refresh on their
own, the slower one ends up holding a spent token.

- **The mirror.** `credential-mirror.ts` copies the newer login between the
  Cora half and a managed CLI half. The newer expiry wins. A side without a
  refresh token never wins. A login that belongs to another account is
  never adopted. A System row is never mirrored.
- **One refresher for Claude.** While Studio runs, `claude-login-keeper.ts`
  renews the managed login in the live slot ahead of Claude Code, under
  Claude Code's own refresh lock and compare-and-swap. It never refreshes
  the System login.
- **Cora never spends a Claude refresh token.** Its Pi processes register an
  OAuth refresh for the `anthropic` provider
  (`resources/pi-cora/anthropic-refresh.ts`) that asks Studio over the agent
  socket (`accounts.anthropic.renew`). The caller must present the account's
  current refresh token, so the method hands out nothing the process does
  not already hold. Studio renews through the account's managed slot; a
  Cora half that borrows the System login's grant is never refreshed, and
  once its access token is spent the auth store records it as `none`, so the
  card offers Connect Cora instead of a refresh that cannot succeed.
- **Blanked logins are repaired.** Claude Code blanks its stored login after
  a refresh with a spent token. Codara repairs that login from the Cora half
  and never reads it as a sign-out.

### Startup and the v1 migration

`unified-account-migration.ts` runs one pass at every launch behind a ready
gate: the one-time accounts v2 migration (`accounts-v2-migration.ts`, which
archives every v1 file under `backups/accounts-v2/` and journals each step
so a crash resumes), then per provider clear-dangling-links,
project-defaults, purge-deleted-homes and start-mirror, then the shell
pointer. No step adds, pairs or adopts an account.

## Notifications

`src/main/notify/` is one pipeline for run events, terminal-agent turns and
automations:

- `policy.ts` decides whether to deliver. Nothing is shown while you watch
  the exact source; for a finished terminal turn, a split that is on screen
  in the focused window counts as watched too (a zoomed split hides the
  others). Alerts are deduplicated per
  source. A completion guard drops the "needs input" that trails a finished
  turn.
- `deliver.ts` sends to the toast, sound, system notification and the
  notification center. A chime within 1.5 s of the previous one of the same
  kind is dropped.
- `attention.ts` tracks what you are looking at.
- `center-store.ts` owns the notification center's history and mutes, and
  pushes a summary (unread, needs-you, mutes) to every window after each
  change. The list operations (folding repeats per source, eviction, age
  limits, settling answered questions) are pure functions in
  `center-model.ts`; the badge rule (`countsAsNeedsYou`) and the "is this
  target on screen" rule live in `src/shared/notify-center.ts` so main and
  the renderer agree. Main cannot see panes, so a question stops counting
  there by being settled: when its source resumes, when its pane is disposed
  (the terminal notifier re-arms the pane) and when its run is deleted (the
  run adapter settles on `run.deleted`). Each window also holds the rows and
  applies the same rule with its own view of closed panes and missing runs,
  so the bell, the **Needs you** tab and the pinned header always agree. A
  question the window finds gone for two seconds is settled in main too
  (`notify:settle`), so the dock badge never counts a question the bell
  does not. Mutes match by source, workspace, agent (`agent:claude-code`,
  `agent:cora`, from the event's kind and title) and automation job.

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

The workspace list has two writers. The renderer saves its whole state
(`state:save`, 200 ms after a change), and the main process edits it through
`updateState` when it adds or drops a workspace itself (an agent worktree, an
issue workspace, `cora start`) and then broadcasts `state:changed`. A renderer
save already in flight at that moment carries the older list, so `storage.ts`
remembers each workspace main added or removed and, for 30 seconds or until a
renderer save agrees, reapplies it to renderer saves that contradict it.

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
