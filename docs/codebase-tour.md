# Codebase tour

This page tells you where things are in the code. Read it on your first day,
then keep it open as a map.

- For **why** things work the way they do (design choices, rules, security
  boundaries), read [architecture.md](./architecture.md).
- For the words the code uses (run, step, worker, loom, account), read
  [glossary.md](./glossary.md).

File names below are real. Where a function name is given, search for it: line
numbers change too often to be worth listing.

## 1. The repository

| Path | What is there |
|---|---|
| `src/main/` | The Electron main process (Node.js). Windows, IPC, terminals, the agent socket, notifications, git and GitHub, remote access. |
| `src/main/orchestration/` | Cora and everything around her: runs, steps, workers, the Pi runtime, automations and looms, accounts. Nearly half of the main-process code. |
| `src/preload/` | `index.ts` is the bridge the UI calls (`window.spark`). `inspector-preload.ts` runs inside pages shown in the preview browser. |
| `src/renderer/` | The React UI. `index.html` loads `src/main.tsx`, which renders `src/App.tsx`. |
| `src/shared/` | Types and pure helpers used by both main and renderer, imported as `@shared/...`. `types.ts` holds most data shapes (`RunState`, `AppSettings`, ...). |
| `resources/` | Files shipped next to the app, not bundled into it: the MCP server, the Pi extension that is Cora, the Claude Code hook, shell integration, the manager profile. |
| `cli/` | The `cora` command-line tool (`cora.cjs`, `commands/`, `lib/`) and its benchmark (`bench/`). |
| `scripts/` | Unit test suites, dev harnesses, install hooks and the release pipeline. See [scripts/README.md](../scripts/README.md). |
| `tests/e2e/` | Playwright specs that boot the built app. |
| `build/` | Icons and the macOS entitlements file used when packaging. |
| `docs/` | User guides, this tour, the architecture page, the release process. |
| `.github/` | CI (`ci.yml`), the nightly release (`release.yml`), issue and PR templates, CODEOWNERS. |

Some files are very large. Search inside them rather than reading from the top:

| File | Lines (approx.) | What it holds |
|---|---|---|
| `src/main/orchestration/run-store.ts` | 20,000 | The run state machine, run files on disk, worker launches. |
| `src/renderer/src/App.tsx` | 7,700 | The top-level component: workspaces, tabs, shortcuts, dialogs. |
| `src/main/remote-access/rpc.ts` | 6,000 | The phone protocol. |
| `src/main/agent-socket.ts` | 5,800 | Every JSON-RPC method agents and the CLI can call. |
| `src/shared/types.ts` | 5,200 | Shared types. |
| `src/main/ipc.ts` | 3,700 | Every IPC handler the UI can call. |
| `src/main/pty-manager.ts` | 2,900 | Every terminal process. |

## 2. Processes and how they talk

```
 Renderer (React)                 Main process (Node)                 Child processes
 src/renderer/src ──window.spark──▶ src/main/ipc.ts                    ┌─ shells and agent CLIs in PTYs
      ▲            (preload)          │                                │  (claude, codex, grok, pi)
      │  events (webContents.send)    ├─ pty-manager.ts ───────────────┤
      └───────────────────────────────┤                                ├─ Pi processes for Cora
                                      ├─ orchestration/ ── pi-rpc-client ┘  (one manager per chat,
                                      │                                     one per worker attempt)
                                      ├─ agent-socket.ts ◀── HTTP JSON-RPC ── codara-studio MCP server
                                      │   (127.0.0.1, bearer token)      ── cora CLI
                                      │                                  ── Pi extension (in-process bridge)
                                      ├─ hook-watcher.ts ◀── JSON files ── codara-hook.py (Claude Code hooks)
                                      └─ remote-access/  ◀── Noise IK ─── phone (LAN or relay)
```

| Process | Started by | Code | How it reaches main |
|---|---|---|---|
| Main | Electron | `src/main/index.ts` (boot is the `app.whenReady()` block) | - |
| Renderer | `createWindow()` in `index.ts` | `src/renderer/src/` | `window.spark.*` calls become `ipcRenderer.invoke` on channels handled in `ipc.ts`. Main pushes events back with `webContents.send`. |
| Preview pages | the `<webview>` in `BrowserPane.tsx` | any web page, plus `src/preload/inspector-preload.ts` | None: they are untrusted. The renderer runs DOM actions in them with `executeJavaScript`, and main sends trusted input over the Chrome DevTools Protocol. |
| Shells and agent CLIs | `pty-manager.ts` (node-pty) | your shell, `claude`, `codex`, `grok`, `pi` | Terminal bytes. Every PTY gets `SPARK_PANE_ID` and `SPARK_AGENT_PANE_ID`, but not the agent socket's token: tools that call the app read `agent-socket.json`. A local pane also gets its own token for `pane.open` only, which `codara-pane` (on the pane's PATH) uses to open an overlay over the pane or a tab beside it. |
| Pi (Cora's manager and workers) | `pi-rpc-client.ts` | the Pi package, run with `--mode rpc` and the extension in `resources/pi-cora/` | Pi's RPC protocol on stdin and stdout. The extension loads the MCP server's code in-process and calls the agent socket. |
| `codara-studio` MCP server | Claude Code or Codex, from the flags Codara launches them with; Grok, from its Codara account home's config | `resources/codara-studio-mcp/server.js` | HTTP JSON-RPC to the agent socket. `agent-launch-integration.ts` builds the flags; `mcp-installer.ts` writes global entries only for the opt-in. |
| `cora` CLI | you | `cli/cora.cjs` | HTTP JSON-RPC to the agent socket. Reads run files directly when the app is closed. |
| Claude Code hook | Claude Code, from the `--settings` file Codara launches it with | `resources/claude-hooks/codara-hook.py` | Writes one JSON file per event under `~/.codarastudio/hooks/`. |

One more loopback server, `hook-rpc.ts`, lets an agent report its own state
(`SPARK_HOOK_URL`). `preview-bridge.ts` and `terminal-bridge.ts` are IPC
request and response channels that let main ask the renderer to act, because
tabs and panes belong to the renderer.

## 3. The main flows

### 3.1 Opening a terminal and launching an agent

1. **Choosing what to launch.** The tab bar's "+" menu (`tabs/TabBar.tsx`),
   the pane toolbar (`AddPaneMenu` in `tabs/TerminalStack.tsx`) and keyboard
   commands (`shortcuts/commands.ts`, handled in `App.tsx`) all end in
   `App.tsx` helpers such as `handleNewTerminalTab`, `handleNewWorkerPane` and
   `launchWorkerInNewTerminalTab`. The command strings live in
   `workers/launch-commands.ts`: `CLAUDE_LAUNCH_COMMAND`,
   `CODEX_LAUNCH_COMMAND`, `GROK_LAUNCH_COMMAND` and `PI_LAUNCH_COMMAND`
   (plain `pi`).
2. **The pane.** `tabs/useTabs.ts` adds a leaf to the tab's pane tree
   (`tabs/paneTree.ts`). The command to run is stored on the leaf as
   `autorun`. `TerminalStack.tsx` renders a `TerminalPane` for each leaf.
3. **The xterm.** `components/Terminal/useTerminalSession.ts` creates the
   xterm and calls `window.spark.pty.spawn({ id, shell, cwd, cols, rows, env,
   startupCommand, ... })`. Output arrives on `pty.onData`. The renderer
   acknowledges bytes with `pty.ack`, which is how main applies backpressure.
4. **Main.** The `pty:spawn` handler in `ipc.ts` calls `spawn` in
   `pty-manager.ts`. For a Studio-generated `claude`, `codex` or `grok`
   command, `manual-agent-startup.ts` checks the command against an allowlist
   and `binary-resolver.ts` finds the binary. `spawn` also resolves the
   CLI's account (for Grok, the Active account's `GROK_HOME`), makes sure
   Codex trusts the folder, and installs the Claude hooks. `doSpawn` builds
   the environment and starts node-pty. The startup command is passed to
   the shell (`withStartupCommand`), so it runs once the shell is ready.
