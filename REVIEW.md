# Codara Studio review, September 2026

A full pass over the repository: documentation, open-source hygiene, security,
the main process, the terminal output path, the orchestration and accounts
code, and product ideas. Findings are grouped by the three things you said
hurt most (performance, accounts, notifications) first. Every claim below
was verified by reading code unless marked as an estimate. Line numbers are
from commit `63fcbbb4`.

This file is a working document for the maintainers, not user documentation.
Delete it once the items are ticketed.

## What changed in this pass

Code:

- **False "finished" notifications fixed for background subagents.** Claude
  Code fires `Stop` when the main turn ends even while Agent-tool subagents
  keep running in the background; the byte-stream heuristic then sees an
  idle prompt and alerts. `src/main/terminal-agent-notify.ts` now keeps a
  hook-fed counter per pane (`SubagentStart` / `SubagentStop`) and holds the
  finish, exactly like the existing teammate hold, until the last subagent
  stops. `src/main/hook-watcher.ts` routes hook events for panes you opened
  yourself to the notifier (they were dropped before), and
  `src/main/hook-installer.ts` now installs `SubagentStart` and `SessionEnd`
  too. Tests updated and a new scenario added
  (`scripts/test-terminal-agent-notify.cjs`, 60 checks pass;
  `test-hook-installer`, `test-hook-watcher-lifecycle`, `test-notify-policy`
  pass; `typecheck` clean).
- Removed the unused `@anthropic-ai/claude-agent-sdk` dependency (3.8 MB, zero
  imports) and its `asarUnpack` entry; lockfile synced without installing.

Repository:

- `package.json`: `repository`, `homepage`, `bugs`, `license`, `keywords`,
  `engines`, author set to Codara Solutions, `npm test` entry, removed the
  Windows-only `build:safe` and the inert `allowScripts` block.
- Deleted `build/icon-legacy.*` (referenced by nothing).
- `.gitignore`: dropped `dist2/ dist3/`; `.claude/` narrowed to local files so
  team-shared Claude settings can be tracked later.
