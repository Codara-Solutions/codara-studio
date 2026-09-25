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
| Shells and agent CLIs | `pty-manager.ts` (node-pty) | your shell, `claude`, `codex`, `grok`, `pi` | Terminal bytes. Every PTY gets `SPARK_PANE_ID` and the agent socket's address and token in its environment. |
| Pi (Cora's manager and workers) | `pi-rpc-client.ts` | the Pi package, run with `--mode rpc` and the extension in `resources/pi-cora/` | Pi's RPC protocol on stdin and stdout. The extension loads the MCP server's code in-process and calls the agent socket. |
| `codara-studio` MCP server | Claude Code, Codex or Grok, from their MCP config | `resources/codara-studio-mcp/server.js` | HTTP JSON-RPC to the agent socket. `mcp-installer.ts` writes the config entry. |
| `cora` CLI | you | `cli/cora.cjs` | HTTP JSON-RPC to the agent socket. Reads run files directly when the app is closed. |
| Claude Code hook | Claude Code, from `~/.claude/settings.json` | `resources/claude-hooks/codara-hook.py` | Writes one JSON file per event under `~/.codarastudio/hooks/`. |

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
   it after a restart. Codex sessions are found by `codex-session-tracker.ts`.

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
   record the message, then schedule a manager turn. A message sent while a
   turn is running waits in a queue and is delivered after it.
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
   `src/shared/` decides which tasks can run at the same time.
8. **Reports.** A worker ends by writing `final-report.json`. `worker-report.ts`
   reads it and decides whether to accept it. `codara_wait_for_workers`
   returns the reports to Cora.
9. **Completion.** Cora calls `codara_complete`
   (`handleOrchestratorComplete`). The run store moves the run to `complete`,
   writes `result-manifest.json` (`result-manifest.ts`) and posts the summary
   message (`completion-summary.ts`).
10. **Back to the UI.** Every change is an event appended by `event-log.ts`
    and broadcast as `orchestration:event` (or `orchestration:events-batch`).
    `components/chat/ChatConversation.tsx` builds the chat timeline from
    them (`lib/useRunExecutionRecord.ts`). The Runs view is
    `components/RunsView.tsx` and `components/runs/`.

Cora can also open real terminals. `codara_spawn_terminals` opens
interactive Claude Code or Codex sessions for you to drive.
`codara_terminal_create` opens a terminal the agent drives itself, for
example to run a dev server; `agent-terminal-registry.ts` and
`agent-terminal-lifecycle.ts` track those and close them when the run ends.

**Which Pi runs Cora.** `resolveCodaraPiRuntime` in `pi-runtime-electron.ts`
picks the user's own Pi install (`npm install -g
@earendil-works/pi-coding-agent`, 0.85.1 or newer) when there is one, and
otherwise the Pi build bundled with the app. `resolveCodaraPiLibrary` is that
bundled copy, which main also uses as a library for credential storage,
sign-in flows and the model catalog.

**Automations and looms** start runs without a chat message: `scheduler.ts`
arms triggers (cron, interval, folder, git and others),
`automation-loop.ts` starts one iteration after another, and
`loom-graph.ts`, `loom-resolve.ts` and `loom-steps.ts` walk a loom's graph.
The UI is `components/automations/`.

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
     the live login into the outgoing account's vault file and copies the
     incoming one into `~/.claude`. Only the sign-in keys and the
     `oauthAccount` identity move.
   - Codex: `activateCodexCliAccount` in `codex-cli-auth-selector.ts` swaps
     `~/.codex/auth.json`.
   - Grok: new terminals get the account's own `GROK_HOME`
     (`grok-cli-account-profiles.ts`). Running shells follow through the
     pointer file written by `active-cli-env-pointer.ts`.
4. **Keeping the halves in sync.** `credential-mirror.ts` watches both halves
   and copies the newer token across. `claude-login-keeper.ts` refreshes the
   live Claude login before it expires. Cora's Pi processes ask Studio for a
   fresh Claude token over the agent socket (`accounts.anthropic.renew`,
   `resources/pi-cora/anthropic-refresh.ts`).
5. **Sign-ins made in a terminal.** `followNativeLogins` in
   `unified-account-migration.ts` runs once a minute and on wake. It calls
   `UnifiedAccountService.followNativeLogin`, so a `/login` or `codex login`
   as a known account makes that account the Active one.

Startup: `startUnifiedAccountMigration` (the one-time layout migration),
`startStudioClaudeLoginKeeper` and `startNativeLoginFollower` are all called
from `index.ts`.

### 3.4 The preview browser

- **Renderer.** `components/Preview/BrowserPane.tsx` wraps a `<webview>`.
  `tabs/PreviewStack.tsx` holds one per preview tab. `Preview/registry.ts`
  tracks the open tabs.
- **Agents drive it** with the `codara_preview_*` MCP tools
  ([mcp-tools.md](./mcp-tools.md)). In `server.js`, `PREVIEW_TOOL_TO_RPC`
  maps each tool to a `preview.*` socket method. `agent-socket.ts` sends
  each call to one of two executors:
  - DOM work (navigate, snapshot, click, type, evaluate, screenshot) goes
    through `preview-bridge.ts` to `components/Preview/previewRpc.ts` in the
    renderer, which uses `domActions.ts` and `domSnapshot.ts`.
  - Trusted input (scroll, hover, mouse, drag, keys, upload) and console or
    network capture run in main, in `preview-input.ts`, over the Chrome
    DevTools Protocol.
- **Safety.** `index.ts` hardens every `<webview>` (`will-attach-webview`).
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

### 3.6 Claude Code hooks

`hook-installer.ts` writes a `hooks` block into `~/.claude/settings.json`. It
runs at boot and whenever a Claude pane starts. The hook command exits at
once outside a Codara pane (no `SPARK_PANE_ID`). Inside one, it runs
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
| `spark-state.json` (workspaces), `spark-settings.json` (`AppSettings`) | `storage.ts` |
| `spark-preferences.json` | `preferences-store.ts` |
| `runs/<id>/run.json`, `runs/<id>/events.jsonl`, `runs/<id>/steps/...` (prompts, logs, reports of each attempt), `runs/<id>/result-manifest.json` | `run-store.ts`, `event-log.ts` |
| `agent-socket.json` (socket URL and token, mode 0600) | `agent-socket.ts` |
| `hooks/`, `hooks/processed/` | `codara-hook.py`, `hook-watcher.ts` |
| `agent-session-starts.json` | `agent-session-registry.ts` |
| `pi-agent/` (Cora's logins, Pi sessions) | `pi-account-auth-store.ts`, `pi-runtime-electron.ts` (`codaraPiPaths`) |
| `memory/` (Cora's memory) | `cora-memory.ts`, `cora-profiles.ts` |
| `scheduler.json` (armed automation triggers) | `scheduler.ts` |
| `claude-cli/` (saved Claude logins, `live-login.json`) | `claude-cli-live-login.ts`, `claude-cli-account-profiles.ts` |
| `codex-cli/` (saved Codex logins, `active-auth.json`) | `codex-cli-auth-selector.ts`, `codex-cli-account-profiles.ts` |
| `grok-cli/` (managed Grok homes) | `grok-cli-account-profiles.ts`, `native-cli-shared-state.ts` |
| `shell/active-cli-env` | `active-cli-env-pointer.ts` |
| `builtin-mcp.json` (the MCP server turned off for some CLIs) | `mcp-installer.ts` |
| `remote/` (identity, paired devices, ledger) | `remote-access/` |
| `logs/main.log` | `file-log.ts` (`logMain`) |

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
  the single-instance lock. A dev build still edits the CLIs' own configs
  (hooks in `~/.claude/settings.json`, the MCP entry); see
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
| A tool agents can call | `resources/codara-studio-mcp/server.js` (schema, roster, tool-to-method map) | The method in `dispatch` in `src/main/agent-socket.ts`; [mcp-tools.md](./mcp-tools.md); `test-codara-studio-mcp` |
| What Cora says or how she plans | `resources/pi-cora/prompt.ts` (`buildCoraPiSystemPrompt`) | `resources/orchestration/manager-profile.json`; `test-manager-playbooks`, `test-prompt-punctuation` |
| What workers are told or allowed to do | `src/main/orchestration/worker-prompt.ts` (`renderWorkerPrompt`) | `resources/pi-cora/worker.ts`, `worker-policy.ts` |
| Run states, pause and resume, recovery | `run-store.ts` | `run-lifecycle.ts`, `step-lifecycle.ts`, `manager-turn-policy.ts`; the regression suites in [scripts/README.md](../scripts/README.md#cora-runs-the-run-store-and-the-manager) |
| How Pi is found or started | `pi-runtime-electron.ts`, `pi-runtime.ts` | `pi-backend.ts`, `pi-rpc-client.ts` |
| Accounts | `unified-accounts.ts` and the adapter in `account-adapters/` | `claude-cli-live-login.ts`, `claude-login-keeper.ts`, `codex-cli-auth-selector.ts`, `credential-mirror.ts`; `components/AccountCards.tsx` |
| Terminal rendering or input | `components/Terminal/useTerminalSession.ts` | `pty-manager.ts` on the main side |
| Tabs, splits, docking | `src/renderer/src/tabs/useTabs.ts` | `paneTree.ts`, `dock.ts`, `TerminalStack.tsx` |
| Detecting an agent's state in a pane | `src/shared/agent-patterns.ts` | `src/main/terminal-agent-notify.ts`; `test-agent-patterns`, `test-terminal-agent-notify` |
| Notifications | `src/main/notify/policy.ts` (whether to deliver) | `deliver.ts`; `src/renderer/src/notifications/` |
| The preview browser | `components/Preview/previewRpc.ts` (DOM actions) or `src/main/preview-input.ts` (trusted input) | `agent-socket.ts` preview handlers |
| The chat UI | `components/chat/` | `lib/useRunExecutionRecord.ts`, `chat/timeline.ts` |
| Automations and looms | `scheduler.ts`, `automation-loop.ts`, `loom-*.ts` | `components/automations/` |
| Git or GitHub features | `src/main/git-*.ts`, `src/main/github-*.ts` | `components/git/` |
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