5. **Shell integration.** `shell-init.ts` copies the scripts in
   `resources/shell-integration/` to `~/.cache/spark/shell-integration/`
   and starts the shell with them. They print OSC 133 and 633 markers, which
   tell Codara where each command starts and ends. They also let a running
   shell follow a later account switch.
6. **After launch.** `terminal-agent-notify.ts` taps every pane's raw output.
   It recognizes Claude Code, Codex, Grok and Pi with the patterns in
   `src/shared/agent-patterns.ts` and tracks working, blocked and idle. It
   raises notifications through `src/main/notify/`. For Claude Code, the hook
   events handled by `hook-watcher.ts` add detail, and
   `agent-session-registry.ts` records the session id so the pane can resume
   it after a restart. Codex sessions are found by `codex-session-tracker.ts`,
   and Pi sessions by `pi-session-tracker.ts`, which matches the session
   files Pi names by creation time to the Pi process running in each pane.

Related: `agent-runtimes.ts` checks which CLIs are installed (for the UI).
`providers/` describes the Claude, Codex and Grok command lines; it is used
by that check, by `worker-sessions.ts` and by `run-store.ts`.

### 3.2 A Cora run, from message to workers

1. **Sending.** `components/chat/ChatComposer.tsx` sends the message. The
   first message of a chat goes through `startChat` in
   `components/OrchestrationSidebar.tsx`, which calls
   `window.spark.orchestration.createRun` and then `startAutopilot`. Later
   messages call `addRunMessage`.
2. **IPC.** The `orchestration:*` handlers in `ipc.ts` load `run-store.ts`
   and call the function of the same name.
3. **The run store.** `startAutopilot` and `addRunMessage` in `run-store.ts`
   record the message, then schedule a manager turn. A run has at most one
   manager turn at a time: every path that starts one goes through the
   per-run turn lock in `askManagerBackend`. A message sent while a turn is
   running is queued, and `scheduleQueuedSteeringFollowup` starts the next
   turn with it once the current one ends. **Send now** on a queued bubble
   calls `deliverQueuedMessagesNow`, which interrupts the live turn and
   starts the next one with every queued message; **Unqueue** calls
   `cancelQueuedMessage`. The bubbles and both controls are in
   `components/chat/ChatConversation.tsx`.
4. **The manager turn.** `askManagerBackend` picks the account
   (`pi-account-router.ts`) and builds the turn prompt
   (`agent-backend.ts`). It then calls the only backend in
   `backend-registry.ts`, which is `pi-backend.ts`. `pi-backend.ts` keeps one
   Pi process per chat. `pi-runtime-electron.ts` builds the launch plan
   (`createCodaraPiLaunchPlan`), and `pi-rpc-client.ts` starts the process and
   speaks Pi's RPC protocol. `pi-turn.ts` collects the turn's events, which are
   streamed to the UI as `chat.*` events.
5. **Cora's tools.** Pi loads `resources/pi-cora/index.ts`. The extension adds
   Cora's system prompt (`prompt.ts`) and loads
   `resources/codara-studio-mcp/server.js` in-process as a library. Every tool
   of the `execute` roster (`SPARK_MCP_MODE=execute`, or `automation` for
   automation chats) becomes a Pi tool that calls the agent socket.
6. **Spawning workers.** `codara_spawn_workers` reaches
   `handleOrchestratorSpawnWorkers` in `agent-socket.ts`. It checks the batch
   (`spawn-batch-guard.ts`), then creates a step and worker tasks in the run
   store. `prepareWorkerTask` writes the worker's `prompt.md`
   (`worker-prompt.ts`).
7. **Running workers.** `launchWorkerAttempt` in `run-store.ts` runs each
   attempt as its own Pi process (`runPiWorkerSession`) with the worker
   extension `resources/pi-cora/worker.ts`. The task's runtime (`claude`,
   `codex` or `grok`) selects the model provider
   (`pi-worker-providers.ts`), not a CLI. Main opens a display-only PTY for the
   attempt (`ensurePiWorkerDisplayPty`) and writes the worker's activity into
   it. The renderer attaches a pane to that PTY: a loop in `App.tsx` calls
   `ensureWorkerTerminalTab` once the PTY exists. `parallel-wave.ts` in
   `src/shared/` decides which tasks can run at the same time. A worker turn
   has no fixed length: it is stopped only after 90 minutes without a
   finished tool call or message, or, after 6 hours, if it ignores the
   request to wrap up with a partial report (`classifyWorkerTurnCeiling` in
   `agent-liveness.ts`). A worker cut off by a pause or an app restart is
   marked `interruptedBy`; on Resume, Cora is told it can continue that
   worker's Pi session with `follow_up_of` (`worker-session-reuse.ts`)
   instead of starting the task over. Quitting, or restarting for an update,
   while a manager turn or a worker is live asks first
   (`confirmQuitWithLiveWork` in `index.ts`, `liveWorkForQuit` in
   `run-store.ts`).