- New: `.editorconfig`, `.nvmrc` (22), `.mailmap`, `.github/dependabot.yml`,
  `.github/CODEOWNERS`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md` (generated from
  tags and conventional commits).
- CI: both workflows use `.nvmrc` (they disagreed: tests on Node 24, release
  build on 22), `ci.yml` gets `permissions: contents: read`, both run
  `typecheck:e2e`.
- Husky hook: install hints for macOS and Linux, not only winget.

Documentation, all rewritten against the code:

- `README.md` (pitch, feature tour, quick start, agent integration, CLI,
  accounts, shortcuts, developing, releasing), `AGENTS.md`, `CONTRIBUTING.md`,
  `SECURITY.md` (correct base64 hash verification), `cli/README.md` fixes.
- New `docs/`: `architecture.md`, `glossary.md`, `mcp-tools.md` (generated
  from `server.js`), `cli.md` (from `cora help`), `shortcuts-and-settings.md`
  (from `commands.ts` and the Settings tabs), `on-your-machine.md`,
  `releasing.md`, `remote-access.md` (the file eight source headers already
  referenced).

Nothing was committed. Review the diff and commit in whatever slices you like.

## 1. Performance

The symptom you describe (lag while a Claude Code session spawns many
subagents) has four contributing paths. Ranked by expected impact.

### 1.1 Every hidden terminal parses and renders the full stream

`TerminalStack.tsx:1271-1275` passes `writeWhileHidden` to every pane, so
`useTerminalSession.ts:2603-2613` writes every chunk into every mounted
xterm, visible or not. Mounted means: every tab and pane of the active
workspace, plus one warm inactive workspace, plus keep-alive workspaces
(`App.tsx:7251-7268`, `terminalWorkspaceLayers.ts:5`), each with its own WebGL
context. Claude Code repaints its whole screen at 30 to 60 fps; with a
20-agent run the parent pane alone is a firehose, and every hidden xterm pays
the same parse and layout cost. The elaborate hidden-buffer stash/replay
machinery (`useTerminalSession.ts:739-819`, `3551-3600`) is dead code for
normal panes because the flag is always true.

Fix (small): pass `writeWhileHidden` only for alt-screen agent panes that must
keep their buffer live, or dispose the WebGL addon while hidden and reload it
on reveal (`recoverRendererOnShow` at `:1020-1067` already has the reload
logic). Medium: unmount xterm for non-active tabs after a grace period; the
4 MB raw-tail reattach path in `pty-manager.ts:742-781` already exists.

### 1.2 Per-chunk regex scanning on the main thread

`pty-manager.ts:1740-1748` fans every raw node-pty chunk (about 44 bytes
each) to `terminal-agent-notify.ts` `onChunk` (`:681-800`), which decodes,
concatenates into an 8 KB ring, strips ANSI, and runs 14 to 17 regexes, for
every watched pane. Estimate: 20 to 80 µs per chunk on the main thread, which
also owns every PTY pump, so a busy pane stalls all terminals a little. Fix
(medium): tap the coalesced 16 ms flush in `flushDataNow` instead of raw
chunks (10 to 50 times fewer regex passes) and skip the runtime sniff when a
chunk has no printable letters.

The renderer duplicates this: `useTerminalSession.ts:2304-2540` rebuilds an
8 KB string ring and runs `sniffLiveRuntime` (stripAnsi plus 14 regexes) per
chunk on every plain shell pane forever (`:2340-2341`), and on the visible
idle pane also reads 40 buffer lines via `translateToString` per chunk
(`:2353-2415`). The 1 s `presenceTimer` (`:2284-2295`) already does that job.
Fix (small): `indexOf` prefilter on banner keywords, and rate-limit the tail
read to the presence timer.

### 1.3 The hook path: one Python process per tool call, for every session

The hook in `~/.claude/settings.json` runs `python3 codara-hook.py` on every
`PreToolUse` and `PostToolUse` of every Claude Code session on the machine,
including subagents and sessions outside Codara. Each run writes a JSON file
(fsync), `hook-watcher.ts` reads and parses it, dispatches, and renames it
into `processed/` where it lives for a week. With 20 subagents each making a
tool call every few seconds that is tens of Python spawns per second (each
30 to 60 ms of CPU) plus the same number of fs.watch events, reads, and
renames. For panes you opened yourself the payload was, until this pass,
discarded entirely after all that work.

Fixes, in order of value:

1. Do not install `PreToolUse` and `PostToolUse` globally. Codara consumes
   them only for orchestrated worker panes (the Session Inspector). Install
   them per worker via the run's own settings, or gate the Python script on
   `SPARK_PANE_ID` being set and the pane being a worker (the hook can exit
   immediately when the env says "not mine", before touching the disk).
2. Replace the Python script with the loopback socket the app already runs:
   a `curl`/`node -e` POST to `SPARK_HOOK_URL` (the variable exists,
   `hook-rpc.ts`) with a fallback to the file drop only when the app is
   offline. That removes fs.watch, the processed directory, and the weekly
   prune.
3. `applyHookEvent` (`run-store.ts:18023`) appends to `events.jsonl` per
   event with an fsync; batch the appends per 100 ms.

### 1.4 Main-process memory per pane

The 4 MiB tail per session is an array of about 95k tiny Buffers at cap
(`pty-manager.ts:303`, `:1757-1770`), roughly 12 MB per busy pane with
object overhead. `resume()` sends the whole 16 MiB detached backlog as one
IPC message (`:1855-1878`) and reattach sends up to 4 MB in one message
(`:777-781`), which is one synchronous structured clone plus one xterm write,
and can trip the 2 s ack watchdog. Fix (small): chunk replays to 256 KB;
(medium) a fixed ring `Buffer` for the tail.

### 1.5 Other periodic work worth measuring

- `unified-accounts.ts:645` probes the personal credential every 60 s per
  provider, and the credential mirror `fs.watch`es every account's auth
  files; `pi-backend.ts:355`, `run-store.ts:19294` and `:20176`,
  `worker-launch.ts:243`, `scheduler.ts:573` and `:790` (git trigger poll),
  `production.ts:3359` (phone receipts), `auto-updater.ts:139` all run
  intervals. None looked expensive on paper; instrument with
  `--cpu-prof` on the main process during a 20-agent run before touching
  them.
- The renderer's per-agent-pane state poller runs every 300 ms
  (`useTerminalSession.ts:3934`) and reads the buffer tail each tick.
- Chat, runs list, and board virtualization was not verified in this pass
  (the renderer reviewer was cut off); check `ChatConversation.tsx` and
  `timeline.ts` for whole-timeline rebuilds per streamed chunk.

### 1.6 How to confirm

Run a 20-agent Claude session in one pane, then: Electron
`--cpu-prof` for the main process (expect `onChunk` and hook-watcher near the
top), the renderer performance panel (expect xterm `write` and
`processAgentChunkText` per mounted pane), and `top` (expect a Python
process spawn storm). Fix 1.1 first; it is a one-line change and the
largest win.

## 2. Accounts

### 2.1 Why it keeps breaking

Accounts are 25 files and 11.6k lines under `src/main/orchestration/`
(`unified-accounts.ts` 1370, `claude-cli-account-profiles.ts` 1433,
`grok-cli-account-profiles.ts` 1047, `codex-cli-account-profiles.ts` 1013,
`pi-account-profiles.ts` 988, `native-cli-shared-state.ts` 840,
`credential-mirror.ts` 793, `pi-account-auth-store.ts` 743, ...). Forty-four
of the last 300 commits are `accounts` fixes. Reading the last 25, the
failures cluster into five classes:

1. **Two refreshers, one grant.** An account's Cora half (Pi) and CLI half
   (Claude Code) both hold the same OAuth grant and both refresh it; refresh
   tokens rotate, so whichever side refreshed last holds the only valid
   token and the mirror must copy it to the other side before that side
   tries to refresh a dead one. `credential-mirror.ts` encodes seven rules
   to make that safe (`:12-46`) and still needed "the fresher Claude
   credential store wins the read" (`9fad8c05`) and "a slot logged into
   another account is never adopted" (`fb9e0913`, `e4a2f2fe`). This is
   structurally racy: two independent clients rotating one refresh token is
   not a supported OAuth pattern.
2. **Shared state through symlinks.** `native-cli-shared-state.ts` links an
   allowlist of names in each managed home to the personal home and heals
   real files left behind by a CLI (line-union for JSONL, newest-wins with
   backups for files). New CLI versions add names that silently become
   per-account until someone classifies them. "MCP servers are shared across
   Claude accounts" (`a69d6da1`) is one such classification.
3. **Which account is active, stored in several places.** The Pi registry
   row, the CLI default, the `active-cli-env-pointer.ts` file that running
   shells follow, the renderer's card state, and per-CLI defaults. "Pointer
   refreshes read the defaults inside the write serialization" (`7fde0642`)
   and "first launch keeps a managed CLI default the user chose"
   (`e75bff6b`) are reconciliation bugs between those copies.
4. **Environment and path resolution.** "Onboarding seed reads the injected
   home, not os.homedir()" (`79e3ca30`), "OAuth sign-in resolves pi-ai
   wherever the packaged app puts it" (`4cfbb804`).
5. **Deletion and identity edge cases.** "Forgetting Account 1 actually
   removes the card" (`ae9ef93f`), "cora-only rows switch and delete without
   a personal login" (`1c2d2ff5`).

### 2.2 Recommended direction

- **Stop sharing one OAuth grant between two clients.** Give the Cora half
  its own login (a second browser sign-in per account, once) and delete the
  credential mirror. That removes 793 lines and classes 1 and half of 5. If
  a single sign-in per account is a hard product requirement, make exactly
  one side the owner of the grant: the CLI half owns it and Cora reads the
  CLI's credential file read-only and asks the CLI to refresh (by running
  `claude auth status` or equivalent) instead of refreshing itself.
- **One registry file, one resolver.** A single
  `~/.codarastudio/accounts.json` listing accounts with explicit ids, both
  halves' locations, and the Active and Cora-default ids, written through one
  serialized mutation path (that part exists in `unified-accounts.ts`), and
  one pure function `envForNewPty(registry, provider)` that everything
  (pty-manager, worker launch, the shell pointer file, the renderer) calls.
  The pointer file becomes a derived artifact rewritten after every mutation,
  never a source of truth.
- **Explicit migration versioning.** `unified-account-migration.ts` and the
  legacy paths in `codara-home.ts` should record a schema version in the
  registry and run migrations forward once, with a test per version.
- **Windows parity.** The README says Windows keeps the older isolated
  behavior; either implement junctions there or say so in the UI.
- **Tests.** The account suites are extensive
  (`scripts/test-*account*.cjs`, 20 files) but the mirror's concurrency rules
  are tested with synthetic files; add a test that runs two refreshers
  against one fixture and asserts no side ever writes a stale token over a
  fresher one.

## 3. Notifications

### 3.1 The false "finished" (fixed in this pass, see above)

For terminals you open yourself, `terminal-agent-notify.ts` decides "done"
from the byte stream: working footer stops repainting for 3 s (15 s after a
stall-like frame) and the idle prompt is painted. Claude Code 2.1.257 ends the
main turn, paints the prompt, and fires `Stop` while background Agent-tool
subagents and `run_in_background` Bash tasks are still running. Teammates
(Claude's teams feature) were already handled via stream patterns
(`countTeammateEvents`); background agents were not. Hook events for these
panes were dropped in `hook-watcher.ts:785-792` before reaching anything but
the session registry.

Background **tasks** (a `Bash` call with `run_in_background: true`, or a
`Monitor`) are covered in a follow-up: the `PreToolUse` hook counts the
launch, a `Stop` with no `UserPromptSubmit` before it is the follow-up turn
Claude runs when a task reports back and drains one, and a descendant of the
pane's shell started after the launch that is still alive keeps the pane
busy (checked every 2 s, capped at an hour) so a long-lived monitor that
fires many follow-up turns cannot slip through. Windows has no process list
here, so the counter alone decides there.

### 3.2 Use the structured signals Claude Code already offers

Claude Code emits OSC 9;4 progress and OSC 21337 tab status ("Working…",
"Idle", "Waiting") when `terminalProgressBarEnabled` and
`showStatusInTerminalTab` are on, and the notifier already prefers them
(`terminal-agent-notify.ts:480-493`). Codara does not turn them on. Set them
in the managed account's `settings.json` (Codara already writes the hooks
block there) so every Studio terminal gets machine-readable busy and idle
instead of the footer heuristic.

### 3.3 Duplicate state machines

Turn state for manual panes is computed three times: main-process notifier
(`terminal-agent-notify.ts`), the renderer's 300 ms poller
(`useTerminalSession.ts:1800-2110`), and, for worker panes, run-store's
regex report with hook priority (`run-store.ts:18304`). They share the
pattern tables but not the logic, which is why each has its own set of
"stall", "stuck on working", and "flicker" fixes. Make the main-process
notifier the single source (it sees hidden panes; the renderer does not)
and have the renderer chip subscribe to `terminal-agent:state` only.

## 4. Security

Full detail in the security section of this review's source material; the
items that need a decision:

| Severity | Finding | Where |
|---|---|---|
| Critical | A paired phone can add `$HOME` itself as a workspace and then read `~/.ssh`, the remote-access private key, and Pi auth files; the same call widens the renderer fs sandbox to `$HOME`. | `remote-access/production.ts:709-716, 749, 1208-1211`; `local-policy.ts:32-35`; `fs-sandbox.ts:87-92` |
| High | Windows updates are unsigned, so electron-updater does no signature check; anyone with the bucket write key ships code to every Windows user with auto-install on quit. | `package.json` win block; `auto-updater.ts:80-81` |
| High | The root agent-socket bearer token is exported into every PTY environment, including plain user shells; root reaches all 63 RPC methods. A scoped-capability path already exists. | `pty-manager.ts:1372-1405`; `agent-socket.ts:235, 405, 542-707` |
| High | Remote `terminal.create` launches `claude --dangerously-skip-permissions` / `codex --yolo`, and a failed Codex trust setup is swallowed before spawning. | `remote-access/production.ts:3503-3514` |
| Medium | fs write/delete/rename/create IPC handlers take arbitrary paths with no sandbox check (`fs:importEntries` shows the right pattern). | `ipc.ts:1518-1522, 1604-1662` |
| Medium | `app.*` dev tools (JS evaluation in the renderer) enabled in packaged builds by a bare env var. | `agent-socket.ts:2085-2098` |
| Medium | OpenRouter key stored plaintext and returned whole to the renderer; `safeStorage` wrapper exists unused. | `storage.ts:45, 238-239, 302`; `ipc.ts:731` |
| Medium | SSH host keys: silent trust-on-first-use, `~/.ssh/known_hosts` never consulted, pin-write failures swallowed. | `remote/connections.ts:446-480, 149-167` |
| Medium | `ZDOTDIR` left pointing at the cache dir for the shell's life, so `$ZDOTDIR`-aware dotfiles write there. | `shell-init.ts:193-198` |
| Medium | PowerShell runs with `-ExecutionPolicy Bypass` for the whole session. | `shell-init.ts:163-171` |
| Medium | Unauthenticated SSE feed can trigger update checks and fetch-all-remotes at an attacker's cadence. | `auto-updater.ts:39, 176-206` |

What is already strong: sandboxed, isolated main window with a navigation
allowlist and webview hardening; every IPC handler behind a trusted-sender
gate enforced by a test; loopback socket with a 32-byte token, 0600
handshake file, body cap, constant-time compare; Noise IK remote channel
with pinned identity and approval-gated pairing; credentials only
presence-probed, never logged.

## 5. Code quality

### 5.1 Size

Five files carry a disproportionate share of the 250k lines:
`run-store.ts` 20,269, `App.tsx` 7,586, `agent-socket.ts` 5,694,
`remote-access/rpc.ts` 5,483, `shared/types.ts` 5,177, plus
`SettingsDialog.tsx` 4,871, `useTabs.ts` 4,052, `useTerminalSession.ts`
3,981, `ipc.ts` 3,718 (one 3,028-line `registerIpc` function with 120
handlers). Concrete split proposals with line ranges for `index.ts`,
`ipc.ts`, `agent-socket.ts`, `rpc.ts`, `production.ts`, and `pty-manager.ts`
are in the security section source; the pattern is the same each time:
a `gate`/`server` module plus one handler module per namespace, each
exporting `register(handle)`. `run-store.ts` needs its own plan (the
orchestration reviewer was cut off before producing one); start from its
top-level `export function` list and group by the noun each operates on
(run lifecycle, steps, worker attempts, questions, board, whiteboard, events,
hook ingestion, Pi worker bridge).

### 5.2 Error handling and logging

140 comment-only `catch {}` blocks, 124 `.catch(() => undefined)`, 79
`catch { return null/false }` in `src/main`. The worst swallow real failures
the user should see: pty kill on quit (`pty-manager.ts:2571-2574,
2723-2727`), Codex trust and Claude hook install (agents launch without the
hook contract), shell-integration staging (`shell-init.ts:86-119`), host key
pin writes. 223 `console.*` calls in `src/main` versus the persistent
`logMain` (`file-log.ts`) used in 7 files, so in packaged builds most logs
are invisible. Add `warnMain`/`errorMain` to `file-log.ts` and replace
mechanically, or adopt `electron-log`.

### 5.3 Dead and legacy code

Unreferenced exports verified by grep: `installSparkPreviewMcp`,
`installSparkPreviewMcpForGrok`, `resolveCodexMcpConfigTarget`,
`resolveGrokMcpConfigTarget` (`mcp-installer.ts`); `closeAgentTerminalsForRun`;
`parseRegOutput`, `mergePaths`; `sanitizeUserText`; `assertAllowedReadPath`;
`firstSubcommand`, `splitGitLines`; `parseExactTtyProcessList`;
`isNestedAgentEnvKey`; `readSshConfigHosts`; `validateRemoteEntryName`;
`hashCoraSendMessage`; about 25 remote-access constants exported "for tests"
with no tests; about 60 exported types with no consumer. `ts-prune` reports
98 (web) and 120 (node) unused exports; `src/shared/pane-format.ts`,
`workspace-colors.ts:158-475`, `run-questions.ts:221-331` look genuinely dead.
`src/main/orchestration/anthropic-accounts.ts` is imported only by tests.
Never-hit "legacy no-lease" branches in `remote-access/rpc.ts:1685-1689,
3717-3728, 3776-3786, 3876-3883, 4652-4774, 4865-4889`. Migration code for
`~/.Cora`, `~/.SparkAgent`, `spark-hook.py`, and legacy engine/spec/board
adoption in `agent-socket.ts:3574-3599, 4485-4510, 5336-5525` can be retired
after a release or two with a version floor.

### 5.4 Duplication

Five hand-rolled path-normalizers (`agent-socket.ts:2463, 3411`,
`agent-sync.ts:1569`, `git-worktrees.ts:410`, `pty-manager.ts:2397`); the
renderer-tab terminal bootstrap in both `agent-socket.ts:835-870` and
`production.ts:3530-3629`; replay ring buffers in `terminal-leases.ts` and
`studio-terminal-share.ts`; three near-identical account wirings in
`ipc.ts:688-700`; about 70 copies of `if (!this.services.X)
replyError("unknown-method")` in `rpc.ts`; the three account-profile modules
(Claude, Codex, Grok) at 1,000 to 1,400 lines each with the adapter pattern
only partly applied.

### 5.5 Tooling

Strict TypeScript is on (`strict`, `noUnusedLocals`, `noUnusedParameters`)
but there is no ESLint, no Prettier, no test runner (216 hand-rolled Node
scripts bundling with esbuild), no coverage, and `tsconfig.e2e.json` lacks
the unused checks. `esbuild` (172 scripts) and `playwright` (39 specs) are
imported directly but only reach `node_modules` transitively; add them to
devDependencies. `npm audit --omit=dev` reports 6 high and 7 moderate
(`mermaid`, `pdfjs-dist`, `pptx-preview`, `js-yaml`, `uuid`,
`electron-updater` chain); run `npm audit fix` and evaluate the `pdfjs-dist`
and `mermaid` majors. `scripts/test-cora-direct-mode.ts` is never run by the
registry (the glob matches `.cjs`/`.mjs` only) and
`test-remote-access-hostile.mjs` needs `--expose-gc` that the registry does
not pass.

Suggested order: `knip.json` with the real entry points (one afternoon, then
it becomes a signal), `c8` coverage over the existing registry (no code
change), ESLint with `typescript-eslint` recommended plus `react-hooks` at a
warning baseline, Prettier in one `style:` commit with
`.git-blame-ignore-revs`. Windows and Linux CI legs for `typecheck` and a
subset of suites, since `spark.ps1`, ConPTY paths, and the Linux target are
never exercised.

### 5.6 Process

Branch protection on `main` has one required review but
`required_status_checks: null` and `enforce_admins: false`, so a red CI does
not block a merge and admins can push directly; CONTRIBUTING claimed
otherwise (fixed in prose, the setting is yours). 66 of the last 200 commits
contain an em dash despite the documented rule; either add a `commit-msg`
hook or drop the rule (this pass softened it to "no new ones"). The
`.gitleaks.toml` allowlist regex `(?i)(...|EXAMPLE|placeholder|<[a-z_-]+>)`
exempts any line containing "example" or an HTML-ish tag, and the path regex
does not actually match `scripts/test-*.cjs` files; tighten both.

### 5.7 Legacy naming

About 4,450 "spark" hits. They are layered: `SPARK_*` environment variables
(60 names, a public contract with hooks, shells, MCP configs), on-disk file
names (`spark-state.json` and friends, `~/.cache/spark`), the shipped
`spark.ps1`, the preload bridge `window.spark` and 20+ `spark:` DOM events,
143 `.spark-*` CSS classes, and `Spark*` type names (`SparkCall`,
`SparkEvent`, some persisted in run JSON as field names). Rename the internal
layers (bridge, events, CSS, type names but not persisted field names) in one
mechanical commit; add `CODARA_*` aliases for the env vars and keep reading
`SPARK_*` for several releases; leave on-disk names alone until a migration
is worth it.

## 6. Documentation gaps that remain

- Screenshots or a short GIF in the README (the biggest gap for a public
  repo; nothing in the repo is a screenshot).
- A troubleshooting page: "Codara appears to be offline", SmartScreen,
  node-pty build failures, the leftover shell block from the removed
  "follow active account" feature, WebGL context loss.
- The `SPARK_*` environment contract is now listed in
  `docs/on-your-machine.md`; the hook payload shapes and the agent socket
  method list are not documented anywhere and should be generated.
- `resources/codara-studio-mcp/server.js` reports `serverInfo.version`
  `0.1.0`; read it from `package.json` at build time.
- `bug_report.md` lists claude and codex runtimes but not grok, and should
  ask for `~/.codarastudio/logs/main.log`.

## 7. Product ideas

Grounded in what the code already almost does.

1. **Agent activity as a first-class surface.** The hook stream already
   carries every tool call, subagent start and stop, and compaction for
   worker panes, and now for your own panes too. Show it: a per-pane timeline
   (tool name, file, duration) and a fleet view of every live agent on the
   machine with its state, model, cost, and time since last event. Most of
   the data exists in `run-store` events and `terminal-agent-notify`; the
   missing piece is a renderer view fed by one IPC channel.
2. **A real "is it done" model.** Combine hook events, OSC status, and
   process-tree liveness (children of the CLI process) into one busy/idle
   signal per pane, expose it to the CLI (`cora status` already lists
   activity) and to the phone. This is the generalization of the fix in this
   pass and would retire the three duplicate state machines.
3. **Performance mode.** A single toggle that unmounts hidden xterms, drops
   scrollback for worker panes, and pauses the per-chunk sniffers; plus an
   in-app "what is Codara spending CPU on" panel (per-pane bytes per second,
   hook events per second, IPC messages per second) so users can report lag
   with data.
4. **Cost and budget across accounts.** Usage meters exist per subscription;
   a per-run and per-workspace cost ledger with soft limits ("pause Cora when
   this run passes $X") and a weekly digest would make the multi-account
   feature pay off.
5. **Session handoff between machines.** Runs are files; the CLI reads them
   offline; remote access already projects them to a phone. A `cora export`
   / `cora import` of a run (transcript, board, whiteboard, worker branches)
   plus "open this run on my other laptop" via the relay is a small step from
   there.
6. **Templates and sharing for looms.** Looms are JSON graphs with triggers
   and budgets. A gallery of templates (nightly test triage, PR review on
   push, dependency bump loop) and a share link would turn automations from
   a power feature into the onboarding path.
7. **Permission tiers for remote devices.** View-only, answer questions,
   files, terminals, spend. Needed for the security findings and it doubles
   as a "let a teammate watch my run" feature.
8. **Notification digest and rules.** The unified pipeline already has kinds,
   sources, and a center; add rules ("only notify for workspace X after
   18:00", "never for verifier workers"), a quiet-hours schedule, and a
   morning digest of runs that finished overnight.
9. **Diff and review pane for worker output.** `worker-diff` exists in tests
   and the git section renders diffs; a per-worker review pane with accept,
   request changes, and "spawn a verifier on this" would close the loop that
   the board currently only tracks.
10. **Plugin surface for rosters.** The MCP server's roster mechanism is a
    natural extension point; let users add their own tools to the studio
    roster from the Capability Center without editing `server.js`.

## Sources

Reviewer reports for docs, repo hygiene, main process and security, and the
terminal output path were completed; the orchestration, renderer, CLI and
scripts, accounts, and general performance reviewers were interrupted by a
session limit before reporting, and their areas were covered by targeted
reads instead. Gaps that deserve a second pass: `run-store.ts` internals,
renderer virtualization and re-render behavior in `App.tsx` and the chat
timeline, `resources/pi-cora/*` prompt drift, and the `cli/bench` suite.
