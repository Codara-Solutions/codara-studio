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
| `npm test` | Runs every `scripts/test-*.cjs` and `test-*.mjs`, sorted by name. |
| `npm test -- <regex>` | Runs only the files whose name matches the regex, for example `npm test -- loom-steps` or `npm test -- "^test-(claude\|codex)-"`. |
| `node scripts/test-notify-policy.cjs` | Runs one suite directly. Suites find the repository from their own file location, so you do not need to `cd` first. |
| `npm run test:<name>` | Shortcuts for some suites or groups of suites, defined in `package.json`. You never need one: the runner already picks up every file. |
| `npm run typecheck` | The three TypeScript projects (node, web, e2e). Not part of `npm test`; run it too. |

How `scripts/run-all-tests.cjs` works:

- **The filename glob is the registry.** A new `test-*.cjs` or `test-*.mjs`
  file runs as soon as it exists. You add no entry anywhere. A `.ts` file does
  not match: `test-cora-direct-mode.ts` only runs through
  `npm run test:cora-direct-mode`.
- Each file runs as `node <file>` in its own process with a 180 second
  timeout. It passes when it exits with code 0.
- The runner prints `ok` or `FAIL` for each file, then a pass count, then the
  last 6000 characters of each failure's output. It exits with code 1 if any
  file failed.

The Playwright specs are separate. They live in `tests/e2e/`:

```sh
npm run test:e2e                                  # build, then every spec
npm run build && npx playwright test tests/e2e/tab-reorder.spec.ts
SPARK_E2E_BACKGROUND=0 npx playwright test ...    # show the app window
```

`playwright.config.ts` runs one spec at a time, and each spec boots a real
Electron app. The config also removes the Codara variables a Studio pane
exports, such as `SPARK_PANE_ID`, the agent socket and `CODARA_HOME_DIR`, so
a test run started inside Studio does not talk to the live app.

## Suites with extra needs

Most suites need only `npm install`. These are the exceptions:

| Need | Suites | Notes |
|---|---|---|
| A build in `out/` | `test-agent-socket.cjs` | Launches `out/main/index.js` under Electron with a temporary home. Run `npm run build` (which is `electron-vite build`) first. Without a build the app never writes its handshake file and the suite fails. |
| The Electron binary | `test-agent-socket.cjs`, `test-trusted-sender.cjs` | Both boot a headless Electron from `node_modules`. |
| Playwright's Chromium | `test-chat-surface-routing.cjs`, `test-csv-preview-ui.cjs` | Install it with `npx playwright install chromium`. |
| Real `git` | `test-worktrees.cjs`, `test-git-auto-fetch-git.cjs`, `test-git-split-commits.cjs`, `test-github-pull-request-git.cjs`, `test-result-manifest.cjs`, `test-worker-diff.cjs`, `test-browser-storage-boundary.cjs` | Most create throwaway repositories in a temp dir. `test-browser-storage-boundary.cjs` runs `git ls-files` on this checkout, so it needs a git clone. |
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
  even fails if your real `~/.claude/settings.json` changed during its run.
- Suites that go through Claude Code's credential store set
  `CODARA_DISABLE_KEYCHAIN=1`. This is a test seam in
  `src/main/orchestration/claude-cli-credentials.ts`: with it set, the real
  credential backend never runs `/usr/bin/security`, so no macOS Keychain
  item is read or written. Nine suites use it: `test-anthropic-accounts`,
  `test-anthropic-account-migration`, `test-anthropic-credential-mirror`,
  `test-claude-cli-account-profiles`, `test-claude-cli-credentials`,
  `test-claude-cli-live-login`, `test-claude-login-keeper`,
  `test-pi-subscription-refresh` and `test-unified-account-migration`. A new
  suite that reaches that module must set it too.
- A shell inside a Studio pane exports Codara variables (`SPARK_PANE_ID`,
  `SPARK_AGENT_SOCKET`, `SPARK_HOME_DIR`, and so on). Suites that could pick
  them up set their own values or delete them. If a suite behaves differently
  inside Studio than in a plain terminal, suspect a variable it inherited.

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
- **Real processes**: `test-agent-socket.cjs` and `test-trusted-sender.cjs`
  start Electron. `remote-access-e2e.mjs` starts the real remote-access
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
| `test-pi-cora-extension`, `test-repeat-guard`, `test-deep-search`, `test-whiteboard-review-extension`, `test-whiteboard-quality` | The Pi extension in `resources/pi-cora/`. |
| `test-pi-manager-compaction`, `test-pi-worker-compaction`, `test-pi-manager-compaction-integration.mjs`, `test-pi-worker-compaction-integration.mjs` | Context compaction for the manager and for workers. |
| `test-pi-worker-harness-gate`, `test-pi-worker-providers` | Which providers workers may run on. |
| `test-pi-account-*` (auth-store, execution, profiles, router, settings-surface), `test-pi-subscription-refresh`, `test-pi-subscription-usage-profiles`, `test-pi-usage-applicability`, `test-subscription-headroom`, `test-usage-windows`, `test-pi-oauth-branding`, `test-openrouter-cora` | Cora's side of each account: sign-in, token refresh, usage limits, routing across subscriptions. |