8. **Reports.** A worker ends by writing `final-report.json`. `worker-report.ts`
   reads it and decides whether to accept it. A missing or malformed report
   gets one follow-up turn that names the exact problem; if that fails too,
   the worker's file is kept as `final-report.invalid.json` and the failure is
   left to Cora instead of rerunning the task on another provider.
   `codara_wait_for_workers`
   returns the reports to Cora. Only a `complete` report is accepted: when no
   Cora turn reviews it, `runAutopilotWorkerCycle` marks a failed or missing
   report `failed` and a partial or blocked one `blocked`
   (`autoReviewedTaskStatus` and `settledReviewedStepStatus` in
   `step-lifecycle.ts`), so neither ever shows as a finished step or completes
   the run. If Cora's turn already ended, the user is asked how to continue
   (`worker-outcome-questions.ts`).
9. **Completion.** Cora calls `codara_complete`
   (`handleOrchestratorComplete`). The run store moves the run to `complete`,
   writes `result-manifest.json` (`result-manifest.ts`) and posts the summary
   message (`completion-summary.ts`).
10. **Back to the UI.** Every change is an event appended by `event-log.ts`
    and broadcast as `orchestration:event` (or `orchestration:events-batch`).
    `components/chat/ChatConversation.tsx` builds the chat timeline from
    them (`lib/useRunExecutionRecord.ts`). The Runs view is
    `components/RunsView.tsx` and `components/runs/`. Its worker inspector
    can stop one worker, retry a failed or stopped one as a new attempt, and
    read a worker's log from disk after its terminal is gone
    (`stopWorkerAttempt`, `retryWorkerTask`, `readWorkerAttemptLog`).

Cora can also open real terminals. `codara_spawn_terminals` opens
interactive Claude Code, Codex, Grok or Pi sessions for you to drive
(`standing-terminals.ts` builds their commands).
`codara_terminal_create` opens a terminal the agent drives itself, for
example to run a dev server; `agent-terminal-registry.ts` and
`agent-terminal-lifecycle.ts` track those and close them when the run ends.
With `workspace` it opens in another workspace after the user's one-time
approval (`cross-workspace-terminals.ts` resolves and gates the target,
`cross-workspace-ipc.ts` shows the prompt and keeps the "Always" grants).

