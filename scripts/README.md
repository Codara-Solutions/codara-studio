# scripts/

This folder holds three kinds of files:

- **Unit suites**, `test-*.cjs` and `test-*.mjs` (over 250). `npm test` runs
  all of them. CI runs them on every pull request.
- **Live smoke and probe scripts**, `smoke-*.cjs` and a few others. They need
  a running app, a real subscription, or the network, and nothing runs them
  automatically.
- **Tooling**: install hooks, the test runner, dev harnesses and the release
  pipeline.

The code map for the rest of the repository is
[docs/codebase-tour.md](../docs/codebase-tour.md).

## Running the unit suites

| Command | What it does |
|---|---|
| `npm test` | Runs every `scripts/test-*.cjs` and `test-*.mjs`, a few at a time (see below). About 2 minutes. |
| `npm test -- <regex>` | Runs only the files whose name matches the regex, for example `npm test -- loom-steps` or `npm test -- "^test-(claude\|codex)-"`. |
| `npm run test:changed` | Runs only the suites that can see a file changed since the merge base with `origin/main`, committed or not. `npm run test:changed -- <ref>` picks another base, and `-- --list` prints the selection without running it. Use it in the inner loop; `npm test` stays the gate before landing. |
| `CODARA_TEST_JOBS=1 npm test` | The old behavior: one suite at a time, in name order, with the name printed before it runs. |
| `node scripts/test-notify-policy.cjs` | Runs one suite directly. Suites find the repository from their own file location, so you do not need to `cd` first. |
| `npm run test:<name>` | Shortcuts for some suites or groups of suites, defined in `package.json`. You never need one: the runner already picks up every file. |
| `npm run typecheck` | The three TypeScript projects (node, web, e2e). Not part of `npm test`; run it too. |

How `scripts/run-all-tests.cjs` works:

- **The filename glob is the registry.** A new `test-*.cjs` or `test-*.mjs`
  file runs as soon as it exists. You add no entry anywhere. A `.ts` file does
  not match: `test-cora-direct-mode.ts` only runs through
  `npm run test:cora-direct-mode`.
- Each file runs as `node <file>` in its own process (and process group)
  with a 180 second timeout. It passes when it exits with code 0. A timeout
  kills the whole group, Electron and Chromium children included.