### Accounts (the CLI side, the mirror, the keeper)

| Suites | Covers |
|---|---|
| `test-claude-cli-live-login`, `test-claude-login-keeper`, `test-claude-cli-credentials`, `test-claude-cli-account-profiles`, `test-claude-cli-profile-execution`, `test-transcript-repair` | Claude Code accounts in one home: the live login and saved logins, the one refresher, the Keychain or file credential store. |
| `test-codex-cli-*` (account-profiles, auth-selector, profile-execution), `test-codex-accounts`, `test-codex-account-migration`, `test-codex-credential-codec`, `test-codex-home-routing` | Codex accounts: swapping `auth.json`, the saved logins, converting credentials. |
| `test-grok-accounts`, `test-grok-account-migration`, `test-grok-credential-codec`, `test-native-cli-shared-state` | Grok accounts: one `GROK_HOME` per managed account, with shared state linked to the personal home. |
| `test-anthropic-*` (accounts, account-identity, account-migration, credential-mirror), `test-unified-account-migration`, `test-account-selection-lock` | `unified-accounts.ts`, `credential-mirror.ts`, the startup migration, and the lock that makes switches take turns across processes. |
| `test-native-cli-*` (accounts, account-wiring, process-shutdown, shell-defaults, terminal-removal), `test-active-cli-env-pointer`, `test-shell-integration-active-env`, `test-cli-custom-homes`, `test-login-return-focus` | How terminals follow the Active account, custom CLI homes, and returning to the app after a browser sign-in. |

### Cora memory and profiles

`test-cora-memory`, `test-cora-profiles`, `test-cora-profile-subscriptions`,
`test-workspace-lessons`, `test-outcome-memory`: `cora-memory.ts`,
`cora-profiles.ts`, `workspace-lessons.ts`, `src/shared/outcome-memory.ts`.

### Automations, looms and the board

| Suites | Covers |
|---|---|
| `test-automations`, `test-automation-loop` | `scheduler.ts` (triggers) and `automation-loop.ts` (runs one iteration after another). |
| `test-loom-graph`, `test-loom-predicates`, `test-loom-steps`, `test-step-live-stream`, `test-loom-model` | Loom graphs, guard nodes, fixed step nodes, and the flow editor's model. |
| `test-board-store`, `test-board-agent-writes`, `test-board-nudge` | The board of each chat (`board-store.ts`, `board-nudge.ts`). |

### Terminals and agent detection

| Suites | Covers |
|---|---|
| `test-pty-inherited-env`, `test-pty-render-backpressure`, `test-pty-spawn-serialization`, `test-posix-pty-tree-cleanup`, `test-owned-process-tree-descendants` | `pty-manager.ts`: the environment given to a pane, backpressure, spawning, cleaning up child processes. |
| `test-terminal-agent-notify`, `test-terminal-agent-notify-pi`, `test-terminal-agent-readiness`, `test-terminal-agent-state-renderer`, `test-agent-patterns`, `test-codex-terminal-screen` | Telling from a pane's output that an agent is running, blocked or idle (`terminal-agent-notify.ts`, `src/shared/agent-patterns.ts`). |
| `test-terminal-redraw`, `test-terminal-scrollback`, `test-terminal-viewport`, `test-terminal-wake-recovery`, `test-terminal-workspace-memory` | Terminal rendering in the renderer: redraw, scrollback, viewport, recovery after sleep, memory limits. |
| `test-session-registry`, `test-session-restore`, `test-resume-matrix`, `test-resume-policy`, `test-codex-session-tracker`, `test-grok-sessions`, `test-manual-agent-startup`, `test-pane-format` | Finding agent sessions and resuming them after a restart. |
| `test-clipboard-files` | Pasting files into a terminal on macOS. |

### Claude hooks, the MCP server and the agent socket

`test-hook-installer`, `test-hook-watcher-lifecycle`, `test-codara-studio-mcp`
(the tool list for each `SPARK_MCP_MODE`), `test-builtin-mcp-opt-out`,
`test-builtin-mcp-ownership`, `test-grok-mcp-copy`,
`test-capability-center-ui`, `test-remote-capabilities`,
`test-agent-socket-capabilities`, `test-agent-socket` (needs a build).