**Which Pi runs Cora.** `resolveCodaraPiRuntime` in `pi-runtime-electron.ts`
picks the user's own Pi install (`npm install -g
@earendil-works/pi-coding-agent`, 0.85.1 or newer) when there is one, and
otherwise the Pi build bundled with the app. A user install that fails to
start is skipped in favor of the bundled build. `resolveCodaraPiLibrary` is that
bundled copy, which main also uses as a library for credential storage,
sign-in flows and the model catalog.

**Which models Cora can pick.** `orchestration/worker-model-catalog.ts`
unions Pi's catalog (`pi-model-catalog.ts`), each signed-in provider's own
model list read with the stored token (never refreshed), and the model
caches the Codex CLI and Claude Code keep on disk, which it only reads. It
caches the result in `<codara home>/worker-model-catalog.json` (first-seen
times for the New badge) and re-reads every six hours. The Worker models
page (`worker-models:catalog`) and the chat and manager pickers
(`pi-models:catalog`) read the same list; a newly found model stays off
until the user switches it on in `settings.coraWorkerModels`.

**Codara's own skills and MCP servers.** "Add skill" and "Add MCP server"
in the Capability Center write only to `<codara home>/skills` and
`<codara home>/mcp-servers.json` (`skill-import.ts`, `agent-sync.ts`).
Cora and Pi workers load them per launch through `listPiSkillPaths` and
`listPiMcpServers`; no CLI reads them, and importing from a CLI's MCP
config copies the entry without writing that config. Where an imported
skill came from is recorded in `<codara home>/skill-origins`
(`skill-origin-store.ts`, keyed by the skill's folder); `skill-updates.ts`
checks git skills with `ls-remote` and a blob-less probe, updates them with a
backup and rolls them back, and `claude-plugin-skills.ts` lists the skills of
enabled Claude Code plugins. `skill-updates-ipc.ts` registers the `skills:*`
channels; the UI is `capabilities/SkillOrigin.tsx`,
`capabilities/PluginSkillsList.tsx` and `capabilities/useSkillOrigins.ts`.

**Automations and looms** start runs without a chat message: `scheduler.ts`
arms triggers (cron, interval, folder, git and others),
`automation-loop.ts` starts one iteration after another, and
`loom-graph.ts`, `loom-resolve.ts` and `loom-steps.ts` walk a loom's graph.
`automation-precheck.ts` runs a pass's optional shell check, and
`automation-catchup.ts` works out which scheduled times were missed while the
app was closed or the computer slept. The UI is `components/automations/`
(the trigger panel's precheck and missed-run fields are
`flow/TriggerGateFields.tsx`).

**Workflows** run a script that fans work out to agents.
`workflow-driver.ts` owns workflow runs and launches each agent as a worker;
`workflow-sandbox.ts` and `workflow-runtime.ts` run the script in a separate
process and journal its calls for resume. The socket's `workflow.*` handlers
serve Cora's `codara_workflow_*` tools and `cora workflow`, and the UI is
`components/workflows/`, shown in the Automations hub's Workflows tab.

### 3.3 Accounts: switching and keeping logins in sync

An account has a Cora half (a Pi login under
`~/.codarastudio/pi-agent/accounts/<id>/`) and a CLI half (the login Claude
Code, Codex or Grok uses). [architecture.md](./architecture.md#accounts)
explains the model. The code path of a switch:

1. **UI.** The Accounts section of `components/SettingsDialog.tsx` renders
   the cards (`components/AccountCards.tsx`). "Use" calls
   `window.spark.piSubscriptions.makeDefault`, which reaches the
   `pi-subscriptions:make-default` handler in `ipc.ts`. The agent socket's
   `accounts.use` method reaches the same service.
2. **One mutation path.** `unifiedAccountsFor(provider).useAccount(...)` in
   `unified-accounts.ts` serializes the change. It sets Cora's default and
   the CLI's default, then asks the provider's adapter
   (`account-adapters/claude-account-adapter.ts`, `codex-...`, `grok-...`) to
   apply it.
3. **What the adapter does.**
   - Claude: `activateClaudeCliAccount` in `claude-cli-live-login.ts` saves
     the live slot's login into the outgoing account's vault file and puts
     the incoming one into Codara's live slot (`claude-cli/live/home`). The
     System login moves nothing: new terminals simply get no
     `CLAUDE_CONFIG_DIR`.
   - Codex and Grok: new terminals get the account's own `CODEX_HOME` or
     `GROK_HOME` (`cli-account-homes.ts`). Running shells follow through the
     pointer file written by `active-cli-env-pointer.ts`.
4. **Keeping the halves in sync.** `credential-mirror.ts` watches both halves
   and copies the newer token across. `claude-login-keeper.ts` refreshes the
   live Claude login before it expires. Cora's Pi processes ask Studio for a
   fresh Claude token over the agent socket (`accounts.anthropic.renew`,
   `resources/pi-cora/anthropic-refresh.ts`).
5. **Nothing outside Codara's home.** `outside-write-guard.ts` refuses
   every write into the user's CLI homes; the System login is read for its
   identity only (`system-cli-login.ts`).

Startup: `startUnifiedAccountMigration` (the accounts v2 migration and the
startup pass) and `startStudioClaudeLoginKeeper` are called from `index.ts`.

### 3.4 The preview browser

- **Renderer.** `components/Preview/BrowserPane.tsx` wraps a `<webview>`.
  `tabs/PreviewStack.tsx` holds one per preview tab. `Preview/registry.ts`
  tracks the open tabs.
- **Agents drive it** with the `codara_preview_*` MCP tools
  ([mcp-tools.md](./mcp-tools.md)). Each tool is defined in a module under
  `resources/codara-studio-mcp/tools/` (`browser-core.cjs`,
  `browser-input.cjs`, ...), which names the `preview.*` socket method it
  calls; `tools/index.cjs` collects them for `server.js`. On the app side
  `src/main/preview-tools/` holds one handler table per area, which
  `agent-socket.ts` consults before its own switch. The handlers use one of
  two executors:
  - DOM work (navigate, snapshot, click, type, evaluate, screenshot) goes
    through `preview-bridge.ts` to `components/Preview/previewRpc.ts` in the
    renderer, which uses `domActions.ts` and `domSnapshot.ts`.
  - Trusted input (scroll, hover, mouse, drag, keys, upload) runs in main,
    in `preview-input.ts`, over the Chrome DevTools Protocol.
  - Every tab has one DevTools protocol session (`src/main/browser/`):
    `cdp-session.ts` is the transport-agnostic session (ref-counted domains,
    re-attach, bounded buffers), `preview-cdp.ts` creates it over
    `webContents.debugger` as Chromium attaches the guest, and
    `recorders/` keep console and network from the tab's first request.
  - Tools address a tab through `browser/targets.ts`: a `BrowserTarget`
    (session, evaluate, background-safe viewport capture) resolved from the
    `tabId` (`browser/tab-ref.ts`: a Codara tab id or `chrome:<tabId>`).
    New features build on it with `browser/screenshot.ts` (crop, scale,
    JPEG, element and full-page shots), `browser/locator.ts` with
    `shared/preview-locator.ts` (refs, unique selectors, boxes, names), and
    `browser/artifacts.ts` (files under `workspace-data/<workspace>/`).
  - The user's own browser: the extension is `extensions/chrome/` (MV3,
    its own tests and store packing). Codara's end is
    `src/main/browser/chrome/`: `link-server.ts` (loopback WebSocket,
    origin check, pairing), `link-store.ts` (hashed tokens),
    `relay-transport.ts` and `chrome-target.ts` (the `chrome` target
    backend over `chrome.debugger`), `tab-ops.ts` (the renderer-side tools
    written against `BrowserTarget`), `activity.ts` (who did what), and
    `index.ts` (boot, IPC, the folder Settings reveals). The UI is
    `components/chrome/` (the pairing prompt and the Settings section).
- **Sending to an agent.** `src/main/agent-delivery.ts` pastes into a pane's
  agent of any runtime (unsubmitted unless the user pressed Send), adds to a
  Cora chat, or queues for `codara_preview_inbox`; attachments become files
  named by path. The renderer calls it through `window.spark.agentDelivery`.
  Agents without MCP use the same tools with `cora tool`
  (`cli/commands/tool.cjs`), which Codara's panes have on PATH.
- **Review notes.** The review tab (`components/review/`, opened from the
  Source Control header or the `review.open` command) shows every change of
  the workspace in one virtualized diff, uncommitted or against the base
  branch, read by `src/main/review/review-diff.ts`. Notes on lines, ranges,
  files and selected text of a rendered Markdown file are kept per workspace
  under `<codaraHome>/workspace-data/<workspace>/review/` and go to an agent
  as one batch (`src/shared/review-notes.ts` formats it) through
  `agent-delivery.ts`, a new Cora chat, or a hand-off file a new agent CLI
  is started on.
- **Safety.** `index.ts` hardens every `<webview>` (`will-attach-webview`).
  `browser/guest-chords.ts` forwards chord keys from a page to the app's
  shortcuts.
  `guest-popups.ts` turns `window.open` into in-app tabs.
  `main-window-trust.ts` tells trusted senders apart from guest pages.
  `navigation-allowlist.ts` keeps the main window on the app's own page.

### 3.5 Remote access, and SSH workspaces

Two features with similar names:

| | Remote access (phone) | SSH workspaces |
|---|---|---|
| What | Pair a phone to watch runs, answer Cora, use terminals and files. | Open a project on another machine over SSH (`ssh://<host>/<path>`). |
| Main code | `src/main/remote-access/` | `src/main/remote/` |
| UI | `components/RemoteAccessSettings.tsx` | `components/remote/` |
| Docs | [remote-access.md](./remote-access.md) | - |