- Suites run in a pool of `CODARA_TEST_JOBS` processes, by default
  `min(4, cores - 2)`. The machine is shared with other agents, so the pool
  is sized for memory, not speed:
  - A file with a `// test-runner: heavy (why)` line never runs next to
    another heavy one. Tag a suite heavy when it launches Chromium or
    Electron, or when its process peaks above about 200 MB.
  - A file with a `// test-runner: serial (why)` line runs after the pool,
    with nothing else running. Today that is `test-renderer-chunks.mjs` (a
    production Vite build, about 2 GB) and `test-workflow-sandbox.cjs` (its
    heap-limit case grows QuickJS's WebAssembly memory to 2 GB).
  - No suite starts while `MemAvailable` is below `CODARA_TEST_MIN_FREE_MB`
    (default 2048) and another suite is still running.
  - Each suite gets its own empty `TMPDIR`, removed when it finishes, so
    suites that write fixed names under `os.tmpdir()` cannot collide. Do not
    write fixed paths anywhere else (the repository, `node_modules/.cache`)
    without a name unique to the suite.
  - Durations are kept in `node_modules/.cache/codara-tests/timings.json`,
    and the next run starts the longest suites first.
- The whole run peaks at about 2.5 GB, almost all of it from the two serial
  suites. Keep a new suite well under that, or tag it.
- The runner prints `ok` or `FAIL` for each file as it finishes, then a pass
  count, then the last 6000 characters of each failure's output, in name
  order. It exits with code 1 if any file failed.
- Never wait on real time in a suite. Code that runs on timers (quiet
  windows, sweeps, retries) can run on `scripts/fake-clock.cjs`: install it
  before loading the bundle and call `await clock.advance(ms)` where the
  suite would sleep. `test-terminal-agent-notify.cjs` is the example; it
  went from 157 s to under a second.

The Playwright specs are separate. They live in `tests/e2e/`:

```sh
npm run test:e2e                                  # build, then every spec
npm run build && npx playwright test tests/e2e/tab-reorder.spec.ts
SPARK_E2E_BACKGROUND=0 npx playwright test ...    # show the app window
```

By default (`SPARK_E2E_BACKGROUND=1`) the test app stays off your desktop:
on Linux the Playwright runner and `npm test` start a private Xvfb display
and every test window opens there (`scripts/virtual-display.cjs`; install it
with `sudo apt install xvfb`, or point `CODARA_XVFB` at an Xvfb binary). On
macOS and Windows the window is transparent and inactive. The app plays no
sounds and raises no OS notifications: it builds each one without showing
it and lists it in main as `globalThis.__codaraNativeNotifications`, where a
spec can fire its click. A throwaway script that launches
Electron itself should call `useVirtualDisplay()` from that module first.

`playwright.config.ts` runs one spec at a time, and each spec boots a real
Electron app. The config also removes the Codara variables a Studio pane
exports, such as `SPARK_PANE_ID`, the agent socket and `CODARA_HOME_DIR`, so
a test run started inside Studio does not talk to the live app.

## Suites with extra needs

Most suites need only `npm install`. These are the exceptions:

| Need | Suites | Notes |
|---|---|---|
| A build in `out/` | `test-agent-socket.cjs`, `test-app-exit-electron.cjs` | Launches `out/main/index.js` under Electron with a temporary home. Run `npm run build` (which is `electron-vite build`) first. Without a build the app never writes its handshake file and the suite fails. |
| The Electron binary | `test-agent-socket.cjs`, `test-trusted-sender.cjs` | Both boot a headless Electron from `node_modules`. |
| Playwright's Chromium | `test-chat-surface-routing.cjs`, `test-csv-preview-ui.cjs`, `test-browser-cdp-session.cjs`, `test-browser-screenshot-locator.cjs`, `test-browser-devtools.cjs`, `test-browser-cdp-access.cjs`, `test-browser-insight.cjs`, `test-browser-capture-chromium.cjs`, `test-preview-waits.cjs`, `test-preview-dialogs.cjs`, `test-preview-find-outline.cjs`, `test-preview-console-filter.cjs`, `test-studio-csp.cjs`, `test-browser-code.cjs` | Install it with `npx playwright install chromium`. Without it they print SKIP for the real-page checks. |
| Real `git` | `test-worktrees.cjs`, `test-agent-worktrees.cjs`, `test-worktree-cleanup.cjs`, `test-worktree-cleanup-agent.cjs`, `test-worktree-setup.cjs`, `test-git-auto-fetch-git.cjs`, `test-git-split-commits.cjs`, `test-git-optional-locks.cjs`, `test-git-stash.cjs`, `test-github-pull-request-git.cjs`, `test-review-diff.cjs`, `test-result-manifest.cjs`, `test-worker-diff.cjs`, `test-browser-storage-boundary.cjs` | Most create throwaway repositories in a temp dir. `test-browser-storage-boundary.cjs` runs `git ls-files` on this checkout, so it needs a git clone. |
| POSIX tools | `test-owned-process-tree-descendants.cjs` (needs `ps`), `test-pty-inherited-env.cjs` (skips its zsh probes without `/bin/zsh`), `test-ssh-keys.cjs` (skips key generation without `ssh-keygen`) | On Windows they run a reduced set of checks. |
| A `codara-mobile` checkout next to this repo | `test-cora-history-interop.cjs`, `test-cora-run-interop.cjs`, and some checks in `test-remote-access.cjs` | They print `SKIP` when the sibling repo is missing, as on CI. |

CI (`.github/workflows/ci.yml`, macOS) runs the three typechecks, then
`npm run build`, then `npx playwright install chromium`, then
`npm run test:all`. On your machine, run the same steps to reproduce a CI
failure.

## Isolation: suites leave your real data alone

- Suites create their own directories with
  `fs.mkdtempSync(path.join(os.tmpdir(), ...))`. They point `CODARA_HOME_DIR`
  (and, where it matters, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME` or
  `HOME`) at those directories, so your `~/.codarastudio`, `~/.claude`,
  `~/.codex`, `~/.grok` and `~/.pi` are left alone. `test-hook-installer.cjs`
  even fails if your real `~/.claude/settings.json` changed during its run,
  and `test-codex-notify.cjs` does the same for `~/.codex/config.toml`.
- Suites that go through Claude Code's credential store set
  `CODARA_DISABLE_KEYCHAIN=1`. This is a test seam in
  `src/main/orchestration/claude-cli-credentials.ts`: with it set, the real
  credential backend never runs `/usr/bin/security`, so no macOS Keychain
  item is read or written. These suites use it: `test-anthropic-accounts`,
  `test-anthropic-account-identity`, `test-anthropic-credential-mirror`,
  `test-account-tombstones`, `test-accounts-no-global-writes`,
  `test-accounts-v2-migration`, `test-cli-account-homes`,
  `test-claude-cli-account-profiles`, `test-claude-cli-credentials`,
  `test-claude-cli-live-login`, `test-claude-login-keeper`,
  `test-pi-subscription-refresh` and `test-unified-account-migration`. A new
  suite that reaches that module
  must set it too. The same variable keeps `storage.ts` from encrypting the
  OpenRouter key with Electron `safeStorage`, which uses the Keychain;
  `test-storage-openrouter-key` replaces `safeStorage` with a fake keyring
  instead, and Playwright specs that save a key set the variable.
- A shell inside a Studio pane exports Codara variables (`SPARK_PANE_ID`,
  `SPARK_HOME_DIR`, and so on). Suites that could pick them up set their own
  values or delete them. If a suite behaves differently inside Studio than in
  a plain terminal, suspect a variable it inherited.

## How a suite is put together

There is no test framework. Each suite is a plain Node script that prints a
line for each check and exits with a non-zero code on failure. A few use
`node:test`. The common patterns:

- **esbuild bundle of the real module** (about 200 suites). The suite
  bundles one TypeScript file from `src/` into a temporary CommonJS file. A
  small plugin maps `@shared/*` to `src/shared/`, and `electron` or heavy
  sibling modules are replaced with stubs. The suite then calls the module
  directly. `test-notify-policy.cjs` is a short example to copy.
- **Transpile a single file** with `typescript.transpileModule`, for example
  `test-pi-runtime.cjs`.
- **Structural checks**: read the source as text and check wiring that cannot
  run under Node. For example, `test-ipc-gate-default.cjs` checks that every
  `ipcMain.handle` goes through the trusted-sender gate.
- **Real processes**: `test-agent-socket.cjs`, `test-app-exit-electron.cjs`
  and `test-trusted-sender.cjs` start Electron. `remote-access-e2e.mjs` starts the real remote-access
  service.

To add a suite:

1. Name it `scripts/test-<area>-<subject>.cjs` and reuse an area prefix from
   the index below, so `npm test -- <area>` finds it.
2. Copy the harness of a neighbor in the same area.
3. Use temp directories only, and set `CODARA_DISABLE_KEYCHAIN=1` if the code
   under test can reach Claude's credential store.
4. Make it finish well under 180 seconds.
5. Say at the top of the file what it guards and why. Most suites start with
   such a comment, often naming the bug that led to the suite.

## Index of suites by area

The groups follow file-name prefixes, and rows name the source files the
suites cover where that helps. The same prefix works as a filter:
`npm test -- github-` runs the whole GitHub group.

### Cora runs (the run store and the manager)

Most of these load `src/main/orchestration/run-store.ts` or a module it
calls.

| Suites | Covers |
|---|---|
| `test-step-lifecycle`, `test-user-message-resume`, `test-queued-messages`, `test-conversation-rewind`, `test-keyed-task-queue` | Step and run lifecycle, messages sent while a turn is running, rewind. |
| `test-followup-rehoming`, `test-force-pause-resume`, `test-run-resume-guard`, `test-run-recovery-contracts`, `test-wedged-run-recovery`, `test-late-failure-preservation`, `test-manager-turn-recovery` | Regression cases, most from real runs (the file header names the run id): pause, resume, stuck runs, late failures. |
| `test-manager-turn-policy`, `test-manager-call-settlement`, `test-manager-prompt-cache`, `test-manager-playbooks`, `test-run-manager-session-cleanup`, `test-run-runtime-shutdown` | The manager turn: failure policy, settling tool calls, prompt-cache layout, the playbooks in the system prompt, cleanup. |
| `test-completion-tail`, `test-codara-complete-application`, `test-result-manifest`, `test-run-verdict`, `test-run-questions`, `test-autonomous-question-policy`, `test-manual-review` | Completion and results: the `codara_complete` outbox, the result manifest, verdicts, questions to the user. |
| `test-lifecycle-events`, `test-buffered-events`, `test-run-retention-sandbox-safety` | The event journal (`event-log.ts`) and run retention. |
| `test-agent-liveness`, `test-orchestration-timeout-margin`, `test-failure-taxonomy` | Liveness timers, deadlines between the MCP client and the socket, classifying worker failures. |
| `test-direct-conversation`, `test-cora-evidence-rules`, `test-prompt-punctuation`, `test-autocompaction`, `test-cora-model-preference`, `test-gpt56-catalog` | Direct conversations, prompt rules, compaction, the remembered manager model, the model catalog. |

### Workers

| Suites | Covers |
|---|---|
| `test-worker-*` (access, cleanup-safety, diff, independence, model-hint, pane-harness-gate, prompt-budget, session-memory-options, session-reuse, sessions; `test-worker-terminal-controls` belongs to remote access) | Worker prompts, tool access, sessions, diffs, and the pane a worker runs in. |
| `test-spawn-batch-guard`, `test-parallel-wave`, `test-autopilot-wave`, `test-peer-comms-opt-in`, `test-verifier-scoping`, `test-direct-worker` | How workers are batched and scheduled (`src/shared/parallel-wave.ts`, `autopilot-wave.ts`), and verifiers. |
| `test-agent-terminal-cleanup`, `test-agent-terminal-lifecycle`, `test-agent-terminal-placement` | Terminals that agents open (`agent-terminal-registry.ts`, `agent-terminal-lifecycle.ts`). |

### Pi runtime, the Cora extension and subscriptions

| Suites | Covers |
|---|---|
| `test-pi-runtime`, `test-pi-backend-session-lifecycle`, `test-pi-rpc-client`, `test-pi-turn`, `test-pi-turn-cost`, `test-pi-mcp-config`, `test-pi-commit-message` | Starting Pi (`pi-runtime.ts`, `pi-runtime-electron.ts`), the RPC client, turns and their cost, the MCP bridge config. |
| `test-pi-cora-extension`, `test-pi-cora-abandonable-wait`, `test-repeat-guard`, `test-deep-search`, `test-whiteboard-review-extension`, `test-whiteboard-quality` | The Pi extension in `resources/pi-cora/`. |
| `test-pi-manager-compaction`, `test-pi-worker-compaction`, `test-pi-manager-compaction-integration.mjs`, `test-pi-worker-compaction-integration.mjs` | Context compaction for the manager and for workers, including the mid-turn pause and the summary recovery ladder. |
| `test-pi-fast-mode-fallback-integration.mjs` (with the fast-mode block in `test-pi-cora-extension`) | Fast mode for the manager and workers: request shaping per provider and model, and the standard-speed fallback through a real offline Pi session. |
| `test-compaction-ledger`, `test-conversation-compaction`, `test-autocompact-limits` | The durable ledger re-injected after each compaction, the run store's conversation cutover, and the owner's auto-compact limit per model and per launch (Pi, Codex, Claude). |
| `test-compaction-eval.mjs` | Offline evaluation: replays 240-tool-call runs through a real Pi session with a lossy, a recorded real-style and a failing summarizer, and checks that facts survive 1, 3 and 6+ compactions within the limit. Variants cover a long opening request, a run that resumes after a conversation cutover, and a huge tool output the model must read before it is compacted. `--verbose` prints every compaction. |
| `test-pi-worker-harness-gate`, `test-pi-worker-providers` | Which providers workers may run on. |
| `test-pi-account-*` (auth-store, execution, profiles, router, settings-surface), `test-pi-subscription-refresh`, `test-pi-subscription-usage-profiles`, `test-pi-usage-applicability`, `test-subscription-headroom`, `test-usage-windows`, `test-pi-oauth-branding`, `test-openrouter-cora` | Cora's side of each account: sign-in, token refresh, usage limits, routing across subscriptions. |

### Accounts (the CLI side, the mirror, the keeper)

| Suites | Covers |
|---|---|
| `test-accounts-no-global-writes`, `test-outside-write-guard`, `test-system-cli-login`, `test-cli-account-homes` | The user's CLI homes stay untouched: a whole account lifecycle leaves them byte-identical, every write helper refuses them, the System login is read for its identity only, and managed homes link only allowlisted shared state. |
| `test-claude-cli-live-login`, `test-claude-login-keeper`, `test-claude-cli-credentials`, `test-claude-cli-account-profiles`, `test-claude-cli-profile-execution`, `test-transcript-repair` | Claude Code accounts: Codara's live slot and the saved logins, the one refresher, the Keychain or file credential store. |
| `test-codex-cli-*` (account-profiles, profile-execution), `test-codex-accounts`, `test-codex-credential-codec`, `test-codex-home-routing`, `test-native-codex-profile-runtime` | Codex accounts: one `CODEX_HOME` per managed account, converting credentials, restored panes of a deleted account. |
| `test-grok-accounts`, `test-grok-credential-codec` | Grok accounts: one `GROK_HOME` per managed account, with shared state linked to the user's home. |
| `test-anthropic-*` (accounts, account-identity, credential-mirror), `test-account-tombstones`, `test-accounts-v2-migration`, `test-unified-account-migration`, `test-account-selection-lock` | `unified-accounts.ts`, `credential-mirror.ts`, deletes that stay deleted, the v1 to v2 migration, the startup pass, and the lock that makes switches take turns across processes. |
| `test-native-cli-*` (accounts, account-wiring, process-shutdown, shell-defaults, terminal-removal), `test-active-cli-env-pointer`, `test-shell-integration-active-env`, `test-cli-custom-homes`, `test-login-return-focus` | How terminals follow the Active account, custom CLI homes, and returning to the app after a browser sign-in. |

### Cora memory and profiles

`test-cora-memory`, `test-cora-profiles`, `test-cora-profile-subscriptions`,
`test-workspace-lessons`, `test-outcome-memory`: `cora-memory.ts`,
`cora-profiles.ts`, `workspace-lessons.ts`, `src/shared/outcome-memory.ts`.
`test-memory-items`, `test-memory-signals`, `test-memory-learning`: learned
memory (`memory-items.ts`, `memory-signals.ts`, `memory-learning.ts`,
`src/shared/memory-items.ts`). `test-cora-memory-eval` (also
`npm run eval:memory`) replays seeded multi-session chats through capture and
prints retrieval metrics for the prompts that follow; no model or network.
`test-unstarted-run-profile` covers the profile a board-minted chat takes on
its first send (`run-store.ts`).

### Automations, looms and the board

| Suites | Covers |
|---|---|
| `test-automations`, `test-automation-loop` | `scheduler.ts` (triggers) and `automation-loop.ts` (runs one iteration after another). |
| `test-automation-precheck`, `test-automation-catchup` | The precheck command (exit codes, output tail, timeout kills the process tree, the Windows and PowerShell invocations), and missed-run catch-up: which cron and interval times were missed, one catch-up pass or one skip at start and wake, the precheck gating trigger and cadence passes but never Run now, and concurrent job writes. |
| `test-loom-graph`, `test-loom-predicates`, `test-loom-steps`, `test-step-live-stream`, `test-loom-model` | Loom graphs, guard nodes, fixed step nodes, and the flow editor's model. |
| `test-board-store`, `test-board-agent-writes`, `test-board-nudge` | The board of each chat (`board-store.ts`, `board-nudge.ts`). |
| `test-workflow-sandbox`, `test-workflow-runtime`, `test-workflow-prelude`, `test-workflow-meta`, `test-workflow-schema` | The workflow script sandbox (no escape), the script API, journal replay and resume caching, and schema checks. |
| `test-workflow-driver`, `test-workflow-admission`, `test-workflow-registry`, `test-workflow-worktree`, `test-pi-worker-workflow-result` | Workflow runs (`workflow-driver.ts`): caps, a failed agent as `null`, stop, resume and restart recovery, saved workflows, worktree isolation, and the result a worker reports. |
| `test-workflow-agent-memory` | Workflow agents and automation workers run on their prompt alone: no saved Cora memory is pinned into them. |
| `test-workflow-mcp-roster` | Who may run workflows: the `codara_workflow_*` roster, the socket's untrusted and mid-compaction guards, and consent before `workflow.run` and `workflow.save`. |

### Terminals and agent detection

| Suites | Covers |
|---|---|
| `test-pty-inherited-env`, `test-npm-run-script-env`, `test-pty-agent-socket-env`, `test-pty-render-backpressure`, `test-pty-spawn-serialization`, `test-pty-account-reattach`, `test-posix-pty-tree-cleanup`, `test-owned-process-tree-descendants` | `pty-manager.ts`: the environment given to a pane (no agent-socket token, only its own `pane.open` token), backpressure, spawning, re-attaching a live pane whatever account its caller recorded, cleaning up child processes. |
| `test-terminal-agent-notify`, `test-terminal-agent-notify-pi`, `test-terminal-agent-readiness`, `test-terminal-agent-state-renderer`, `test-agent-patterns`, `test-codex-terminal-screen`, `test-codex-notify` | Telling that an agent in a pane is running, blocked or idle, and when its turn ends (`terminal-agent-notify.ts`, `src/shared/agent-patterns.ts`, the Codex notify installer and session-file tail). |
| `test-agent-board` | The rail's Agents view: which group every terminal agent and Cora chat lands in and in what order (`src/shared/agent-board.ts`), the layout panes it counts and the cards it keeps unchanged, the remembered switch, and the per-pane prompt, tool, question and last message main's notifier records for it, from hooks and OSC 7501. |
| `test-terminal-redraw`, `test-terminal-scrollback`, `test-terminal-viewport`, `test-terminal-wake-recovery`, `test-terminal-workspace-memory` | Terminal rendering in the renderer: redraw, scrollback, viewport, recovery after sleep, memory limits. |
| `test-session-registry`, `test-session-restore`, `test-resume-matrix`, `test-resume-policy`, `test-codex-session-tracker`, `test-pi-session-tracker`, `test-grok-sessions`, `test-manual-agent-startup`, `test-pane-format` | Finding agent sessions and resuming them after a restart. |
| `test-session-search` | Agent session search (`src/main/session-search/`): the Claude, Codex, Grok, Pi and Cora transcript parsers on fixtures (prose kept, tool output and injected context left out), the SQLite index's first build, appends read from where the last pass stopped, rewrites, removed files, unreadable folders, copies counted once, agents left out, a pass cut short, scope filters, highlights, and the resume command and workspace a found session opens in. |
| `test-terminal-scrollback-store` | Each pane's output kept across restarts (`terminal-scrollback-store.ts`, `terminal-scrollback-render.ts`, with the real `@xterm/headless`): the replayed text holds only text, colors and line breaks; folding old bytes keeps screen, cursor and history; endless footer repaints cannot push history out; 0600 files, debounced saves, per-pane and total limits, deletion on close, age and setting off; a replay until the pane's process starts, never over a live PTY. |
| `test-quit-guard` | What a quit or an update restart would cut off (`quit-guard.ts`, `terminalAgentsMidTurn`): terminal agents mid-turn or waiting inside a turn, the quit prompt's wording, and the update restart that waits, restarts on its own after the settle window, on Restart now, or not at all after Don't restart yet. |
| `test-agent-hibernation-policy`, `test-agent-hibernation-census`, `test-agent-hibernation-main`, `test-pty-hibernate` | Idle agents sleeping in background workspaces (agent hibernation): the setting, which panes are candidates, the notifier evidence and idle clock that must hold, the process census that keeps a pane with a dev server or a late child awake (POSIX and Windows listings, the Windows console-list answer), a pane a phone has open, main's re-check and generation-fenced stop, the output kept for the sleeping view, the sleeping record a reloaded window reads and that ends once the woken pane exits, a hibernated exit that raises no alert, and a sleeping pane across persist, hydration and the quit snapshot. `test-agent-delivery` covers the send refused for a sleeping pane, `test-studio-terminal-share` the phone check. |
| `test-app-exit`, `test-app-exit-electron` | Quits nobody confirms (`app-exit.ts`): the dev launcher watch that quits once electron-vite is gone, SIGTERM, SIGINT and SIGHUP quitting without the live-work prompt (installed after Chromium's own handlers), and a new launch replacing an instance whose window cannot load while still only focusing a healthy one. The Electron suite drives all of it in the built app. |
| `test-clipboard-files` | Pasting files into a terminal on macOS. |
| `test-terminal-unicode-width` | Character widths (`src/shared/terminal-unicode.ts`): emoji and CJK take two cells and box drawing one in every pane, the headless screens in main (`codara_terminal_read`, the Codex mirror) wrap where the pane wraps, and file links (`file-link-provider.ts`) underline the right cells after wide characters. |
| `test-terminal-osc52` | OSC 52 copies from programs in a pane (`osc52.ts`, `terminalClipboard.ts`): parsing as tmux, Neovim and SSH send them, a size cap, clipboard reads never answered, the setting, replayed history, hidden panes and mirrors blocking copies, a burst collapsing to its last copy. |
| `test-terminal-context` | "Copy terminal context" (`terminalContext.ts`) and terminal link clicks (`terminalLinks.ts`): recent output read back as logical lines, the pasted block and its fence, a plain click opening the link menu, Ctrl or Cmd+click opening the link, and the menu rows per scheme. |
| `test-terminal-text` | Text Codara types into a terminal (`src/shared/terminal-text.ts`): a bracketed paste no text can end early, even with nested markers, page text without control characters, the worker prompt paste, and every paste writer using them. |
| `test-servers` | Dev servers, the status view and launch arguments (`src/main/servers/`): the keeper with real processes and fixture servers on free ports (never two copies, port conflicts named, env names without values, logs by cursor and to a file, stop, restart, exit codes, auto-start after a restart), the saved server named when a preview navigates to its down port, learning servers from pane output, adopted agent terminals, tool hellos, the per-runtime startup flags and `--chrome`, and `cora server`. |
| `test-shell-integration-agent-wrappers` | The `claude`, `codex`, `grok` and `pi` functions bash, zsh and PowerShell define in a pane, which add Codara's per-launch flags and the Startup flags from Settings. |

### Claude hooks, the MCP server and the agent socket

`test-hook-installer`, `test-hook-watcher-lifecycle`, `test-codara-studio-mcp`
(the tool list for each `SPARK_MCP_MODE`, protocol negotiation, offline and
error handling, cancellation), `test-agent-terminal-io` (terminal reads with a
cursor, screen rendering and `terminal.run` completion in
`agent-terminal-io.ts`), `test-standing-terminals` (what
`codara_spawn_terminals` opens), `test-builtin-mcp-opt-out`,
`test-builtin-mcp-ownership`, `test-grok-mcp-copy`, `test-agent-sync-toml`
(Capability Center config reads and edits, sync scope, skills, the MCP
probe), `test-mcp-snippet-parse` (the Add server paste box),
`test-capability-center-ui`, `test-skill-import` (Add skill: writing,
folder, zip and git imports), `test-skill-updates` (where skills came from,
update checks against a local repository, update and rollback, CLI copies
only with the capability, Claude Code plugin skills),
`test-remote-capabilities`,
`test-agent-socket-capabilities`, `test-agent-socket-pane-open` (a pane's own
credential and `pane.open`: overlays over the calling pane, tabs beside it),
`test-shell-integration-codara-pane` (the `codara-pane` helper and the
`codara-pane` and `cora` wrappers written at boot), `test-mcp-tool-manifest`
(the tool module contract, module size budgets, the manifest against every
roster, worker fences for new tools), `test-agent-delivery` (sending to a
pane, a chat or the inbox, and `preview.inbox`), `test-workspace-status`
(workspace statuses and notes: the rules in `src/shared/workspace-status.ts`,
the store in `src/main/workspace-status/`, each agent's own note in
`agent-notes.ts`, and the `workspace.status` socket method that writes the
caller's own line), `test-agent-status` (each agent's line in the rail and the
workspace's summary line in `src/shared/agent-status.ts`, a focused tab
clearing done, and a closed pane taking its note along), `test-cos-task-store` (the
workspace task list in `src/main/cos/task-store.ts`: states, the gate-only
`done`, the log and `TASKS.md`, and `scrubSecrets`), `test-cos-verify-gate`
(`.codara/verify.json`, check selection and gate runs against a throwaway
repository), `test-cos-task-tools` (the `task.*` and `inbox.add` socket
methods), `test-run-message-scrub` (a key pasted into a Cora chat or an answer
never reaches run files or manager prompts), `test-agent-socket` (needs a
build).

### Preview browser

`test-preview-*` (auto-open, capture-paint, input-references, keyboard,
navigation, registry, workspace, tools-routing: every tool's socket method has
one handler, `chrome:` ids are gated, every tab tool has a Chrome handler and
results name the tab they acted on; point: the element probe, source maps,
source files and the workspace search, crops, regions under comments and the
text agents receive), `test-browser-pane-webview-liveness`,
`test-browser-storage-boundary`, `test-guest-popups`, `test-browser-targets`
(tab ids and target backends), `test-browser-cdp-session` (the shared
DevTools protocol session and its console and network recorders),
`test-browser-screenshot-locator` (crop and scale math, saved files, and
selectors, boxes and names in a real page), `test-browser-devtools`
(network detail and HAR, emulation, site storage; parsing and bookkeeping
always, then against `tests/e2e/fixtures/devtools-site.cjs` in a real page)
and `test-browser-insight` (the audit and performance tools: contrast and WCAG
formatting, quality check thresholds, trace and heap snapshot summaries on
synthetic files, then axe, page checks, vitals, traced loads and interactions
and a heap snapshot against `scripts/fixtures/insight-pages.cjs`). The last
four run in Playwright's Chromium through `scripts/fixtures/cdp-chromium.cjs`
and print SKIP without it (only the real-page parts of `test-browser-devtools`
and `test-browser-insight` are skipped).
`test-browser-capture` covers the capture features without a browser (pixel
diff and regions, baselines on disk, the sizes sheet, the GIF encoder on its
worker thread, the recorder's sampling and limits), and
`test-browser-capture-chromium` runs them on a real page (element, full-page
and zoomed shots, a diff across a reload, sizes in light and dark,
recordings, and WebM when `ffmpeg` is installed); it prints SKIP without
Chromium too.

The agent's cursor and driving banner (`components/Preview/agent-presence/`):
`test-agent-presence` checks the glide (duration by distance, easing, the
curve), that an action waits for its cursor but never past the cap, Stop and
Undo per agent and tab, and the driver main stamps on every call.
`tests/e2e/agent-presence.spec.ts` drives a Claude Code pane's MCP server in
the built app: the cursor glides before the click lands, the banner names the
agent and its workspace, the agent's own screenshot has no cursor in it, and
Stop refuses its next calls until Undo. Run it with
`CODARA_PRESENCE_VIDEO=1` to film the glide and take stills from the private
X display with `ffmpeg` into `test-results/agent-presence/`.

The browser pane's toolbar and tabs view (`components/Preview/toolbar/`,
`components/Preview/tabs-memory/`): `test-browser-pane` checks when a tab may
sleep and why not (on screen, recording, an agent in the last ten minutes,
its own session), which tabs the 30 minute rule picks, the memory and "asleep
for" texts, the full screen steps of the button, F11 and Esc, and the address
bar's short forms (`5173`, `:3000/admin`). `tests/e2e/browser-pane-toolbar.spec.ts`
drives the built app: labelled tools, the More menu by keyboard, the Video or
GIF chooser, the tabs view with real memory, sleep and wake by hand and by an
agent call, auto-sleep after half an hour, full screen in the window and on
the display, Esc from the page, and the narrow toolbar. It saves screenshots
in both themes to `test-results/browser-pane/`.

What agents do on a page: `test-preview-key-chords` (chord notation, the case
and codes of chord keys, and which of the user's chords stay in the page),
`test-preview-waits` (codara_preview_wait_for: url, navigation, load,
networkidle, fresh elements, a quiet DOM, hot updates, timeout messages),
`test-preview-dialogs` (dialog policies and the guard that keeps a dialog
from freezing a call), `test-preview-find-outline` (find by description, link
targets and icon names in the outline) and `test-preview-console-filter`.
All but the first drive a real Chromium through
`scripts/fixtures/browser-page-target.cjs`, which wraps a page as a
BrowserTarget with the tab recorders running. `test-studio-csp` checks the
Content-Security-Policy of Codara's own window through Vite's dev transform
and in Chromium; `tests/e2e/preview-agent-input.spec.ts` covers all of it in
the built app over the socket, the stdio MCP server and `cora tool`, and
`tests/e2e/preview-hot-reload.spec.ts` runs hot reload waits against a real
Vite dev server.

Browser code mode (`codara_browser_use`, `src/main/browser/code/`):
`test-browser-code` checks the snippet transform (persistent declarations,
top-level await, syntax errors with line and column), the QuickJS kernel as a
sandbox (no require, process, fetch, import or host functions; an endless
loop is interrupted and the session lives on; a timeout keeps the bindings;
late calls are refused), the session lifecycle (reset, isolation, the
dead-owner and idle sweep, six images per call) and Playwright-style locators
driving a login form, a table and a settings form on a real Chromium page.
`test-browser-cdp-access` checks the DevTools allowlist
(`src/main/browser/cdp-policy.ts`: what reaches past the tab or the machine
is refused, navigation stays on http and https) and drives `tab.cdp` and
`tab.network` on a real Chromium page: commands, refusals as BrowserErrors,
`Network.disable` leaving the recorder running, a Debugger that never pauses,
subscriptions that belong to their caller, big results saved to a file, and
redacted sign-in headers on a Chrome tab.
`tests/e2e/browser-code.spec.ts` runs it in the built app over the stdio MCP
server, DevTools access included, and measures it against the single tools.

The Chrome extension link: `test-chrome-extension` (the extension's own
tests in `extensions/chrome/test/`: sharing and blocked-site rules, which
DevTools protocol commands need the cookie permission or are always refused,
cookie redaction, the link client against a fake Codara, the store zip, and
that the packaged app and Settings ship the same files) and
`test-chrome-link` (Codara's side in `src/main/browser/chrome/`: origin and
host checks, pairing with the code and Allow, tokens bound to one extension,
shared and blocked tabs, the relayed protocol, the activity log and
`codara_preview_chrome`, unpairing). The real extension in Playwright's
Chromium is `tests/e2e/chrome-extension.spec.ts`.

### Security boundaries and packaging

`test-ipc-gate-default`, `test-trusted-sender`, `test-fs-sandbox`,
`test-navigation-allowlist`, `test-declared-deps` (every module the main and
preload bundles load at runtime is a declared dependency),
`test-bundled-resources`, `test-renderer-chunks.mjs` (size budget of the
renderer's JavaScript), `test-appimage-launch` (only the process running
from an AppImage's mount keeps its APPIMAGE, so electron-updater cannot
replace an installed AppImage from a build that merely inherited it).

### App state, files and system meters

`test-storage-state-transaction` (a failed write of `spark-state.json` does
not leave half-saved workspaces in memory), `test-storage-openrouter-key`
(the OpenRouter key is encrypted at rest and never lost), `test-fs-watcher-lifecycle` (the
file watcher behind the explorer, `src/main/fs-watcher.ts`),
`test-fs-watcher-events` (runs that watcher on a temporary workspace: changes
in nested and symlinked folders reach the explorer),
`test-fs-watcher-budget` (Linux: counts the process's inotify watches while
that watcher serves a tree full of nested `node_modules`: one per expanded
folder within a budget, polling past it, and back to the baseline after
hundreds of open, expand, collapse and close cycles),
`test-system-metrics` (the title-bar meters and System activity samplers,
`src/main/system-metrics*.ts`: every platform's parsers on captured output,
the Linux sampler on a fake `/proc` and `/sys`, Intel, AMD and NVIDIA GPUs
with fake `nvidia-smi` loops for totals and video memory per process, and
processes grouped by the pane that owns them with CPU, memory, video memory
and swap per pane and other apps folded by program),
`test-system-activity-model` (the popover's model: how each pane's row is
named, where a click on it goes, each resource's rows and top processes,
formatting and the minute of chart history),
`test-keep-awake` (keeping the computer awake
while agents work, `src/main/keep-awake/`: the modes, one OS hold kept in step,
the Linux lid helper and its backoff, that the helper dies with a killed
parent, where the lid option is offered, what counts as work, the
preferences and the quit release).

### Crash and freeze black box

`test-diagnostics-hang-watchdog` (the freeze detector and its settings, then
the real watchdog thread against a busy loop, a block in native code, a
healthy stretch and an exit in the middle of a freeze,
`src/main/diagnostics/hang-watchdog*.ts`), `test-diagnostics-records`
(breadcrumbs and their file, listing and pruning crash dumps, stopping the
AppImage crash handler, event loop windows), `test-diagnostics-export`
(redaction, the zip writer, checked with `unzip -t` and Python's zipfile when
they are installed, and the exported bundle of a fake home). The built app is
covered end to end by `tests/e2e/crash-diagnostics.spec.ts`: a real freeze,
a real renderer crash, a real GPU process crash (launched before `ready`, so
it proves Crashpad starts early), Settings, About and the export.

### Remote access (phone) and SSH workspaces

| Suites | Covers |
|---|---|
| `test-remote-port-forward` | SSH port forwarding: terminal URL and port-listing parsers (ss, netstat, lsof, /proc), local port choice, and the forward lifecycle against an in-process ssh2 server. |
| `test-remote-access`, `test-remote-access-hostile.mjs`, `test-remote-relay-client`, `test-mutation-ledger` | `src/main/remote-access/`: pairing, the protocol, the relay, idempotent writes, attacks before sign-in. |
| `test-remote-cora-contract`, `test-cora-history-interop`, `test-cora-run-interop`, `test-cora-run-message-window` | The exact data the phone app receives for Cora chats. |
| `test-terminal-leases`, `test-studio-terminal-share`, `test-phone-terminal-spawn`, `test-worker-terminal-controls`, `test-remote-access-terminal-launch` | Terminals used from the phone, and that they run the desktop's own launch commands. |
| `test-remote-access-workspace-roots`, `test-remote-access-cora-send-rate` | What a phone may not do: add the home folder or a credentials folder as a workspace, or send Cora messages faster than its budget. |
| `test-phone-notify`, `test-terminal-phone-notify` | Notifications sent to the phone. |
| `test-remote-connection-lifecycle`, `test-box-key-retry`, `test-ssh-keys` | SSH workspaces (`src/main/remote/`), not the phone. |
| `test-remote-proxycommand`, `test-ssh-config-include`, `test-codara-boxes-cli` | SSH over a ProxyCommand (`proxy-command.ts`), `~/.ssh/config` Include and ProxyCommand reading with the refusal of unsafe `%h`/`%r`/`%n`, and the Codara Cloud boxes picker that reads the `codaracloud` CLI (`codara-boxes.ts`). |
| `test-machine-probe`, `test-host-keys` | The Machines page: the probe's parser on recorded output from a host, a container limited by cgroup v2 and macOS (`scripts/fixtures/machine-probe/`), the service against fake connections (never probes a disconnected host, stops only orphaned sessions), fingerprints against `ssh-keygen`, `known_hosts` matching, and the confirm, refuse and changed-key flows of `connections.ts`. The UI and a real sshd are `tests/e2e/machines.spec.ts`. |
| `test-machines-default` | Machines on by default: no file and an old saved default both read on, only the user's own choice turns it off; with no SSH machines nothing connects or probes and the Add pane menu has no Where row; after an update a restored SSH agent starts once, in tmux. |
| `test-remote-agents`, `test-remote-pty`, `test-pty-remote-agents` | Agents on SSH machines kept in tmux (`remote-agents.ts`, `remote-pty.ts`, and their wiring in `pty-manager.ts`): the launch, attach, probe and kill lines run under `/bin/sh` against fake `tmux` and `claude`, reconnects after a dropped connection, and which closes end the agent. The real sshd and tmux are `tests/e2e/remote-agent.spec.ts`, which starts a throwaway container with `scripts/ssh-test-host.cjs` (`tests/e2e/fixtures/ssh-host`) and is skipped without Docker. |

### Git and GitHub

`test-git-*`, `test-github-*` (30 files: the `gh` wrapper, publishing,
merging, reviews, pull request import, issues, push alerts, the work queue,
stashing while another process holds the index lock, GIT_OPTIONAL_LOCKS=0 on
every git Codara spawns; `test-git-fix-prompts`, `test-git-fix-context` and
`test-git-fix-targets` cover Fix with agent: redaction, log and conflict
slicing, prompt budgets, hooks and conflicts in throwaway repositories, a
scripted `gh`, and the dialog's targets; `test-github-ci-watch` covers the
pull request watcher: REST parsing, the backoff, rows, alerts and the green
note; `test-ci-agent-nudge` covers telling the agent, once per failing
commit and never mid-turn, and the ETag reads; `tests/e2e/pr-watch-agent.spec.ts`
runs it end to end with a scripted `gh`),
`test-worktrees`, `test-worktree-delete-dialog`, `test-untrusted-pr-policy`
(the checkout of an imported pull request stays untrusted, whatever path
tricks it tries), `test-agent-worktrees` (worktrees agents create and remove
through the MCP tools: merge proofs, every refusal, recovery refs, the audit
log, the repository lock and the process scan, against throwaway
repositories with a fake git config), `test-agent-worktrees-docs` (every
removal refusal code is documented in `docs/mcp-tools.md`),
`test-review-diff` (the review tab's combined diff against throwaway
repositories: every kind of change, no commit yet, the branch view from the
merge base, the line budget and deferred files, untracked links shown by
their target and never followed, a nested repository, the capped read of a
huge untracked file, a conflict, a diff too large for one read, and a
one-hunk patch git applies), `test-worktree-cleanup`
(the worktree cleanup screen: the scan's git facts, filters, the full check,
every refusal, confirmed removals with their recovery refs, kept branches,
sizes and their cache, against throwaway repositories with a fake git config),
`test-worktree-rail-cleanup` (merged and missing worktrees in the rail:
a branch already gone counts as deleted and an unmerged one is kept with a
note, the rail's merge state, Clean up and Remove from rail, and the automatic
cleanup of a missing folder refusing dirty, unpushed, busy, locked and
possibly unmounted worktrees),
`test-worktree-cleanup-agent` (codara_worktree_cleanup: the recommendation
rules, the scan's facts across repositories, nothing removed without the
user's approval, unticked, unsaved and busy worktrees kept, and remote
branches deleted only when offered and unmoved, with a fake GitHub and remote),
`test-worktree-setup` (what a new worktree gets from `.worktreeinclude` and
`.codara/worktree.json`: git's own pattern matching, copies that never
overwrite or leave the repository, the copy limit, commands in order, stop,
restart and the agent tools; the POSIX-only checks skip on Windows).

### Notifications

`test-notify-policy`, `test-notify-deliver` (which transports fire and the
chime burst filter), `test-notify-center-store` (persistence, mutes, the
summary push), `test-notify-center-model` (folding, eviction, age limits,
settling, the badge count), `test-notify-center-view` (the bell panel's
sections, stacks, times, that the badge, tab and pinned header agree, and
what a click on a gone target does), `test-notify-run-settle` (a run that
is deleted, stopped, cancelled or ends its automation settles its question),
`test-toast-lifecycle`, `test-sse-client` (the update event stream and
`notify-release.cjs`).

### Renderer UI logic

These suites bundle renderer modules without React where they can:
`test-chat-*`, `test-composer-fast-mode`, `test-model-effort-shortcuts`,
`test-agent-destinations` (where a pick, a comment or a tab reference from a
browser tab can be sent, and the default),
`test-review-notes` (review notes: the batch text an agent gets, the review
tab's rows, anchors and quotes, the folder git actions run in, where a batch
can go, the command a new agent starts with, and main's per-workspace store
in Codara's own folder, which a failed read never lets a save wipe),
`test-dock-layout`, `test-split-drop`, `test-tab-reorder`, `test-tab-groups`
(group membership, naming, colors, collapse, drops into and out of a group,
saved groups), `test-workspace-reorder`, `test-workbench-routing`, `test-editor-tabs`,
`test-workspace-colors`, `test-explorer-clipboard`, `test-file-tree-marquee`,
`test-file-preview-capabilities`, `test-csv-preview`, `test-csv-preview-ui`,
`test-run-graph-layout`, `test-overlay-performance`,
`test-renderer-boot-ready`, `test-onboarding`, `test-usage-analytics`,
`test-usage-roster` (the title bar's Usage panel: row order, chips, every
account with its email, what a switch does, reset and credit copy),
`test-settings-dialog` (Settings closes only through Escape, X, Done or
Cancel; every search result is rendered; the face is opaque; a menu closes on
a scroll only when its anchor moved), `test-settings-search` (every rendered
Settings row has a search entry; ranking, typos, synonyms and highlights),
`test-account-card-keys` (an account
card keeps its key while it gains or loses a half), `test-quick-commands`
(saved shell commands and agent prompts: the stored list, repository scope,
`{branch}` and `{cwd}`, the terminal right-click choice and where a command
goes), `test-feature-tips` (the feature tips catalog, when a tip may appear
and where it goes, the feature-tips.json store and its IPC; a catalog
selector naming a control the
renderer no longer has fails here).

### The `cora` CLI and its benchmark

`test-cora-cli` (runs the CLI offline against made-up runs), `test-cora-tool`
(`cora tool` against a fake socket: pane identity, images as files, exit
codes), `test-cora-task-cli` (`cora task` and `cora inbox add` against a fake
socket), `test-bench-*` (`cli/bench/`).

### Release tooling

`test-release-pipeline` (bundles, tags and publishing in the nightly
release), `test-macos-keychain` (the electron-builder signing patch).

## Smoke and live scripts

None of these are in the registry.

| Script | Needs |
|---|---|
| `smoke-pi-live.cjs`, `smoke-pi-worker-live.cjs`, `profile-pi-subagent-lifecycle.cjs` (`npm run smoke:pi-live`, `smoke:pi-worker-live`, `profile:pi-subagent-lifecycle`) | Real inference on your subscription. They refuse to run unless `CODARA_ALLOW_LIVE_PI_SMOKE=1` is set. |
| `smoke-cora-*.cjs`, `smoke-harness-comparison.cjs`, `smoke-browser-reference.cjs`, `smoke-preview-dom.cjs` | A running development Studio, reached over the agent socket through `cli/lib/rpc.cjs`. Most also need variables naming a separate lab home and an output file, such as `CODARA_CONTEXT_SMOKE_HOME` and `CODARA_CONTEXT_SMOKE_OUTPUT`. See [docs/harness-lab/README.md](../docs/harness-lab/README.md) for how to set up that instance. |
| `smoke-claude-live-slot-hotswap.cjs` (`npm run smoke:claude-hotswap`) | `claude` on `PATH`. No subscription or network: it runs a real Claude Code session against a local mock API, switches Codara's live slot from one account to another between two turns, and checks that the next request carries the new account's token. On macOS it creates and then deletes one Keychain item named after its temporary slot. |
| `live-github-push-watch-probe.cjs` | Network access and a signed-in `gh`. |
| `remote-access-e2e.mjs` with `remote-test-client.mjs` (`npm run test:remote-access-e2e`) | Nothing extra. It starts the real remote-access service over a temp home and drives it the way the phone does. |
| `profile-session-index.cjs` | Nothing extra. It builds the agent session index from this computer's real transcripts into a temp folder (reading them only) and prints the time, peak memory, index size and search times. `--pace interactive` measures a pass you start; `--claude DIR` and the like point it at other folders. |

## Tooling

| Script | When it runs | What it does |
|---|---|---|
| `run-all-tests.cjs` | `npm test`, `npm run test:all` | The test runner described above. |
| `stamp-dev-electron-icon.cjs` | `postinstall`, `predev`, `prestart` | Puts the Codara icon and version strings on the development Electron binary. |
| `brand-pi-oauth-page.cjs` | `postinstall` | Puts Codara's mark on the page a subscription sign-in ends on. Checked by `test-pi-oauth-branding`. |
| `patch-macos-keychain.cjs` | `postinstall` | Adds an unreleased electron-builder fix for macOS signing. Checked by `test-macos-keychain`. |
| `inspect-run.cjs` | `npm run inspect-run -- <run-id>` | Writes a markdown dump of one run: `run.json`, events, manager calls, worker prompts, logs and reports. Use it to debug a run. |
| `dev-commit-message-preview.cjs` | By hand | Runs the real commit message pipeline against a repository. |
| `release.cjs`, `publish-release.cjs` | `npm run release:mac\|win\|all` | The manual release, built from a clean worktree. Needs the untracked `.env.releases`. |
| `ci-version.cjs`, `release-github.cjs`, `release-bundle.cjs`, `publish-release-bundle.cjs`, `release-storage.cjs`, `notify-release.cjs` | `.github/workflows/release.yml` | The steps of the nightly release: pick the version, save the build bundle, tag, publish, announce. |
| `setup-release-app.cjs` | Once, by an organization owner | Creates the GitHub App that tags releases. |

[docs/releasing.md](../docs/releasing.md) covers both release paths.