### Preview browser

`test-preview-*` (auto-open, capture-paint, input-references, keyboard,
navigation, registry, workspace), `test-browser-pane-webview-liveness`,
`test-browser-storage-boundary`, `test-guest-popups`.

### Security boundaries and packaging

`test-ipc-gate-default`, `test-trusted-sender`, `test-fs-sandbox`,
`test-navigation-allowlist`, `test-declared-deps` (every module the main and
preload bundles load at runtime is a declared dependency),
`test-bundled-resources`, `test-renderer-chunks.mjs` (size budget of the
renderer's JavaScript).

### App state, files and system meters

`test-storage-state-transaction` (a failed write of `spark-state.json` does
not leave half-saved workspaces in memory), `test-fs-watcher-lifecycle` (the
file watcher behind the explorer, `src/main/fs-watcher.ts`),
`test-system-metrics` (the memory figure in the title-bar meters,
`src/main/system-metrics.ts`).

### Remote access (phone) and SSH workspaces

| Suites | Covers |
|---|---|
| `test-remote-access`, `test-remote-access-hostile.mjs`, `test-remote-relay-client`, `test-mutation-ledger` | `src/main/remote-access/`: pairing, the protocol, the relay, idempotent writes, attacks before sign-in. |
| `test-remote-cora-contract`, `test-cora-history-interop`, `test-cora-run-interop`, `test-cora-run-message-window` | The exact data the phone app receives for Cora chats. |
| `test-terminal-leases`, `test-studio-terminal-share`, `test-phone-terminal-spawn`, `test-worker-terminal-controls` | Terminals used from the phone. |
| `test-phone-notify`, `test-terminal-phone-notify` | Notifications sent to the phone. |
| `test-remote-connection-lifecycle`, `test-ssh-keys` | SSH workspaces (`src/main/remote/`), not the phone. |

### Git and GitHub

`test-git-*`, `test-github-*` (21 files: the `gh` wrapper, publishing,
merging, reviews, pull request import, issues, push alerts, the work queue),
`test-worktrees`, `test-worktree-delete-dialog`, `test-untrusted-pr-policy`
(the checkout of an imported pull request stays untrusted, whatever path
tricks it tries).

### Notifications

`test-notify-policy`, `test-notify-center-store`, `test-toast-lifecycle`,
`test-sse-client` (the update event stream and `notify-release.cjs`).

### Renderer UI logic

These suites bundle renderer modules without React where they can:
`test-chat-*`, `test-composer-fast-mode`, `test-model-effort-shortcuts`,
`test-dock-layout`, `test-split-drop`, `test-tab-reorder`,
`test-workspace-reorder`, `test-workbench-routing`, `test-editor-tabs`,
`test-workspace-colors`, `test-explorer-clipboard`, `test-file-tree-marquee`,
`test-file-preview-capabilities`, `test-csv-preview`, `test-csv-preview-ui`,
`test-run-graph-layout`, `test-overlay-performance`,
`test-renderer-boot-ready`, `test-onboarding`, `test-usage-analytics`.

### The `cora` CLI and its benchmark

`test-cora-cli` (runs the CLI offline against made-up runs), `test-bench-*`
(`cli/bench/`).

### Release tooling

`test-release-pipeline` (bundles, tags and publishing in the nightly
release), `test-macos-keychain` (the electron-builder signing patch).

## Smoke and live scripts

None of these are in the registry.

| Script | Needs |
|---|---|
| `smoke-pi-live.cjs`, `smoke-pi-worker-live.cjs`, `profile-pi-subagent-lifecycle.cjs` (`npm run smoke:pi-live`, `smoke:pi-worker-live`, `profile:pi-subagent-lifecycle`) | Real inference on your subscription. They refuse to run unless `CODARA_ALLOW_LIVE_PI_SMOKE=1` is set. |
| `smoke-cora-*.cjs`, `smoke-harness-comparison.cjs`, `smoke-browser-reference.cjs`, `smoke-preview-dom.cjs` | A running development Studio, reached over the agent socket through `cli/lib/rpc.cjs`. Most also need variables naming a separate lab home and an output file, such as `CODARA_CONTEXT_SMOKE_HOME` and `CODARA_CONTEXT_SMOKE_OUTPUT`. See [docs/harness-lab/README.md](../docs/harness-lab/README.md) for how to set up that instance. |
| `live-github-push-watch-probe.cjs` | Network access and a signed-in `gh`. |
| `remote-access-e2e.mjs` with `remote-test-client.mjs` (`npm run test:remote-access-e2e`) | Nothing extra. It starts the real remote-access service over a temp home and drives it the way the phone does. |

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