Remote access, in order: `identity.ts` (the computer's key pair),
`pairing.ts` (the QR code and its one-time secret), `listener.ts` and
`relay-client.ts` (LAN and relay transports, both Noise IK), `index.ts`
(`RemoteAccessService`: sessions and devices), `rpc.ts` (the protocol and
`RpcSession.dispatch`), then `production.ts`, which connects each method to
the real services. Supporting pieces: `terminal-leases.ts` and
`studio-terminal-share.ts` (terminals), `mutation-ledger.ts` (retried writes
apply once), `phone-notify.ts` (push notifications). Boot starts it only when
the `remoteAccessEnabled` preference is on.

#### SSH port forwarding

When a dev server starts on the host of an SSH workspace, Codara forwards its
port to this computer over the workspace's existing SSH connection, like
`ssh -L`, and shows a small notice: "Port 5173 is forwarded." with **Open in
browser**, which opens a Codara browser tab on `http://localhost:5173`. The
local port is the same number when it is free here, otherwise a nearby one
(and 8000 above a port below 1024, so 80 opens on 8080). Local ports listen on
127.0.0.1 only, never on other interfaces.

- **How a server is found.** A localhost URL with a port printed in any of
  the host's terminals, including terminals an agent opened with
  `codara_terminal_create` or `codara_terminal_run`, is forwarded once the host
  answers on that port. Every 4 seconds Codara also lists the host's
  listening TCP ports (`ss`, then `netstat`, then `/proc/net/tcp` on Linux;
  `lsof`, then `netstat` on macOS) and forwards a port that started listening
  after it connected, from 1024 to 32767, leaving out the SSH port and agent
  CLIs' sign-in callbacks. Ports already listening when the host connected are
  offered in the Ports list instead. A host with none of those tools gets
  forwarding from terminal output only.
- **The Ports list.** The **PORTS** chip in the status bar of a remote
  workspace lists the forwarded ports with their local address and process,
  with Open, Copy URL and Stop forwarding, the host's other listening ports
  with Forward, and a field to forward any port by hand. Forwards belong to
  the host, so two workspaces on one machine share them. A stopped port is
  not forwarded again until it stops listening.
- **Lifecycle.** Forwards close when the last workspace on the host is
  removed. When the connection drops they close and wait, and a reconnect
  binds them again on the same local ports. Forwarding never connects or
  reconnects a host by itself.
- **Agents.** In a remote workspace, `codara_preview_navigate` to
  `http://localhost:<port>` opens that port on the host, forwarding it first.

Code: `src/main/remote/port-forwarding.ts` (the forwards and their
lifecycle), `port-detect.ts` (URL and port-listing parsers, local port
choice), `port-forward-runtime.ts` (wiring and IPC), `forwardOut` and
`onConnectionLifecycle` in `connections.ts`, and
`components/remote/PortsChip.tsx`. A Codara Cloud box connection is an
ordinary `RemoteConnection` whose transport is a ProxyCommand, so it forwards
the same way.

#### Agents on SSH machines

With the **Keep agents running on SSH machines** setting on (the
`machinesEnabled` preference, on by default; only a choice the user made,
recorded as `machinesEnabledChosen`, turns it off),
an agent pane in an SSH workspace (Claude Code, Codex, Grok or Pi) runs inside
tmux on the machine instead of directly in the SSH shell. The agent then
keeps working when Studio quits or the network drops.

- **Start.** `buildRemoteAgentLaunch` in `remote-agents.ts` types one line
  into the remote shell. It attaches when the pane's session
  (`codara-<paneId>`) is already alive, reports a CLI missing from the login
  shell's PATH, and otherwise starts the agent with `tmux new-session -A` in
  the workspace folder. tmux runs as a private server (`tmux -L codara -f
  /dev/null`) so the user's own tmux config and sessions are never touched,
  with no status bar, no prefix key (Ctrl+B reaches the agent and nothing
  can detach the pane) and the alternate screen off so the pane's scrollback
  and agent detection work as on a plain shell. Without tmux, or with tmux
  older than 2.1, the agent starts directly, with a note that it stops when
  Studio disconnects.
- **Restore.** Every other remote pane, whatever the setting, probes the
  machine for its session and attaches when it is alive, so an agent is
  never started a second time beside the one in tmux (a restored
  `claude --resume` with the setting turned off since included), and its
  close still ends it. The setting only decides whether new agents start in
  tmux. Probes and kills run under a plain `sh -c` with the usual install
  folders added to PATH, never a login shell, so a profile that runs
  `exec fish` cannot swallow them.
- **Dropped connection.** `remote-pty.ts` keeps an agent pane open when its
  channel closes without an exit status, prints a dim note, reconnects with
  backoff (1 s up to 30 s, about two minutes in all), checks the session is
  still alive and attaches on a new channel. These attempts are quiet
  (`ensure({ quiet: true })` in `connections.ts`): they never ask for a
  password or passphrase and never dial a Codara box, whose wake costs money.
  When the host needs the user or the attempts run out, the pane waits for a
  key, and that round may ask. It stops when the session is gone or the user
  disconnects the host.
- **Ending.** Closing the pane, Cora stopping it, or deleting its folder ends
  the tmux session (`markRemoteAgentEnd` in `pty-manager.ts`). Quitting
  Studio, closing a window, or a pane that comes back within the close's
  grace period leave it running. A pane closed while its host is
  disconnected, or that needs a password to reach, leaves the agent running
  on the machine. A pane opened again with the same id waits for its old
  session's kill first.
- **Not covered.** Only agents Studio starts itself (a new agent pane or
  tab) run in tmux. An agent typed by hand into a remote shell pane
  runs directly in that shell and stops when the connection drops.

#### Machines

**Settings, Machines** (`components/machines/MachinesSettings.tsx`) lists
this computer and every SSH host: status, CPU, memory, free disk and load,
which agent CLIs and tmux are on the machine's login PATH, the agents
running there (with Show, which jumps to the pane), and agent sessions no
pane on this computer shows (with Stop). A session another computer's Codara,
or someone's own ssh, has open (a tmux client is attached) reads "Open
elsewhere" and cannot be stopped; the kill command checks again on the
machine. **Add a machine** reuses the SSH manager's host form, which also
takes `user@host:port` (port 1 to 65535).

- **Numbers.** `machines.ts` builds the rows; it probes a host only while it
  is connected, never connecting one itself, and reuses a reading younger
  than 4 seconds. The probe (`machine-probe.ts`) is one `sh -lc` exec with
  marked sections. Inside a container `/proc` describes the host, so
  cgroup v2's `cpu.max` and `memory.max` win when set, and CPU share comes
  from `cpu.stat` usage over wall time. This computer reads Node's `os`.
- **Where.** With the preference on, the Add pane menu shows a Where row: the
  pane's own machine, this computer when the pane is on another one, and
  every other connected machine (`components/machines/whereChoices.ts`). A
  new pane opens in the folder of a workspace already on the chosen machine,
  else that user's home.
- **Host keys.** With the preference on, a key Studio has not stored is
  trusted silently only when `~/.ssh/known_hosts` lists it (read only,
  `host-keys.ts` handles hashed names, patterns and `@revoked`, which wins
  even over a key Codara stored, and skips a marker OpenSSH does not know;
  a host with
  `HostKeyAlias` is looked up by the alias as written, without the port, as
  OpenSSH does; `/etc/ssh/ssh_known_hosts` and a `UserKnownHostsFile` or
  `GlobalKnownHostsFile` from `~/.ssh/config` are read too, the first with
  `%d %u %h %k %%` and `${VAR}` expanded, as is a `GlobalKnownHostsFile`
  from `/etc/ssh/ssh_config`). The handshake asks for the key types
  known_hosts lists first, reordering ssh2's own list as OpenSSH does, and a key known_hosts lists is accepted even when Codara
  stored another of the host's keys (one per host, any type). Otherwise
  `HostKeyPrompt.tsx` asks "Is this <host>?" with the fingerprint, with a
  louder note when only a `@cert-authority` line covers the host (ssh would
  have checked a certificate; Codara cannot). Only once
  the host has answered does the handshake wait up to 5 minutes for the
  user; a machine that is down fails after the usual 20 seconds, and a
  prompt ends with the attempt it belongs to (sshd drops a slow handshake
  after its LoginGraceTime). Every window drops a prompt once it ends,
  however it ends. A key that differs from Codara's stored one, or that
  known_hosts does not list while listing others for the host (another key,
  or another key type), is refused, never asked about; so is a first-use key
  for an address another host was trusted at meanwhile (every change to the
  store runs alone). The Machines card
  shows both fingerprints and **Trust the new key** (`trustChangedHostKey`),
  which trusts only the key the card showed and is forgotten when the host
  connects again, is disconnected, edited or removed. Codara Cloud boxes keep trust on first use. With the preference
  off, keys behave as before.

Tests: `test-remote-agents` runs the generated lines under `/bin/sh` with
fake `tmux` and `claude`, `test-remote-pty` covers reconnects with fake
channels, `test-pty-remote-agents` covers the wiring in `pty-manager.ts`, and
`tests/e2e/remote-agent.spec.ts` runs the built app against a real sshd and
tmux in a container (`tests/e2e/fixtures/ssh-host`, started by
`scripts/ssh-test-host.cjs`; skipped without Docker). `test-machine-probe`
parses recorded probe output (a host, a 1 CPU and 512 MiB container, macOS)
and drives the service with fake connections, `test-host-keys` covers
fingerprints, known_hosts and the confirm flow, and
`tests/e2e/machines.spec.ts` adds a machine, confirms its key, reads its
limits and starts an agent on it from the Where row.

### 3.6 Claude Code hooks

`hook-installer.ts` builds the `hooks` block that `agent-launch-integration.ts`
writes to `~/.codarastudio/integrations/claude/settings.json` at boot and
passes to every Claude launch with `--settings` (typed commands get it
through the pane's `claude` function). The hook command exits at once
outside a Codara pane (no `SPARK_PANE_ID`). Inside one, it runs
`codara-hook.py`, which writes a JSON file under `~/.codarastudio/hooks/`.
`hook-watcher.ts` picks each file up and routes it to three places: the
terminal notifier, the session registry, and the run store. It then moves the file to `processed/`. If you change the hook
command, raise `CODARA_HOOK_VERSION` so installed entries get rewritten.

## 4. Where state lives on disk

Everything is under `~/.codarastudio/`, or under `CODARA_HOME_DIR` if you set
it (`codara-home.ts`, `codaraHome()`). The user-facing list is
[on-your-machine.md](./on-your-machine.md). This table adds the code that
owns each file:

| Path | Owner |
|---|---|
| `spark-state.json` (workspaces), `spark-settings.json` (`AppSettings`; the OpenRouter key is encrypted with `safeStorage`) | `storage.ts` |
| `spark-preferences.json` | `preferences-store.ts` |
| `runs/<id>/run.json`, `runs/<id>/events.jsonl`, `runs/<id>/steps/...` (prompts, logs, reports of each attempt), `runs/<id>/result-manifest.json` | `run-store.ts`, `event-log.ts` |
| `agent-socket.json` (socket URL and token, mode 0600) | `agent-socket.ts` |
| `hooks/`, `hooks/processed/` | `codara-hook.py`, `hook-watcher.ts` |
| `agent-session-starts.json` | `agent-session-registry.ts` |
| `pi-agent/` (Cora's logins, Pi sessions) | `pi-account-auth-store.ts`, `pi-runtime-electron.ts` (`codaraPiPaths`) |
| `memory/` (Cora's memory) | `cora-memory.ts`, `cora-profiles.ts` |
| `memory/learned/items.json`, `memory/profiles/<id>/learned/items.json` (what Cora learned by itself), `memory/learning.json` (its switches) | `memory-items.ts`, `memory-learning.ts` |
| `scheduler.json` (armed automation triggers) | `scheduler.ts` |
| `workspace-status.json` (the status you set on each workspace, note and checkpoints; agents' own notes stay in memory, `workspace-status/agent-notes.ts`) | `workspace-status/` |
| `cos/<workspaceId>/tasks.jsonl`, `TASKS.md`, `verify/<task>/<run>/*.log` (the workspace's task list, its rendered view and the verify gate's logs) | `cos/task-store.ts`, `cos/verify-gate.ts` |
| `session-index/sessions.sqlite` (the agent session search index) | `session-search/` |
| `claude-cli/` (the live slot `live/home`, saved logins, `live-login.json`) | `claude-cli-live-login.ts`, `claude-cli-account-profiles.ts`, `cli-account-homes.ts` |
| `codex-cli/` (one managed `CODEX_HOME` per account) | `codex-cli-account-profiles.ts`, `cli-account-homes.ts` |
| `grok-cli/` (one managed `GROK_HOME` per account) | `grok-cli-account-profiles.ts`, `cli-account-homes.ts` |
| `backups/accounts-v2/` (the v1 archive and its journal) | `accounts-v2-migration.ts` |
| `shell/active-cli-env` | `active-cli-env-pointer.ts` |
| `builtin-mcp.json` (the MCP server turned off for some CLIs) | `mcp-installer.ts` |
| `remote/` (identity, paired devices, ledger) | `remote-access/` |
| `logs/main.log` | `file-log.ts` (`logMain`) |
| `logs/worktree-audit.jsonl` (agent worktree changes) | `agent-worktrees.ts` (`createWorktreeAuditLog`) |
| `worktree-sizes.json` (worktree sizes for Clean up worktrees) | `worktree-cleanup/space.ts` (`createSizeStore`) |

The renderer also keeps each workspace's tab layout in `localStorage`
(`tabs/useTabs.ts`). The `spark-` prefixes and `SPARK_*` variables come from
the product's old name. They are kept because files on disk and other tools
depend on them.

## 5. Run, test, debug

```sh
npm install        # Node 22+, a C++ toolchain, Python 3.8+ (see CONTRIBUTING.md)
npm run dev        # the app with hot reload (electron-vite dev)
npm run typecheck  # node, web and e2e projects
npm test           # every unit suite; npm test -- <regex> for some
npm run test:e2e   # build, then the Playwright specs
```

The test runner, what each suite needs, and an index of suites by area are in
[scripts/README.md](../scripts/README.md).

Debugging:

- **Main-process logs** print in the terminal running `npm run dev`. Code
  that uses `logMain` also writes to `~/.codarastudio/logs/main.log`, which
  is the log to ask for in bug reports.
- **Renderer**: open DevTools from the View menu. The app keeps Electron's
  default menu, which has Toggle Developer Tools. On Windows and Linux,
  press Alt to show the menu bar.
- **A separate dev instance.** A dev build reads and writes the same
  `~/.codarastudio` as your installed app. To keep them apart, start it
  with its own home, as `docs/harness-lab/README.md` describes:
  `CODARA_HOME_DIR`, `SPARK_HOME_DIR` and `SPARK_USER_DATA_DIR` pointing at
  one directory outside the repository, plus `SPARK_ALLOW_MULTI=1` to lift
  the single-instance lock. When `npm run dev` stops, the app it started
  quits too (it watches the electron-vite process), and a new launch
  replaces an instance whose window cannot load instead of quitting, so a
  dead dev instance never keeps the next one from starting. On its first
  start a build also removes what earlier builds wrote into the CLIs' own
  configs, with a backup; see
  [on-your-machine.md](./on-your-machine.md).
- **Talk to the running app.** `node cli/cora.cjs rpc <method> [params-json]`
  calls any agent-socket method. The `app.*` methods (`app.screenshot`,
  `app.evaluate`, `app.notify`, `app.prefs.get`, `app.prefs.set`) let you
  look at and poke the UI from a terminal. They work in dev builds;
  packaged builds refuse them unless launched with `CODARA_DEV_TOOLS=1`.
  `app.info` is always available.
- **A run that went wrong.** `npm run inspect-run -- <run-id>` writes a
  markdown dump of the run: `run.json`, events, manager calls, worker
  prompts, logs and reports. `cora runs`, `cora run` and `cora log` also
  read runs offline ([cli.md](./cli.md)).
- **Terminal agent detection.** The notifier writes a diagnostic trail of
  state changes to `<tmpdir>/spark-terminal-notify.log`. Set
  `SPARK_TERMINAL_NOTIFY_LOG=0` to turn it off.

## 6. Where do I start if I want to change...

| I want to change... | Start here | Also look at |
|---|---|---|
| A keyboard shortcut or command | `src/renderer/src/shortcuts/commands.ts` (`COMMANDS`) | The handler in `App.tsx`; [shortcuts-and-settings.md](./shortcuts-and-settings.md) |
| A setting | `AppSettings` in `src/shared/types.ts`, defaults in `src/main/storage.ts` | `components/SettingsDialog.tsx` |
| Something the UI asks main to do | A `handle("...")` in `src/main/ipc.ts` | The matching method in `src/preload/index.ts`. `test-ipc-gate-default` fails if a handler skips the trusted-sender gate. |
| A tool agents can call | A module in `resources/codara-studio-mcp/tools/` (browser tools and other studio tools; the contract is in `tools/index.cjs`), or `server.js` for the orchestration rosters | The method in `dispatch` in `src/main/agent-socket.ts`; [mcp-tools.md](./mcp-tools.md); `test-codara-studio-mcp`, `test-mcp-tool-manifest` |
| What Cora says or how she plans | `resources/pi-cora/prompt.ts` (`buildCoraPiSystemPrompt`) | `resources/orchestration/manager-profile.json`; `test-manager-playbooks`, `test-prompt-punctuation` |
| What workers are told or allowed to do | `src/main/orchestration/worker-prompt.ts` (`renderWorkerPrompt`) | `resources/pi-cora/worker.ts`, `worker-policy.ts` |
| Run states, pause and resume, recovery | `run-store.ts` | `run-lifecycle.ts`, `step-lifecycle.ts`, `manager-turn-policy.ts`; the regression suites in [scripts/README.md](../scripts/README.md#cora-runs-the-run-store-and-the-manager) |
| How Pi is found or started | `pi-runtime-electron.ts`, `pi-runtime.ts` | `pi-backend.ts`, `pi-rpc-client.ts` |
| Accounts | `unified-accounts.ts` and the adapter in `account-adapters/` | `claude-cli-live-login.ts`, `claude-login-keeper.ts`, `cli-account-homes.ts`, `credential-mirror.ts`, `outside-write-guard.ts`; `components/AccountCards.tsx` |
| Terminal rendering or input | `components/Terminal/useTerminalSession.ts` | `pty-manager.ts` on the main side |
| Tabs, splits, docking | `src/renderer/src/tabs/useTabs.ts` | `paneTree.ts`, `dock.ts`, `TerminalStack.tsx` |
| Detecting an agent's state in a pane | `src/shared/agent-patterns.ts` | `src/main/terminal-agent-notify.ts`, `src/main/agent-background-work.ts` (work still running after a turn); `test-agent-patterns`, `test-terminal-agent-notify`, `test-agent-background-work` |
| Notifications | `src/main/notify/policy.ts` (whether to deliver) | `deliver.ts`; `src/renderer/src/notifications/` |
| Agent session search (the rail's Sessions view) | `src/main/session-search/session-index.ts` (the index, no Electron) | `transcript-parsers.ts`, `session-index-worker.ts` (its thread), `service.ts` (pacing, IPC, the agent tool); `components/session-search/`; `test-session-search`, `tests/e2e/session-search.spec.ts`; [agent-session-search.md](./agent-session-search.md) |
| The rail's Agents view | `src/shared/agent-board.ts` (which group a card lands in) | `components/agent-board/`; `src/main/agent-board.ts` and `terminalAgentActivitySnapshot` in `terminal-agent-notify.ts`; `test-agent-board`, `tests/e2e/agent-board.spec.ts` |
| A workspace's status line and its agent lines in the rail | `src/shared/agent-status.ts` (each agent's state, the summary line) | `components/workspace-status/WorkspaceAgentsLine.tsx`, `agentLinesStore.ts`; `src/main/workspace-status/agent-notes.ts` and `preview-tools/workspace-status.ts` (the note an agent writes); `test-agent-status`, `test-workspace-status` |
| Worktrees nested under their project in the rail, each agent on its row, the merged fold | `src/shared/rail-tree.ts` (which worktree nests where, which row each agent shows on, the order) | `WorkspaceFamily` and the nested `WorkspaceRow` in `components/WorkspaceRail.tsx`, `components/rail/WorkspaceChildren.tsx`, `rail/railFolds.ts`; DESIGN.md "Worktrees in the rail"; `test-rail-tree`, e2e `rail-worktrees` |
| The preview browser | `components/Preview/previewRpc.ts` (DOM actions) or `src/main/preview-input.ts` (trusted input) | The socket handlers in `src/main/preview-tools/` (one table per area, merged in `index.ts`); `test-preview-tools-routing` |
| The chat UI | `components/chat/` | `lib/useRunExecutionRecord.ts`, `chat/timeline.ts` |
| Automations and looms | `scheduler.ts`, `automation-loop.ts`, `loom-*.ts` | `components/automations/` |
| Workflows | `workflow-driver.ts` (runs), `workflow-runtime.ts` (script API, journal) | `components/workflows/`; `test-workflow-*`, `tests/e2e/workflow-run.spec.ts` |
| Git or GitHub features | `src/main/git-*.ts`, `src/main/github-*.ts` | `components/git/` |
| Worktrees agents create and remove | `src/main/agent-worktrees.ts` (the policy, no Electron) | The `worktree.*` handlers in `agent-socket.ts`; `workspace-state-edits.ts`; `test-agent-worktrees`, `tests/e2e/agent-worktree.spec.ts` |
| Pull requests on the rail, and the agent told when CI fails | `src/main/github-ci-watch.ts` (the watcher: reads, backoff, rows, alerts) | `github-conditional.ts` (ETag reads through `gh api`), `ci-agent-nudge.ts` (which agent, when it is free), `pull-request-watch-ipc.ts`; `src/shared/pull-request-watch.ts`; `git/pullRequestWatchStore.ts`, `git/PullRequestMark.tsx`; `test-github-ci-watch`, `test-ci-agent-nudge`, `tests/e2e/pr-watch-agent.spec.ts` |
| Clean up worktrees | `src/main/worktree-cleanup/` (`inspect.ts` the facts and the full check, `scan.ts` the list, `remove.ts` the guarded removal, `rail.ts` the rail's merged mark, Clean up and automatic cleanup of missing folders, `space.ts` sizes; only `index.ts` touches Electron) | `src/shared/worktree-cleanup.ts` (filters, the removal outlook); `components/worktree-cleanup/`, `git/useWorktreeRailStates.ts` (the rail); `test-worktree-cleanup`, `test-worktree-rail-cleanup`, `tests/e2e/worktree-cleanup.spec.ts`, `tests/e2e/worktree-rail-cleanup.spec.ts` |
| What a new worktree gets (copied files, links, setup commands) | `src/main/worktree-setup/` (`service.ts` runs it, `plan.ts` and `materialize.ts` decide and copy), `src/shared/worktree-setup.ts` (the file format) | `components/worktree-setup/` (the tray, the log, the setup file dialog); `test-worktree-setup`, `tests/e2e/worktree-setup.spec.ts`; [worktree-setup.md](./worktree-setup.md) |
| The phone protocol | `remote-access/rpc.ts` | `production.ts`; the interop suites in [scripts/README.md](../scripts/README.md#remote-access-phone-and-ssh-workspaces) |
| The Claude Code hook | `src/main/hook-installer.ts` | `resources/claude-hooks/codara-hook.py`, `hook-watcher.ts` |
| Shell integration | `resources/shell-integration/` | `src/main/shell-init.ts` |
| The `cora` CLI | `cli/commands/` | `cli/lib/rpc.cjs`, `cli/lib/store.cjs`; [cli.md](./cli.md) |
| Packaging and release | `electron.vite.config.ts`, the `build` block of `package.json` | [releasing.md](./releasing.md) |

## 7. Conventions to know

- **Rules for changes** (style, commits, verification) are in
  [AGENTS.md](../AGENTS.md) and [CONTRIBUTING.md](../CONTRIBUTING.md). They
  apply to people and AI agents alike.
- **Every IPC handler** is registered through `handle()` in `ipc.ts`, which
  refuses calls from anything but the app's own window. The few
  fire-and-forget channels check the sender themselves.
- **Shared code** goes in `src/shared/` and must not import Electron or
  Node-only modules. The renderer bundles it too, and the web typecheck
  (`tsconfig.web.json`) has no Node types.
- **Legacy names.** `window.spark`, `SPARK_*` variables, `spark-*.json` files
  and `Spark*` types come from the product's old name. Keep the variables
  and file names: hooks, shells and files on users' machines depend on them.
