# Rewriting Codara Studio in Rust: research and plan

Status: research only. No product code was changed. Measured on commit
`acace522` of `main`, on 21 Nov 2026. Every outside link was read on
21 Nov 2026; the date after a link is the date of the source itself.

Words used here:

- **Verified**: I read it in the source that is linked, or counted it with a
  command in this repository.
- **Secondhand**: I saw it only in another page's summary of the source.
- **Inference**: my own reasoning. No source says it. A spike should test it.

## The short answer

1. A Rust rewrite is possible. The toolkit is not the hard part. The hard
   parts are the Chromium browser that agents drive, the proof that the new
   app behaves like the old one, and a code base that grows by about 100,000
   lines a month.
2. GPUI is a toolkit like the others, not a different kind of thing. For
   this app it is the best Rust-native choice, but only through the GPUI Kit
   crates and only if two spikes pass (scrolling cost, and a Chromium view
   inside a native window on Wayland).
3. The claim "GPUI uses twice the CPU of Electron when scrolling" is not
   confirmed as written. What is confirmed: upstream GPUI rebuilds scrolled
   content every frame, and one macOS benchmark shows it using less CPU but
   about 1.8 times the energy of Electron while scrolling. A fork, GPUI
   Fast, fixes most of it. Details in part 2.3.
4. Studio will still ship a Chromium. The in-app browser calls 107 different
   DevTools protocol methods. No system webview on Linux or macOS offers
   that protocol.
5. Recommended path: **Rust core first, native shell second.** Move the main
   process to Rust under today's UI, module by module, with today's tests as
   the proof. Then build a GPUI shell on the same core. Keep Chromium as a
   helper for browser tabs. Keep Pi (Cora's runtime, TypeScript) as a child
   process.
6. Honest note: the Rust core alone, with today's UI kept, probably gives
   most of the stability and responsiveness he wants. The native shell adds
   memory, startup and feel on top. The plan has a gate between the two so
   the second half is decided with measured numbers.

---

## 1. What Studio is, measured

### 1.1 How it was counted

All counts use tracked files only (`git ls-files`), piped to `wc -l`. Channel
and method counts use `grep -rEo` on the literal strings. The exact scripts
are short and can be rerun; the patterns are quoted where it matters.

### 1.2 Size by area

| Area | Path | Files | Lines |
|---|---|--:|--:|
| Electron main process | `src/main/` | 627 | 236,155 |
| React UI | `src/renderer/` | 573 | 202,623 |
| Shared types and helpers | `src/shared/` | 107 | 28,983 |
| Preload bridge | `src/preload/` | 37 | 3,370 |
| `cora` CLI | `cli/` | 53 | 15,749 |
| Shipped resources | `resources/` | 49 | 12,700 |
| Chrome extension | `extensions/chrome/` | 26 | 5,793 |
| Firefox extension | `extensions/firefox/` | 31 | 6,015 |
| Unit suites and tools | `scripts/` | 642 | 212,733 |
| End-to-end specs | `tests/` | 182 | 47,318 |
| Docs | `docs/` | 39 | 26,984 |

Product code (`src`, `resources`, `cli`, `extensions`) is about 511,000
lines. The tests are about 260,000 lines more. The repository has 2,444
tracked files: 1,231 `.ts`, 677 `.cjs`, 275 `.tsx`.

The largest files: `src/main/orchestration/run-store.ts` (23,065 lines),
`src/renderer/src/styles.css` (11,828), `src/renderer/src/App.tsx` (9,133),
`src/main/agent-socket.ts` (8,616), `src/shared/types.ts` (6,270),
`src/main/remote-access/rpc.ts` (6,083), `src/main/ipc.ts` (4,557).

### 1.3 How fast it changes

- 2,056 commits since 28 Apr 2026. 216 of them in the last 30 days
  (`git log --since="30 days ago"`).
- In those 30 days, product code gained 102,982 lines and lost 16,011.
- Where the change went (inserted lines, last 30 days):

| Area | Inserted | Reading |
|---|--:|---|
| `scripts/` (tests and tools) | 57,604 | Tests grow with features. |
| `src/renderer/` | 37,983 | The UI is the hottest area. |
| `src/main/` outside the folders below | 24,747 | Hot. |
| `tests/e2e/` | 21,714 | Hot. |
| `extensions/` | 9,197 | The Firefox add-on landed this month. |
| `src/main/browser`, `preview*` | 5,485 | Warm. |
| `src/main/remote/` (SSH) | 3,543 | Warm. |
| `src/main/orchestration/` | 3,426 | Stable for its size (78,383 lines). |
| `src/main/remote-access/` | 20 | Frozen. |

This matters for the order of a rewrite. Stable areas can be ported once.
Hot areas are a moving target.

### 1.4 Subsystem map

| Subsystem | What it does | Where | Size | Outside dependencies | Tests |
|---|---|---|---|---|---|
| App shell | Windows, tray, menu, global shortcut, single instance, quit guard | `src/main/index.ts`, `app-exit.ts`, `quit-guard.ts`, `window-*.ts` | part of the 178 top-level files in `src/main` (80,424 lines) | Electron `BrowserWindow`, `Tray`, `Menu`, `globalShortcut`, `powerMonitor`, `powerSaveBlocker`, `dialog`, `clipboard`, `shell`, `Notification`, `screen`, `nativeImage` | `test-renderer-boot-ready`, e2e boot specs |
| IPC bridge | The only door between UI and main | `src/main/ipc.ts`, `src/preload/` | 4,557 + 3,370 lines | `ipcMain`, `ipcRenderer`, `contextBridge` | `test-ipc-gate-default`, `test-trusted-sender` |
| Terminals | PTYs, backpressure, scrollback, shell integration, agent state detection | `src/main/pty-manager.ts`, `terminal-*.ts`, `shell-*.ts`, `agent-terminal-*.ts`; `src/renderer/src/components/Terminal/`; `src/renderer/src/tabs/` | about 9,950 lines in main; 8,178 + 16,008 in the UI | `node-pty` (native), `@xterm/xterm` and 5 addons (WebGL), `@xterm/headless` in main, `resources/shell-integration/` (zsh, bash, PowerShell) | `test-terminal-agent-notify`, `test-agent-patterns`, `test-pty-*`, many e2e specs |
| Agent socket | Loopback HTTP JSON-RPC for the MCP server, the CLI and Pi | `src/main/agent-socket.ts`, `src/main/preview-tools/` | 8,616 + 2,326 lines | Node `http`, bearer token file | `test-agent-socket`, `test-preview-tools-routing` |
| MCP tool server | The `codara_*` tools agents call | `resources/codara-studio-mcp/` | 15 files, 4,315 lines | Node; `@modelcontextprotocol/sdk` | `test-codara-studio-mcp`, `test-mcp-tool-manifest` |
| In-app browser | Chromium tabs, DOM actions, trusted input, screenshots, recording, audits | `src/main/browser/` (81 files, 18,365 lines), `src/renderer/src/components/Preview/` (37 files, 9,166 lines), `src/preload/inspector-preload.ts` | about 30,000 lines | Electron `<webview>`, `webContents.debugger` (DevTools protocol), `capturePage`, `printToPDF`, `executeJavaScript`, `setWindowOpenHandler`, `sendInputEvent`; `axe-core`, `parse5`, QuickJS | `test-preview-*`, `test-browser-*`, browser e2e specs |
| Browser extensions | Drive the user's own Chrome or Firefox | `extensions/chrome/`, `extensions/firefox/`, `src/main/browser/chrome/` (14 files) | 11,808 lines of extension code | `ws`, WebCrypto, `chrome.debugger` | 19 extension test files |
| Cora (orchestration) | Runs, steps, workers, automations, looms, workflows, accounts | `src/main/orchestration/` (159 files), `resources/pi-cora/` (19 files, 6,599 lines), `resources/orchestration/` | 78,383 lines in main | Pi coding agent 1.5.2 (TypeScript), `croner`, `ajv`, QuickJS (WebAssembly), `proper-lockfile` | the largest group of unit suites (`test-step-lifecycle`, `test-loom-steps`, `test-run-*`, `test-pi-*`, ...) |
| Git, GitHub, worktrees | Status, lanes, pull requests, CI watch, worktree create, setup and cleanup | `src/main/git-*.ts`, `github-*.ts` (35 files, 16,209 lines), `agent-worktrees.ts` (4,168), `worktree-setup/` (3,711), `worktree-cleanup/` (4,785); `src/renderer/src/components/git/` (13,504) | about 42,000 lines | the `git` and `gh` programs as child processes | `test-worktrees`, `test-agent-worktrees`, `test-github-*`; TLA+ models in `verification/worktrees/` |
| Remote access (phone) | Pairing, Noise transport, relay client, RPC, terminal leases | `src/main/remote-access/` (36 files) | 18,835 lines | `@hyperswarm/secret-stream`, `sodium-native`, `udx-native`, `qrcode` | `test-remote-access`, `remote-access-e2e.mjs`, `test-remote-access-hostile.mjs` |
| SSH workspaces, machines | Remote folders, port forwards, agents in tmux, host keys | `src/main/remote/` (24 files) | 6,941 lines | `ssh2`, `ssh-config` | `test-remote-*`, `test-host-keys`, `test-machine-probe`, e2e against a real sshd in Docker |
| Session search | Index of Claude, Codex, Grok, Pi and Cora sessions | `src/main/session-search/` (6 files) | 2,867 lines | `node:sqlite`, a worker thread | `test-session-search` |
| Storage | Settings, workspaces, preferences, secrets | `src/main/storage.ts`, `preferences-store.ts`, `codara-home.ts` | part of main | JSON files, Electron `safeStorage`, browser `localStorage` | `test-fs-*`, storage suites |
| Notifications | Policy, delivery, center | `src/main/notify/` (1,855 lines), `src/renderer/src/notifications/` (2,519) | 4,374 lines | Electron `Notification`, sounds | notify suites |
| Update and release | Update feed, nightly pipeline, signing | `src/main/auto-updater.ts`, `scripts/release*.cjs`, `.github/workflows/release.yml` | small | `electron-updater`, `electron-builder`, Apple notarization, S3 | release suites |
| Diagnostics | Crash dumps, hang watchdog, export bundle | `src/main/diagnostics/` (11 files, 2,108 lines) | 2,108 lines | Electron `crashReporter` (uploads off) | diagnostics suites |
| Editor and previews | Code editor, file tree, search, PDF, Word, slides, sheets, Markdown | `src/renderer/src/components/editor-cm/`, `file-preview/`, `find/`, `Search/`, `markdown-preview/` | about 10,000 lines | CodeMirror 6 with vim mode, `pdfjs-dist`, `docx-preview`, `pptx-preview`, `read-excel-file`, `mermaid` (used in 11 files), `highlight.js`, `@vscode/ripgrep` | `test-file-preview-capabilities`, e2e |
| Chat UI | Timeline, composer, tool transcripts | `src/renderer/src/components/chat/` (44 files) | 16,220 lines | `react-markdown`, `rehype-*`, `react-virtuoso` | `test-chat-*` |
| Automations, runs, boards | Graph editors, kanban, whiteboard | `components/automations/` (12,717), `runs/` (7,221), `board/` (2,379), `whiteboard/` (2,642) | about 25,000 lines | `@xyflow/react`, `@dagrejs/dagre` | automations e2e specs |
| CLI | `cora` commands, a standalone harness, a benchmark | `cli/commands/` (3,531), `cli/lib/` (1,013), `cli/harness/` (2,828), `cli/bench/` (5,139) | 15,749 lines | Node | `test-cora-cli`, bench suites |
| Theming | 8 named themes, light and dark | `src/renderer/src/styles.css`, 34 CSS files | 21,227 lines of CSS; 357 custom properties in `styles.css` | CSS | visual checks in e2e |

Tests, counted:

- 579 unit suite files `scripts/test-*` (569 `.cjs`, 9 `.mjs`, 1 `.ts`),
  202,551 lines. 461 of them bundle TypeScript with `esbuild` at run time
  and 380 name `src/` paths. They test the TypeScript modules in process.
- 13 `smoke-*` scripts that need a real subscription.
- 169 Playwright spec files in `tests/e2e/`, 45,395 lines, 363 `test(`
  calls. 168 of them launch Electron. They use `locator(` 962 times,
  `getByRole(` 758 times, `evaluate(` 339 times, `getByTestId(` 219 times.
  The UI has 207 `data-testid` attributes.
- CI: three macOS shards plus a serial job, 30 minute limit each
  (`.github/workflows/ci.yml`), a Linux job with an e2e smoke set
  (`ci-linux.yml`), bundle budgets (`budgets.yml`), PR hygiene, gitleaks.

### 1.5 Contracts that are easy to miss

A rewrite must keep every one of these, because something outside the app
depends on it.

| Contract | Where it is defined | Who depends on it |
|---|---|---|
| IPC channels: 507 distinct channel names in the preload (455 `invoke` call sites, 53 event subscriptions, 21 `send`), 307 `handle()` names in main, 78 push channels | `src/preload/`, `src/main/ipc.ts` | The whole UI. The largest groups: `git` 43, `orchestration` 33, `fs` 33, `agents` 17, `pi-subscriptions` 16, `remote` 15, `chromeLink` 15. |
| Agent socket: 101 dotted method names in the dispatch switch plus 50 in the preview tool tables, a token file `agent-socket.json` (mode 0600), pane tokens | `src/main/agent-socket.ts`, `src/main/preview-tools/`, `agent-socket-capabilities.ts` | The MCP server, the `cora` CLI, Pi processes, `codara-pane`. |
| MCP tools: 111 `codara_*` names, four rosters chosen by `SPARK_MCP_MODE` | `resources/codara-studio-mcp/`, `docs/mcp-tools.md` | Every Claude Code, Codex, Grok and Pi session. Prompts and user habits name these tools. |
| Environment variables: 154 distinct `SPARK_*` and `CODARA_*` names | `src`, `resources`, `cli` | Shells, hooks, child CLIs. `AGENTS.md` says not to rename them without an alias and a migration. |
| Extension link, protocol 2: loopback WebSocket, ECDH P-256 pairing, AES-256-GCM frames | `src/main/browser/chrome/protocol.ts` | Published Chrome and Firefox extensions and their paired tokens. A change means a store review. |
| Phone protocol, version 1: Noise IK, length-prefixed JSON, 80 method names plus `hello` and `ping`, idempotency ledger | `src/main/remote-access/rpc.ts`, `src/shared/remote-access.ts` | The phone app (another repository) and the relay (not in this repository). |
| Session files of other tools: Claude Code `~/.claude/projects/*.jsonl`, Codex `rollout-*.jsonl`, Grok `chat_history.jsonl`, Pi session files | `src/main/session-search/transcript-parsers.ts`, `codex-rollout-tail.ts`, `pi-session-tracker.ts` | Session search, turn detection, resume. These formats belong to other vendors and change without notice. |
| Hook files: one JSON file per event in `~/.codarastudio/hooks/` | `resources/claude-hooks/codara-hook.py`, `src/main/hook-watcher.ts` | Claude Code hooks, the Codex notify program. |
| Data on disk: `spark-state.json`, `spark-settings.json`, `spark-preferences.json`, `runs/<id>/run.json` and `events.jsonl`, `scheduler.json`, `session-index/sessions.sqlite`, managed CLI homes | `docs/codebase-tour.md` part 4, `docs/on-your-machine.md` | Every user's existing install. The `cora` CLI reads run files while the app is closed. |
| UI state in the browser profile: 53 distinct `localStorage` key expressions in 32 files, including each workspace's tab layout | `src/renderer/src/tabs/useTabs.ts` and others | Lost if the Chromium profile goes away. |
| Secrets sealed by Electron `safeStorage` | `src/main/storage.ts`, `src/main/remote/secret-store.ts` | Only Electron can open them. |
| Update feed: `latest.yml`, `latest-mac.yml` at `studio.codarasolutions.com/releases/`, plus a push event stream | `src/main/auto-updater.ts`, `docs/releasing.md` | Every installed app. |
| Node inside Electron: Pi, the MCP library, the pane helper and loom steps run on the Electron binary as Node (`ELECTRON_RUN_AS_NODE`) | `src/main/orchestration/pi-runtime.ts`, `pi-runtime-electron.ts` line 490, `pane-helper.ts`, `loom-steps.ts` | Without Electron there is no bundled Node. Something must replace it. |
| Pi as a library inside main: sign-in flows, credential storage, the model catalog | `resolveCodaraPiLibrary` in `pi-runtime-electron.ts`, used by `pi-auth-storage.ts`, `pi-subscription-auth.ts`, `pi-model-catalog.ts` | A Rust core cannot import a TypeScript library. |
| DevTools protocol use: 107 distinct methods, 175 call sites, 14 domains (Page, Network, Runtime, Emulation, DOM, Debugger, Input, CSS, Tracing, HeapProfiler, IO, Storage, Performance, Log) | `src/main/browser/`, `src/main/preview-input.ts` | Every browser tool. This fixes the browser engine to Chromium. |

---

## 2. What each subsystem needs from a Rust stack

### 2.1 What GPUI is, in three sentences

GPUI is the Rust library the Zed editor team wrote to draw Zed's whole
window on the graphics card, with no browser engine inside. It is a UI
toolkit like the others below (windows, layout, text, input, events); it is
not a different kind of thing, only younger and shaped by one product. Zed
ships on it on macOS, Linux and Windows, and outside Zed it is used through
a widget kit by Longbridge (a trading app) and by a few small agent and
terminal apps such as Paneflow.

Facts about GPUI today, verified:

- **Version and licence.** The official crate `gpui` is at 0.2.2, published
  22 Oct 2025, Apache-2.0
  ([crates.io API](https://crates.io/api/v1/crates/gpui)). Zed's `main`
  still says `version = "0.2.2"` and `license = "Apache-2.0"`
  ([crates/gpui/Cargo.toml](https://github.com/zed-industries/zed/blob/main/crates/gpui/Cargo.toml)).
  So the official crate is 13 months behind the code Zed runs.
- **It is pre-1.0.** Its README says: "still pre-1.0. There will often be
  breaking changes between versions"
  ([crates/gpui/README.md](https://github.com/zed-industries/zed/blob/main/crates/gpui/README.md)).
- **Zed has split it.** The workspace now holds `gpui`, `gpui_platform`,
  `gpui_linux`, `gpui_macos`, `gpui_windows`, `gpui_wgpu`, `gpui_web`,
  `gpui_ios` and more
  ([Cargo.toml](https://github.com/zed-industries/zed/blob/main/Cargo.toml)).
  `gpui_platform` is not on crates.io (the API returns not found).
- **How people really use it outside Zed.** Through snapshot crates one
  person publishes: `gpui-pre` 0.3.13 ("snapshot of zed@125ca86", 16 Nov
  2026) and the kit on top, `gpui-kit` / `gpui-component` 0.10.0 (16 Nov
  2026, Apache-2.0). `gpui-component` 0.10.0 depends on `gpui-pre =0.3.12`
  ([crates.io dependencies](https://crates.io/api/v1/crates/gpui-component/0.10.0/dependencies)).
  The owner of `gpui-pre`, `gpui-fast` and `gpui-component` on crates.io is
  a single account
  ([owners API](https://crates.io/api/v1/crates/gpui-pre/owners)).
- **Platforms.** macOS on Metal, Windows on Direct3D 11 with DirectWrite
  text, Linux on Wayland and X11 with a wgpu renderer (README above;
  [GPUI Fast scroll layers doc](https://github.com/longbridge/gpui-fast/blob/main/docs/scroll-layers.md)).
- **Accessibility.** Zed's `gpui` depends on `accesskit` and its README
  links an Accessibility chapter (Cargo.toml and README above). GPUI Kit
  says AccessKit roles, names, states and actions are built in and tested
  ([GPUI Kit README](https://github.com/longbridge/gpui-component/blob/main/README.md)).
  How well screen readers work in practice: not verified.
- **Widget kit.** GPUI Kit lists 75+ components, a dock layout with
  draggable tabs and nested splits, virtual lists, data tables, a code
  editor ("200K lines", Tree-sitter, LSP), Markdown and HTML rendering,
  charts, headless UI tests, and a WebAssembly target (README above).
- **Webview.** `gpui-webview` 0.10.0 wraps Wry. Its README calls it
  experimental. Linux Wayland: "Not supported; run on XWayland". Windows:
  the webview covers overlays
  ([crates/webview/README.md](https://github.com/longbridge/gpui-kit/blob/main/crates/webview/README.md)).
  A pull request that adds native window composition to GPUI itself has
  been open since 9 Aug 2026
  ([zed#62379](https://github.com/zed-industries/zed/pull/62379)).
- **Zed's own widgets are not reusable.** The `terminal` and `editor`
  crates are `GPL-3.0-or-later`
  ([terminal/Cargo.toml](https://github.com/zed-industries/zed/blob/main/crates/terminal/Cargo.toml),
  [editor/Cargo.toml](https://github.com/zed-industries/zed/blob/main/crates/editor/Cargo.toml)).
  Studio is MIT (`LICENSE`).

### 2.2 The toolkits, compared for this app

"Recent downloads" is the crates.io 90 day count read on 21 Nov 2026. It
includes CI machines, so read it as rough ecosystem size.

| Toolkit | Maturity outside its home project | Linux Wayland/X11, macOS, Windows | Text input and IME | Accessibility | Terminal and editor widgets | Webview or browser embedding | Licence | How well agents write it today | React UI reused | Scroll and idle cost (published) |
|---|---|---|---|---|---|---|---|---|---|---|
| **GPUI + GPUI Kit** | Official crate stale (0.2.2, Oct 2025). Kit 0.10.0 is active, used in one commercial app. Pre-1.0. | All three. Wayland and X11 native. | Used daily in Zed. IME on Linux Wayland: not verified. | AccessKit in the core and the kit (verified in manifests). Quality not verified. | Kit: code editor, diff, Markdown, chat message parts, dock. Terminal: small crates only (`gpui-terminal` 0.1.0, 2,780 downloads). Zed's are GPL. | Experimental Wry wrapper; no Wayland. Chromium needs own work. | Apache-2.0 | Medium. 310k recent downloads for `gpui`, 598k for the kit. API renames break older examples. The kit ships agent recipes. | None. All 203k lines redone. | Yes, see 2.3. |
| **Tauri 2 + today's React UI + Rust core** | High. 2.12.7 (18 Nov 2026). | All three, on the system webview: WebKitGTK, WKWebView, WebView2. | The webview's own. | The webview's own. | xterm.js and CodeMirror keep working. | The system webview only. No DevTools protocol on WebKitGTK or WKWebView (not re-verified today). | MIT or Apache-2.0 | High. 19.6M recent downloads. | Nearly all, but the UI was only ever tested on Chromium. | No published number for this kind of app. Tauri's own docs warn that WebGL on Linux can silently fall back to software ([Linux graphics](https://v2.tauri.app/develop/debug/linux-graphics/)). |
| **Tauri 3 alpha + CEF + today's React UI** | Low today. `tauri-runtime-cef` 3.0.0-alpha.7 (6 Nov 2026). | All three, one Chromium everywhere ([runtime docs](https://v3.tauri.app/develop/webview-runtime/)). | Chromium's. | Chromium's. | As today. | Yes: CEF, with `send_dev_tools_message`. Multi-webview is behind `unstable`. | MIT or Apache-2.0 | Medium. New API, few examples. | Nearly all. | No published number. Open reports: an idle app holding one core at 100%, Linux packaging broken with CEF 154 (secondhand, GitHub issues via search). |
| **Slint** | High for its niche. 1.19.0 (16 Nov 2026), stable 1.x API. | All three. | Good (secondhand, 2025 survey). | Good on Windows Narrator (secondhand, same survey). | None for terminal or code editor. | None found. | GPLv3, or a free licence that requires showing a Slint badge, or paid ([README](https://github.com/slint-ui/slint/blob/master/README.md)). | Medium. Own `.slint` language. 1.2M recent downloads. | None. | One number: 4.23 ms per scroll frame in a commenter's test, the slowest of five (see 2.3). |
| **egui** | High as a tool UI. 0.37.0 (15 Oct 2026). | All three. | Basic. Not verified for complex input. | AccessKit ([README](https://github.com/emilk/egui/blob/main/README.md)). | Community terminal and editor crates; not verified. | None. | MIT or Apache-2.0 | High. 10.6M recent downloads, simple API. | None. | 0.55 ms per scroll frame in the same test. Immediate mode: it redraws on every change. |
| **Iced** | Medium. 0.14.0 (7 Dec 2025). Its README says "experimental software". | All three. | Added in 0.14 (release notes, secondhand). | No AccessKit upstream (secondhand; forks add it). | None upstream. | None. | MIT | Medium. 865k recent downloads. API changes between releases. | None. | 0.10 ms per scroll frame in the same test, the fastest. |
| **Dioxus, webview** | Medium. 0.7.10 stable (30 Jul 2026). | All three, on the system webview. | The webview's. | The webview's. | Web ones could run. | Same limits as Tauri 2. | MIT or Apache-2.0 | Medium to high. React-like syntax. 1.5M recent downloads. | The CSS and the structure, not the TypeScript. | No published number. |
| **Dioxus Native (Blitz)** | Low. Blitz says "beta"; Dioxus calls the renderer experimental ([Blitz README](https://github.com/DioxusLabs/blitz/blob/main/README.md)). | All three (winit). | Not verified. | AccessKit listed. | None. No JavaScript, so xterm.js, CodeMirror and Mermaid cannot run. | None. | MIT or Apache-2.0 | Medium. | Some CSS. | 0.28 ms per scroll frame in the same test. |
| **Makepad** | Low. `makepad-widgets` 1.0.0 (13 May 2025), 1.8k recent downloads. | All three and web. | Weak (secondhand, dated). | Weak (secondhand, dated). | Its own code editor in its studio; not a published widget. | None. | MIT or Apache-2.0 | Low. Own DSL, small corpus. | None. | No published number. |
| **Floem** | Low. Crate 0.2.0 from 14 Nov 2024. Its README says "still maturing". | All three. | Not verified. | Not verified. | Lapce has both, inside Lapce, not as widgets. | None. | MIT | Low. 12.8k recent downloads. | None. | No published number. |
| **Custom stack (wgpu, Vello, Parley, AccessKit), or Xilem/Masonry** | Parts are solid (Parley 4.0M recent downloads, Vello 0.12.0). Xilem calls itself "experimental" ([README](https://github.com/linebender/xilem/blob/main/README.md)). | All three (winit). | To build. | AccessKit, to wire. | To build. | To build. | MIT or Apache-2.0 | Low to medium. Everything is new code with no examples of this app class. | None. | No published number. |
| **Qt and QML, driven from Rust (cxx-qt)** | Very high for Qt. `cxx-qt` 0.10.0 (24 Aug 2026). | All three. | Very good (not re-verified today). | Very good (not re-verified today). | Exist in the Qt world; several are GPL (not re-verified today). | Yes: Qt WebEngine is Chromium and has remote debugging ([Qt docs](https://doc.qt.io/qt-6/qtwebengine-debugging.html)). Its Chromium trails upstream. | Qt: LGPLv3 or paid (not re-verified today). cxx-qt: MIT or Apache-2.0. | High for QML, medium for the Rust bridge. | None. The UI would be QML and JavaScript, not Rust. | No published number. |
| **Keep the Electron UI, rewrite only the backend in Rust** | Very high. It is today's shell. | All three, one Chromium. | As today. | As today. | As today. | As today: full DevTools protocol. | MIT | High. | All of it. | The baseline in 2.3 and part 6. |

Why the rows fall the way they do, in plain words:

- **Tauri 2, Dioxus webview**: they use the operating system's webview. On
  Linux that is WebKitGTK. Studio's UI and its 169 e2e specs have only ever
  run on Chromium, and the agent browser needs the DevTools protocol. These
  two fail the browser requirement on Linux and macOS.
- **Slint, egui, Iced, Makepad, Floem, a custom stack**: none has the dense
  IDE parts (dock, virtual lists, code editor, Markdown) in one tested kit,
  and none has a way to host Chromium. With agents writing the code,
  missing widgets are not the main cost. The cost is platform work nobody
  has tested: input methods, accessibility, focus, a foreign Chromium
  surface. GPUI has an editor-class app proving those every day.
- **Qt** is the one option that solves the browser by itself. It loses
  because the UI would be QML, the Chromium inside lags, and the look that
  `DESIGN.md` describes would be rebuilt in a toolkit with its own strong
  style.
- **Tauri 3 with CEF** is the cheapest way to leave Electron and keep the
  UI. It is alpha today.

### 2.3 The scrolling claim, checked

The claim: "GPUI is not that optimized when scrolling, it uses twice the CPU
of an Electron app."

**Where it most likely comes from.** Three public sources this autumn:

1. A Hacker News comment by the author of a competing renderer: "don't
   expect GPUI to be the fastest ... GPUI isn't that optimized", with a
   table of CPU time per scroll frame: Iced 0.10 ms, Dioxus Native 0.28 ms,
   egui 0.55 ms, GPUI 3.79 ms, Slint 4.23 ms, on a macOS virtual machine.
   No benchmark code was linked. It does not mention Electron
   ([thread](https://news.ycombinator.com/item?id=50390881), early Nov
   2026).
2. The GPUI Fast fork's own numbers. Upstream GPUI (snapshot `gpui-pre`
   0.3.7) on Linux, at up to 144 frames a second: 82 to 86% of one core
   while scrolling a sidebar or a page of components, 39% for a list of
   5,000 messages. GPUI Fast: 6 to 12%
   ([README](https://github.com/longbridge/gpui-fast/blob/main/README.md),
   autumn 2026). No Electron in this test.
3. `ghia-bench`, one mail app built nine ways and measured from outside on
   macOS (M1 Pro, 120 Hz, 5 Nov 2026). This is the only source I found
   with Electron and GPUI side by side
   ([README](https://github.com/fdarian/ghia-bench/blob/main/README.md)):

| Phase | Metric | Electron 45 | GPUI (Zed `main`) |
|---|---|--:|--:|
| Scroll, 6 s | CPU, % of one core | 51.7 | 35.4 |
| Scroll, 6 s | Energy, mJ | 1,141 | 2,010 |
| Idle, 10 s | CPU, % of one core | 1.64 | 1.24 |
| Idle, 10 s | Energy, mJ | 8.03 | 15.8 |
| Start | Window visible, ms | 507 | 339 |
| After the workload | Memory footprint, MiB | 203 | 163 |
| On disk | App bundle, MiB | 261 | 16.4 |

Older reports say the same thing with less rigour: a GPUI table app at 70
to 100% CPU while scrolling, with a Zed maintainer answering that Zed lays
out the whole app again on each frame with a few caches
([zed discussion 24260](https://github.com/zed-industries/zed/discussions/24260),
Feb 2025); and a user video of Zed against VS Code "only 7%" on macOS
([zed issue 25306](https://github.com/zed-industries/zed/issues/25306), Feb
2025).

**Verdict.**

- "Twice the CPU of Electron": **not confirmed.** In the one side-by-side
  test GPUI used less CPU than Electron while scrolling (35% against 52%).
- "Not that optimized when scrolling": **confirmed** for upstream GPUI.
- "Twice" does appear, but for **energy** on macOS: 1.8 times Electron
  while scrolling and 2 times at idle, in that one benchmark. Energy
  includes the graphics card's work. Idle energy is tiny in both cases.
- Platforms with numbers: macOS on Metal (ghia-bench) and Linux on wgpu and
  Wayland (GPUI Fast). Windows: no published number. Linux X11: no
  published number.
- GPU cost and battery: no source measures GPU load by itself, and none
  measures battery life, for any toolkit in the table. The macOS energy
  figure above is the nearest thing. For every other toolkit: no published
  number against Electron.

**Why.** Upstream GPUI builds, lays out and paints the scrolled content
again on every frame. Chromium paints content once into tiles and, while
you scroll, only moves those tiles on a separate thread. The GPUI Fast docs
say this themselves: scrolling "defeats" retained views, so the fork adds
scroll layers "the way UIKit, Flutter and Chrome do"
([scroll layers doc](https://github.com/longbridge/gpui-fast/blob/main/docs/scroll-layers.md)).

**Is it still true today?** For upstream, yes as far as I can verify: the
fork compares against snapshots of Zed `main` from this autumn and still
finds the gap, and I found no upstream change that adds scroll layers
(absence not proven). GPUI Fast is on crates.io since 6 Oct 2026 (now
0.1.17) and GPUI Kit can select it with one feature flag. Its README says
"The project remains experimental". In the kit's own gallery at 60 Hz it
cut scroll CPU by 37% on average, with 75 of 76 pages better
([story scroll CPU](https://github.com/longbridge/gpui-fast/blob/main/docs/story-scroll-cpu.md)).

**What it means here.**

- This machine has a 360 Hz display. At 360 Hz a frame has 2.8 ms.
  Upstream GPUI at 3 to 6 ms of CPU per scrolled frame would miss that and
  hold a core near 100% (inference from the numbers above, which come from
  other hardware). So on this machine the claim would feel true with
  upstream GPUI.
- If GPUI is chosen, it must be the GPUI Fast build, lists must use the
  kit's virtual lists, and terminal output must be coalesced. A GPUI
  terminal app measured 6 to 8 needless repaints a second from polling and
  got to zero after moving to events; it batches terminal wakeups for up to
  4 ms
  ([write-up](https://baeseokjae.github.io/posts/native-app-for-coding-agents-rust-gpui/),
  1 Oct 2026).
- It does not change which toolkit is recommended. It adds a hard gate:
  spike S1 in part 8 measures a long chat, a fast terminal and a large diff
  on this machine against today's app. If GPUI Fast fails that, the native
  shell is not built on GPUI.

### 2.4 Toolkit recommendation

**For a native Rust UI: GPUI through GPUI Kit, with the GPUI Fast build,
pinned and vendored.** Reasons:

1. It is the only Rust toolkit with a shipped editor-class app on all three
   systems, so text input, focus, high refresh rates and big lists are
   exercised daily.
2. The kit already has the parts Studio is made of: dock with tabs and
   splits, virtual lists, code editor, diff, Markdown, tables, chat message
   parts.
3. Apps of Studio's own kind already run on it (terminal multiplexers for
   coding agents).
4. Apache-2.0 fits an MIT project.

**For the whole product, the toolkit is the second decision.** The first is
whether to keep the React UI at all. My honest reading:

- Studio is three things: a terminal multiplexer, a Chromium that agents
  drive, and a rich document UI (chat with Markdown, diagrams, PDFs,
  graphs). Chromium is the best tool for two of the three. A native shell
  wins clearly only on the first.
- The speed, memory and stability problems of a 236,000 line Node main
  process do not need a new UI to fix. A Rust core does that under any UI.
- So "keep the UI, Rust backend" is a real answer, not a consolation. It is
  the first half of the recommended plan, and the plan lets him stop there.

**What would change my mind:**

- Spike S1 fails (scroll and stream cost): no GPUI. Keep the React UI.
- Spike S2 fails (Chromium inside a native window on Wayland, X11, macOS
  and Windows): no native shell with an embedded browser. Either keep the
  React UI, or pick Qt for its built-in Chromium.
- Tauri 3 with CEF reaches a stable release: it becomes the cheapest way to
  drop Electron while keeping the UI and the e2e suite, and should be
  compared again.
- Zed starts publishing the split GPUI crates regularly: switch to the
  official channel and drop the snapshot crates.
- The single maintainer of the snapshot crates stops: the vendored copy
  keeps Studio building, and the choice is a pin on Zed `main` or a fork.
- After the Rust core lands, measured memory and latency already meet his
  targets: skip the native shell.

### 2.5 Subsystem by subsystem

Versions and licences come from the crates.io API on 21 Nov 2026.

| Need | What Studio needs | Best current answer | Notes |
|---|---|---|---|
| Terminal emulation | A VT parser and grid for the UI, and a headless one in the core (today `@xterm/headless` reads screens for agent detection) | `alacritty_terminal` 0.26.0 (Apache-2.0, 6 Apr 2026). Zed uses a git fork of it ([Cargo.toml](https://github.com/zed-industries/zed/blob/main/Cargo.toml), line 545). Alternative: `libghostty-vt` 1.0, stable C ABI since 6 Nov 2026 (secondhand, [news](https://alternativeto.net/news/2026/11/libghostty-1-0-brings-a-stable-c-abi-for-terminals/)); Rust bindings `libghostty-vt` 0.2.2 by a third party. | Start with `alacritty_terminal` (pure Rust, no Zig toolchain). Compare both in spike S3. The terminal view itself must be written: Zed's and Paneflow's are GPL. |
| PTY | Unix PTYs and Windows ConPTY, process trees, resize, kill | `portable-pty` 0.9.0 (MIT, 11 Feb 2025) | Old release but 18M recent downloads. Studio's rules (16 ms batches, pause at 256,000 unacknowledged bytes, 4 MB tail, 16 MB backlog; `docs/architecture.md`) are app logic to port. |
| In-app browser | Tabs, full DevTools protocol, screenshots, trusted input, recording, popups, downloads, a profile | Chromium, in one of three shapes: (a) CEF through the `cef` crate 156.7.0 (19 Nov 2026, MIT or Apache-2.0, Linux, macOS and Windows on x64 and ARM64, [repo](https://github.com/tauri-apps/cef-rs)); (b) a headless Chromium child whose frames are streamed into the window and whose input goes through the protocol; (c) the user's own Chrome through the existing extension | (a) is the real answer. (b) is the fallback that avoids all window embedding. (c) already exists and stays. Spike S2 picks between (a) and (b). System webviews are out: no DevTools protocol on Linux and macOS. |
| Code editor and diff | Editing with highlighting for 7 languages plus legacy modes, search, vim mode, a virtualized review diff | GPUI Kit code editor and diff view (README in 2.1) | Vim mode: none found in the kit. Zed's is GPL. Either build it, or drop it, or keep CodeMirror inside the Chromium helper for the editor tab. |
| Markdown and chat | Streaming Markdown, code blocks, tables, Mermaid diagrams, long virtual lists, text selection across blocks | GPUI Kit Markdown and HTML rendering and virtual lists; `pulldown-cmark` 0.13.6 (MIT) | Mermaid has no native renderer that I found. Render diagrams in the Chromium helper and show the picture, or keep them out of v1. Selection across many blocks in a virtual list is a known hard spot: test it in S1. |
| File previews | PDF, Word, slides, sheets | Keep them as web pages inside the Chromium helper | The web libraries (`pdfjs-dist`, `docx-preview`, `pptx-preview`, `read-excel-file`) keep working there unchanged. |
| Graph editors | Run graphs, looms, whiteboard, kanban | Custom GPUI canvas work, or web pages in the helper | No node-graph kit for GPUI found. The helper keeps `@xyflow/react` alive until a native one is worth it. |
| Agent CLIs | Claude Code, Codex, Grok, Pi, agy in panes, with per-launch flags, hooks and turn detection | Unchanged: child processes in PTYs | The detection logic (`src/shared/agent-patterns.ts`, `terminal-agent-notify.ts`) ports to Rust with its recorded fixtures. Optional later: the Agent Client Protocol (`agent-client-protocol` 5.4.0, 18 Nov 2026, Apache-2.0) for a structured, non-terminal view of the same agents. |
| Pi and Cora | Pi is TypeScript and loads Cora's extension as TypeScript | Keep Pi as a child process on a bundled Node | Today the Electron binary is that Node. The new app must ship one (or Bun), or require the user's own. Pi's sign-in and model catalog, used as a library in main today, move behind a small Node helper. |
| Cora's engine | 78,383 lines: run store, scheduler, looms, workflows, accounts | First: move it out of the UI process as a Node child, unchanged. Later: port to Rust if numbers justify it. | It is the most stable big area (3,426 lines changed in 30 days) and has the densest tests, so a later port is safe. The workflow sandbox maps to `rquickjs` 0.14.0. |
| MCP server | Stdio server, four rosters, 111 tools | `rmcp` 3.11.0 (Apache-2.0, 17 Nov 2026, the official Rust SDK) as one static binary | Starts faster than Node for every agent launch. Pi loads today's `server.js` as a library; give Pi a generated tool list and let it call the socket directly, which it already does. |
| Agent socket | Loopback HTTP JSON-RPC, tokens, scoped capabilities | `axum` 0.8.9 on `tokio` | Same wire format, same token file, so the CLI and old MCP server keep working during the move. |
| Git and worktrees | Everything in part 1.4 | Keep calling `git` and `gh`. `gix` 0.90.0 only for hot read paths later. | The unit suites run against real throwaway repositories. Calling the same programs keeps behaviour identical. |
| Storage | The JSON files, the SQLite index, secrets | `serde_json` with the same file names and shapes; `rusqlite` 0.43.0; `keyring` 4.2.0 for secrets | `safeStorage` blobs must be opened by the last Electron build and stored again in a form Rust can read. |
| File watching and search | Recursive watchers with budgets, ripgrep search | `notify` 8.2.2; the `ignore` 0.4.34 and `grep-searcher` 0.1.17 crates, or keep shipping `rg` | |
| SSH | Connections, port forwards, known hosts rules, remote PTY | `russh` 0.65.2 (Apache-2.0, 16 Nov 2026) | `host-keys.ts`, `ssh-config-match.ts` and `ssh-tokens.ts` copy OpenSSH 9.6 behaviour in detail. Port them with their tests, do not replace them with a library's defaults. |
| Phone protocol | Noise IK and the exact framing of `@hyperswarm/secret-stream` | `snow` 0.10.0 for Noise, plus the stream framing by hand | Wire compatibility with the phone app is unknown until tested: spike S4. |
| Extension link | WebSocket, P-256 ECDH, AES-256-GCM, protocol 2 | `tokio-tungstenite` 0.30.0 and RustCrypto crates | Keep protocol 2 byte for byte, so no store review and no re-pairing. |
| Update and signing | A feed, background download, restart, rollback | No standard Rust updater exists (the write-up in 2.3 says the same). Options: Velopack (`velopack` 1.2.161, MIT), `self_update` 1.3.3, or a small own client for today's feed files | Keep today's feed and bucket. See the bridge release in part 5. |
| Packaging | DMG and zip (signed, notarized), NSIS, AppImage | `cargo-packager` 0.11.8 (27 Nov 2025) or `cargo-dist` 0.34.0; the existing Apple secrets | Windows builds are unsigned today (`README.md`). Azure Artifact Signing accepts EU organisations ([DevClass](https://www.devclass.com/security/2026/01/14/code-signing-windows-apps-may-be-easier-and-more-secure-with-new-azure-artifact-service/4079554), 14 Jan 2026). |
| Crash reporting | Local dumps, no upload by default, a hang watchdog | `crash-handler` 0.8.1 and `minidumper` 0.11.0 (MIT or Apache-2.0); `sentry` 0.49.6 only if he wants uploads | Keeps today's policy (`src/main/diagnostics/index.ts`). |
| Testing | Unit, protocol, UI, visual | Three layers, see part 5: Rust unit tests; the existing Node suites run against the core as black-box contract tests; a UI driver on the accessibility tree plus screenshots | GPUI Kit has headless UI tests that drive input and assert focus, layout and accessibility (README in 2.1). Zed has a screenshot test runner (secondhand). |
| Extension points | MCP servers, skills, workflows, hooks | Unchanged: all are files and processes outside the UI | GPUI Kit's JavaScript panel runtime (`gpui-shell`, 1,469 downloads) is too new to build on. |
| Theming | 8 themes, light and dark, 357 tokens | A theme struct generated from the CSS custom properties | The token names in `styles.css` become the single source for both shells while both exist. |
| Desktop glue | Tray, menus, notifications, global shortcut, keep-awake | `tray-icon` 0.26.1, `muda` 0.21.2, `notify-rust` 4.19.0, plus GPUI's own menus | Per-platform checks needed; none is hard. |

---

## 3. Limitations and risks

### 3.1 What a GPUI app cannot do today that Studio does

Verified from a source:

1. **Embed a browser on Wayland.** The kit's webview is not supported on
   Wayland and is experimental everywhere (2.1).
2. **Give agents the DevTools protocol through a system webview.** Wry uses
   WebKitGTK on Linux and WKWebView on macOS.
3. **Reuse Zed's terminal or editor.** GPL (2.1).
4. **Scroll cheaply in upstream form.** See 2.3.
5. **Stay on a stable API.** Pre-1.0, official crate 13 months old (2.1).

Inference, to be tested:

6. **Run the web-only parts natively**: Mermaid, PDF, Word, slides and
   sheet previews, the node-graph editors, vim mode. Each needs a native
   replacement or a web view in the Chromium helper.
7. **Isolate a graphics crash.** Chromium runs the GPU in its own process;
   a driver crash there restarts that process. A single-process native app
   dies with its GPU context. This machine is NVIDIA on Wayland, the
   combination with the most driver reports. The repository already
   carries a "graphics-card switch and its safety net"
   (`scripts/bundle-budgets.json`, pull request 196), so GPU trouble is not
   theoretical here.
8. **Be driven by Playwright.** No DOM. The e2e suite needs a new driver.
9. **Match text exactly.** Line breaking, emoji, bidi text and font
   fallback differ from Chromium. The chat and the diff will look slightly
   different.
10. **Type accents and compose keys on Linux Wayland everywhere** (chat,
    terminal, inputs). Zed proves the common case; the terminal view is
    new code.

### 3.2 What would be lost or need a different design

- **Hot reload of the UI.** Vite reloads a React change in under a second.
  A Rust UI change is a compile. Agents iterate slower per change; a first
  GPUI build takes 5 to 15 minutes (write-up in 2.3).
- **DevTools on Studio's own UI.** The `app.evaluate` debug method and
  every e2e `evaluate(` (339 uses) have no native equivalent. A debug
  socket with an accessibility tree and screenshots replaces most of it.
- **The free Node.** See 1.5. A Node (or Bun) must be shipped for Pi, or Pi
  must be the user's own install.
- **One UI code base on the web.** The React UI could in theory serve the
  phone or a browser. A GPUI UI cannot, except through the kit's
  WebAssembly target, which is unproven for this.
- **Binary size as a win.** As long as a Chromium ships for the browser
  tabs, the installer stays in the same size class, unless Chromium is
  downloaded on first use of a browser tab.

### 3.3 Licences

| Thing | Licence | Source | Consequence |
|---|---|---|---|
| Studio | MIT | `LICENSE` | Can take in MIT, BSD and Apache-2.0 code with notices (`THIRD_PARTY_NOTICES` exists). Cannot take in GPL code. |
| `gpui` | Apache-2.0 | verified, 2.1 | Fine. |
| `gpui-pre`, `gpui-fast`, `gpui-component`, `gpui-kit`, `gpui-webview` | Apache-2.0 | crates.io API | Fine. |
| Zed `terminal`, `editor` crates | GPL-3.0-or-later | verified, 2.1 | Do not copy or port. |
| Other Zed utility crates pulled in by extracted GPUI | Some reported as GPL (`zlog`, `ztracing`) | secondhand | A licence check in CI (`cargo deny`) must fail the build on any GPL crate. |
| Paneflow, muxel (the closest apps) | GPL-3.0 | [Paneflow README](https://github.com/ArthurDEV44/paneflow), write-up in 2.3 | Read for ideas only. Do not copy. |
| `alacritty_terminal` | Apache-2.0 | crates.io API | Fine. |
| `portable-pty` | MIT | crates.io API | Fine. |
| `cef` crate | MIT or Apache-2.0 | crates.io API | Fine. CEF and Chromium themselves are BSD-style with many third-party notices (not re-verified today). |
| Slint | GPLv3, or a free licence with a badge, or paid | verified, 2.2 | Adds an obligation an MIT app does not have today. |
| Qt | LGPLv3 or paid | not re-verified today | Dynamic linking and notices. |

A risk that is new with agents: a model that has read Zed's GPL terminal or
editor code may reproduce it. The guard is a rule in the brief ("write
against `alacritty_terminal`'s API, do not open Zed's `terminal` or
`editor` crates") and a similarity check in review. This is inference, not
a legal opinion.

### 3.4 Unknowns that need a spike

1. Does GPUI Fast hold the frame budget on this machine for a long chat, a
   fast terminal and a large diff? (S1)
2. Can a Chromium surface sit inside a GPUI window on Wayland, X11, macOS
   and Windows, with GPUI menus above it, and answer all 107 protocol
   methods? (S2)
3. Does a Rust VT core reach the same agent-state decisions as today's
   notifier on the recorded fixtures? (S3)
4. Can Rust speak the phone protocol and the extension link without any
   change on the other side? (S4)
5. Can an installed Electron build update itself into the new app and keep
   its data, and can Pi run without Electron? (S5)
6. How much of the main process's 475 MB is Cora's engine? One heap
   snapshot of the running app answers it. It decides whether the engine
   needs porting for memory reasons.
7. Screen reader quality of a GPUI Kit app on each system. Not verified by
   anyone I could find.

---

## 4. Strategy options

| | A. Big-bang rewrite | B. Rust core, keep the Electron UI | C. Rust core, keep the React UI, swap Electron for Tauri | D. GPUI shell first, TypeScript backend kept as a child | E. Core first, then a native shell on the same core (recommended) |
|---|---|---|---|---|---|
| What it is | A new Rust and GPUI app built beside the old one, switched over at the end | Main process logic moves to Rust module by module; the UI and Chromium stay | As B, then replace the Electron shell with Tauri 3 and CEF | A new GPUI window talks to today's Node main, run headless | B, then a GPUI shell over the same core, Chromium as a helper, Pi as a child |
| Proof of parity during the work | None until the end. The 169 e2e specs cannot run on the new app. | Continuous. Unit suites and e2e specs run unchanged on every step. | As B. With CEF, Playwright can still attach over the DevTools protocol (inference). | Weak. The UI is the part with no reusable tests. | Continuous for the core. A new UI driver for the shell, run against both shells while both exist. |
| Old app keeps shipping | Frozen, or every feature is written twice | Yes, it is the same app | Yes | Yes, but the UI team of agents is split in two | Yes |
| Moving target | Chases about 100,000 new lines a month | None: one code base | None | Chases the hottest area (38,000 UI lines a month) | Core: none. Shell: short freezes per surface. |
| Memory gain | Largest, if it lands | Main process only | Main process, plus a little from dropping Node in the shell | UI only; Node main stays | Both |
| Startup, feel | Largest | Small | Small | Large | Large, after the second half |
| Risk at the switch | All of it at once | Spread over many small steps | Alpha runtime | Two runtimes for a long time | Spread; the shell ships as a second app on the same data first |
| Can stop halfway and still be better off | No | Yes, anywhere | Yes | No | Yes: after the core, after each surface |
| Main limiter | Proof, then the size of the single switch | Merge throughput | Tauri 3 leaving alpha | Proof | Merge throughput, then the two spikes |

**Recommendation: E.** Reasons:

1. **Proof.** With agents, writing is cheap and proof is scarce. E is the
   only path where today's 579 suites and 169 specs keep proving the work
   while it happens.
2. **The order follows the measured change rate.** The backend's big
   pieces are stable (orchestration, remote access). The UI is the hottest
   area. Port stable things first and the hot thing last and fast.
3. **No data migration.** Both shells sit on one core and one
   `~/.codarastudio`. Paired phones and browsers keep working because the
   core holds the keys and speaks the same protocols.
4. **It contains B.** If the numbers after the core phase are already good
   enough, he stops, and nothing was wasted.
5. **It gives one new thing the old design could not**: terminals and
   agents that survive a UI restart or an update, because a small core host
   process owns the PTYs. Today a quit with live work has to ask first
   (`confirmQuitWithLiveWork`, `docs/codebase-tour.md`).

Why not A, in plain words: it is not that A takes long. It is that A has no
way to show it is right until the day it replaces the app, and the app it
must match will have grown by several hundred thousand lines by then.

---

## 5. A phased plan for option E, sized for agents

What limits speed, named once so each phase can point at it:

- **L1 Merge throughput.** The repository merged 216 commits in the last
  30 days. `AGENTS.md` asks for pull requests under 800 lines and fails
  them above 2,000 without a label. Porting `src/main`, `src/shared` and
  `src/preload` without Cora's engine is about 190,000 lines: at least 238
  pull requests at the cap. The UI is 202,623 lines: at least 254. So the
  pipeline, not typing, sets the pace, unless mechanical ports with a
  parity suite are allowed to be larger.
- **L2 Six builders.** At most six work packages run at once.
- **L3 Review rounds.** Every pull request gets a second-model review and
  CI. Security areas (remote access, accounts, the extension link, the
  socket tokens) need more rounds.
- **L4 CI time.** Today: three macOS shards with a 30 minute limit. Rust
  adds compile time on three systems. A separate fast lane for the Rust
  crates (Linux, cached) keeps the common case to minutes.
- **L5 Outside approvals.** Apple notarization on every release (already
  in place). A Windows signing identity (not in place today). Store review
  only if the extension or phone protocol changes, which this plan
  forbids.
- **L6 Look and feel sign-off.** `DESIGN.md` records 23 dated design
  decisions. Each native surface needs his eyes once.
- **L7 Unknowns.** The spikes in part 8.

### Phase 0. Spikes

- **Goal:** remove the five largest unknowns before any product code.
- **Parallel work:** S1 to S5 from part 8, one builder each. A sixth takes
  the heap snapshot of the main process (3.4, item 6).
- **Proof:** each spike's pass or fail line, with numbers and screenshots,
  in `docs/research/`.
- **He decides:** the answers to part 7, with the spike results in hand.
- **Limiter:** L7 only.

### Phase 1. Foundations

- **Goal:** a place for Rust in this repository, and the bridge that lets
  Rust replace TypeScript one module at a time.
- **Parallel work:**
  1. A Cargo workspace in `crates/`, pinned toolchain, vendored
     dependencies, `cargo deny` for licences, a fast CI lane.
  2. `codara-proto`: Rust types generated from `src/shared/types.ts`, with
     golden files for every file format in 1.5.
  3. The bridge: the core built as a Node native addon, loaded by today's
     main. One switch per module chooses the TypeScript or the Rust
     implementation.
  4. A parity harness: the same recorded inputs through both
     implementations, outputs compared.
  5. Build and release wiring: the addon built, signed and notarized
     inside today's nightly for macOS, Windows and Linux.
  6. Move UI state out of `localStorage` into a file the core owns (tab
     layouts first). This is a TypeScript change; it makes the later shell
     switch lossless.
- **Proof:** a nightly release that contains the addon doing nothing, on
  all three systems, with the unit and e2e suites green and the bundle
  budgets unchanged.
- **He decides:** nothing new.
- **Limiter:** L4 (first cross-platform Rust builds), L5 (notarizing a new
  native binary).

### Phase 2. The core, in waves

Each module moves in the same way: port, run both side by side under the
parity harness, ship with the switch on and the TypeScript path as a
fallback for some nightlies, then delete the TypeScript path. A module is
owned by one language at a time, never both.

- **Wave 1, the hot path:** PTY and backpressure; the headless VT and
  agent-state detection; scrollback store; file watcher; search. These are
  where a single-threaded main hurts under many agents.
- **Wave 2, the doors:** the agent socket; the MCP server as a static
  binary; the `cora` CLI commands; hooks and the pane helper as small
  native programs (today they start Python or Node per call).
- **Wave 3, stable and security-heavy:** remote access (Noise, RPC,
  leases, ledger); the extension link; SSH (connections, known hosts,
  forwards, remote PTY).
- **Wave 4, the rest of main:** git and GitHub services; worktree create,
  setup and cleanup (the TLA+ models in `verification/worktrees/` are the
  specification); storage and preferences; notifications policy; session
  search; usage scans; diagnostics.
- **Wave 5, the core host:** a small process that owns PTYs and the socket
  so terminals outlive the window. The Electron main becomes a thin shell.
- **Cora's engine** moves out of the UI process as a Node child at the
  start of wave 5, unchanged. Its port to Rust is a later, separate
  decision.
- **Parallel work:** six modules at a time within a wave. Waves 1 and 2
  can overlap. Wave 3 needs S4's result.
- **Proof per module:** its unit suites green against the Rust
  implementation; the parity harness at zero differences on recorded
  inputs; the e2e specs that touch it green; a number from the list in
  part 6 that got better or stayed equal.
- **Proof for the phase:** `scripts/measure-startup.cjs` and a new
  many-agents load script show main-process memory and event-loop stall
  time before and after.
- **He decides:** after wave 5, whether the numbers already meet his goal
  (stop here, option B), and whether Cora's engine gets ported.
- **Limiter:** L1 above all. L3 for wave 3. L5 if he wants Windows signed
  when the first native binaries ship.

### Phase 3. Native shell skeleton and the first slice

Can start when wave 1 is done, beside waves 2 to 4.

- **Goal:** a second app, "Studio Next", that opens the same workspaces on
  the same core and is good enough to live in for terminal work.
- **Parallel work:**
  1. Window, rail, workspaces, tab bar, splits and docking (GPUI Kit dock).
  2. The terminal view on `alacritty_terminal`: rendering, selection,
     search, links, scrollback, overlays, IME and compose keys.
  3. Theme tokens generated from `styles.css`, all 8 themes.
  4. The UI driver: a debug socket that exposes the accessibility tree,
     actions and screenshots, and a small client so Playwright-style specs
     can keep their shape (`getByRole` maps to roles and names;
     `getByTestId` maps to stable ids).
  5. Shortcuts, command palette, notifications toast and center.
  6. Packaging of the second app for the three systems, own update
     channel.
- **Proof:** the terminal, tab, split and rail e2e specs ported to the
  driver and green on both shells; side-by-side screenshots of every theme;
  S1's three measurements repeated on the real app.
- **He decides:** look and feel of the rail, tabs and terminal (L6).
- **Limiter:** L6, L4.

### Phase 4. The remaining surfaces

One vertical slice per surface, each with its specs ported. While a slice
is in review, that surface is frozen in React; the rest of the old UI keeps
moving.

- **Slices:** Cora chat (timeline, composer, Markdown, tool transcripts);
  Source Control, lanes and the review diff; editor, file tree and search;
  settings, accounts and onboarding; agent board, session picker,
  workspace status; automations, runs and workflows; board and whiteboard;
  usage and system activity; remote access, machines, share, feedback.
- **Web-only content** (PDF and Office previews, Mermaid, the graph
  editors, and the editor if vim mode is required) is shown through the
  Chromium helper from phase 5 until a native version is worth building.
- **Parallel work:** six slices at a time. Order by use: chat first, then
  Source Control, then the long tail.
- **Proof per slice:** its e2e specs green on both shells through the
  driver; screenshots against the React version; no regression in the S1
  numbers.
- **He decides:** each surface's look once (L6); which web-only parts are
  allowed to stay web.
- **Limiter:** L1 and L6. The hot UI (37,983 new lines a month) means a
  slice that sits in review goes stale; keep slices small and review them
  first.

### Phase 5. The browser

Runs beside phase 4 once S2 has picked the shape.

- **Goal:** browser tabs in the native shell with every `codara_preview_*`
  tool working.
- **Parallel work:** the Chromium helper (CEF or streamed headless); the
  protocol session layer ported from `src/main/browser/cdp-session.ts`;
  recorders, screenshots, trusted input; popups, downloads, dialogs; the
  element picker and review notes; the profile and its storage boundary.
- **Proof:** the existing browser unit suites and e2e specs green; a
  script that calls all 107 protocol methods on each system; the browser
  benchmark in `docs/benchmarks/` repeated with no loss.
- **He decides:** bundle Chromium or download it on first use.
- **Limiter:** L7 (this is the least-known piece), L4 (CEF builds are
  large).

### Phase 6. Switch over

- **Goal:** the native shell becomes the default; Electron becomes the
  fallback, then goes.
- **Parallel work:**
  1. **Bridge release.** The last Electron builds do three things on
     update: open every `safeStorage` secret and store it again through
     the system keychain in a form the core reads; export the in-app
     browser profile if S5 shows it can be carried; then install the new
     app in place under the same app id (`com.codara.app`).
  2. The updater in the new app, on the same feed and bucket, with
     rollback to the last Electron build for a fixed number of releases.
  3. Windows signing.
  4. Docs: `docs/architecture.md`, `docs/codebase-tour.md`,
     `docs/on-your-machine.md`, `CONTRIBUTING.md`.
- **How users move:**
  - Data, settings, sessions, runs: nothing moves. Same folder, same
    files, same core.
  - Paired browsers: nothing to do. Same link protocol, same token store,
    same ports.
  - Paired phones: nothing to do. Same identity keys, same protocol
    version.
  - Tab layouts: already in a core file since phase 1.
  - Secrets: carried by the bridge release.
  - Sign-ins inside the in-app browser: carried if S5 passes; otherwise
    he signs in again in those tabs, once.
  - Agent CLI logins and managed homes: untouched.
- **Proof:** an install of the previous public release updates to the new
  shell on macOS, Windows and Linux in a test, with data, a paired browser
  and a paired phone still working; then the same in a beta channel on his
  own machines before the default flips.
- **He decides:** the day the default flips (a release to users is his
  call), and when the Electron fallback is removed.
- **Limiter:** L5 (signing), and soak time on real use.

### Phase 7. Remove Electron

Delete `src/renderer`, `src/preload`, the Electron main, the bridge addon
and `electron-builder`. Translate the Node contract suites that are still
useful into Rust tests, or keep them as black-box tests against the core's
socket. Proof: the installer and the process list no longer contain
Electron, and the part 6 numbers are re-measured and published in this
folder.

---

## 6. Why do it, measured

### 6.1 Today's app, measured

| What | Number | How |
|---|---|---|
| First window, fresh home | 579 ms | CI Linux runner, 2 Nov 2026, recorded in `scripts/bundle-budgets.json` (`scripts/measure-startup.cjs`) |
| Workspace visible | 960 ms | same |
| Memory after 5 s idle | 640 MB resident, all app processes | same |
| Memory in real use | 14 Electron processes, 1,659 MB proportional (2,803 MB summed resident) | `/proc/<pid>/smaps_rollup` on this machine, 21 Nov 2026, a development build 4.6 hours into a working session |
| of which the main process | 475 MB | same |
| of which the UI renderer | 524 MB | same |
| of which two more renderers | 242 MB and 195 MB | same; most likely browser tabs (not checked which) |
| of which the GPU process | 72 MB | same |
| of which Node-mode children, network, audio, others | about 150 MB | same |
| The agents it was running | 3 Claude Code processes, 1,548 MB proportional, about 516 MB each | same method, a few minutes later |
| CPU while one agent streamed | 22% of one core across all Electron processes: renderer 8.3, GPU 6.6, main 6.5 | `/proc/<pid>/stat` over 10 s |
| Built code | 18 MB (`out/main` 5.6 MB, `out/renderer` 13 MB) | `du` on a local build |
| Electron runtime on Linux | 316 MB folder, 225 MB binary | `du` on `node_modules/electron/dist` |
| Linux AppImage | 352 MiB | a local build from 7 Oct 2026 |

Two things stand out. The main process alone is as heavy as the whole UI.
And on a working day the agents weigh as much as the app: three Claude Code
sessions used as much memory as all of Studio. No rewrite touches that
second half.

### 6.2 Published numbers for comparable apps

| What | Number | Source and its limits |
|---|---|---|
| Small app, window visible | GPUI 339 ms, Electron 507 ms | ghia-bench, macOS, 5 Nov 2026 (2.3). A mail list, not an IDE. |
| Small app, memory after a workload | GPUI 163 MiB, Electron 203 MiB | same. Electron's figure double counts shared pages, says the author. |
| Small app, bundle | GPUI 16.4 MiB, Electron 261 MiB | same |
| Small app, idle CPU | GPUI 1.24%, Electron 1.64% | same |
| Scroll cost | see 2.3 | |
| Zed download size | 112 MB (macOS), 119 MB (Linux), 68 MB (Windows) for v1.22.0 | secondhand, the write-up in 2.3 |
| Zed typing latency "under 10 ms" against "over 50 ms under load" for VS Code; memory "3 to 4 times lower" | vendor claim, no method given | secondhand, [zed.dev/compare/vscode](https://zed.dev/compare/vscode), updated 1 May 2026 |
| "60 to 80% less memory than equivalent Electron apps" | vendor claim | secondhand, Longbridge via the write-up in 2.3 |

The careful reading: for a small app, a GPUI build starts about a third
faster and uses 20 to 40% less memory than Electron, not ten times less.
The large gaps in marketing pages compare different products.

### 6.3 What he would gain (inference, to be replaced by spike numbers)

| Goal | After the Rust core (phase 2) | After the native shell (phase 6) |
|---|---|---|
| Memory of the app itself in real use | The 475 MB main process shrinks to the size of its buffers. Terminal backlogs (up to 16 MB per hidden pane, by design) stay. | The 524 MB UI renderer and the 72 MB GPU process are replaced by one native process. Browser tabs still cost what Chromium costs, only while they are open. |
| Responsiveness with many agents | The largest gain. PTY reading, VT parsing and agent detection leave the single JavaScript thread. | Terminal drawing leaves the browser pipeline. |
| Startup | Small. | About a third faster to first window, if the small-app numbers carry over. |
| Input latency | None in the UI. | Unknown until S1. No trustworthy published number exists. |
| Installer size | None. | Smaller only if Chromium is fetched on first use of a browser tab. Otherwise the same class as today. |
| Crash classes removed | Unhandled exceptions and long stalls in main. Native module mismatches (`node-pty`, `sodium-native` rebuilds). | Renderer out-of-memory reloads. Whole-window failures when new main code meets an old UI in development. |
| Crash classes added | A Rust panic in the core must be caught at the boundary. | A GPU driver crash takes the window with it (3.1, item 7). The core host keeps the terminals alive. |
| New ability | Agents and terminals survive a UI restart and an update. | |

### 6.4 What he gives up

- Sub-second UI hot reload, and the browser DevTools on his own UI.
- One UI language that every model writes fluently, with the largest
  ecosystem in existence, for a pre-1.0 toolkit published by snapshots.
- Chromium's text, accessibility and input stack, for one that fewer people
  have tested.
- A UI that could one day run in a browser tab or on the phone.
- For a while, two shells to keep alive.

### 6.5 Would something other than a full Rust rewrite serve the goals better?

Partly yes, and the plan is built around that.

- **Stability and speed under load** come from the core. That is Rust
  either way.
- **Memory**: about half of the app's own memory is the main process and
  half is the UI. The first half does not need a new UI.
- **The other half of memory on a working day is the agents themselves.**
  If memory on a five-agent day is the real pain, features that hibernate
  idle agents (`src/main/agent-hibernation.ts` exists) will free more
  than any toolkit.
- **A native UI** is the right call if he wants the feel of a native
  terminal app and is willing to own a Chromium helper. It is not needed
  for stability.

---

## 7. Open questions, each with my pick

1. **Which goal comes first: stability under many agents, memory, feel, or
   installer size?** My pick: stability and responsiveness first. It sets
   the order of the core waves.
2. **Is a Chromium helper acceptable inside a "full Rust" app?** My pick:
   yes, started only when a browser tab or a web-only preview opens.
3. **Cora's engine (78,383 lines): port to Rust, or keep it TypeScript next
   to Pi?** My pick: keep it as a Node child through the switch. Decide
   after the heap snapshot shows what it costs.
4. **Which GPUI channel?** My pick: GPUI Kit with the GPUI Fast feature,
   exact versions pinned, every dependency vendored in the repository.
   Revisit when Zed publishes the split crates.
5. **Feature work during the UI port: global freeze, or freeze per
   surface?** My pick: per surface, only while its slice is in review.
6. **Web-only parts (vim mode, Mermaid, PDF and Office previews, graph
   editors): rebuild natively, show through the helper, or drop?** My
   pick: show through the helper in the first native release.
7. **Terminals that survive a UI restart: in scope?** My pick: yes. It is
   the one new ability the new design gives almost for free.
8. **Windows signing: fix it during this work?** My pick: yes, before the
   first native binary ships to users, because new unsigned binaries start
   with no reputation.

---

## 8. First spikes

Each is a throwaway program outside the product code. Each ends with
numbers and a one-line verdict in this folder.

### S1. Scroll and stream cost on this machine

Build three tiny windows three ways (upstream GPUI snapshot, GPUI Fast,
and today's Electron UI as the baseline):

- a chat of 2,000 messages with Markdown and code blocks;
- a terminal receiving fast output (a large log, and a replay of a
  recorded agent session);
- a diff of 10,000 lines.

Scroll each with synthetic wheel input for 15 s; stream into the terminal
for 15 s; then sit idle for 10 s. Measure process CPU from
`/proc/<pid>/stat`, GPU load from `nvidia-smi`, frames presented, and
memory. Run on the 60 Hz and the 360 Hz display, on Wayland and on
XWayland. Also type Spanish accents with dead keys and a compose key into
the chat input and the terminal.

**Pass:** GPUI Fast uses no more CPU than today's Electron UI in all three
cases on both displays, idle CPU is under 1% of a core, no dropped frames
at 60 Hz, and accents work. **Fail:** any case worse than Electron, or the
360 Hz display holds a core above 50% while scrolling. On fail, the native
shell is not built on GPUI.

### S2. Chromium inside a native window

In a GPUI window, show a web page three ways: CEF as a child surface, CEF
rendered off screen into a texture, and a headless Chromium streamed over
the protocol. Open a GPUI menu over it. Resize, split, hide and show it.
Run the list of 107 protocol methods from `src/main/browser/` against it.
Type, scroll and drag through trusted input. On Wayland, X11, macOS and
Windows.

**Pass:** one of the three shapes works on all four, with every protocol
method answering, menus drawn above the page, and scrolling a long page at
the display's rate at 60 Hz. **Fail:** no shape works on Wayland. On fail,
browser tabs open in a separate window of the helper, or the UI stays on
Chromium.

### S3. Rust terminal core against today's notifier

Feed the recorded PTY byte streams and hook events from
`test-terminal-agent-notify`, `test-agent-patterns` and
`test-agent-background-work` through a Rust core built on
`alacritty_terminal`, and again on `libghostty-vt`. Compare every state
change with the TypeScript notifier. Measure throughput and memory per
pane with a 4 MB tail.

**Pass:** identical state changes on every fixture, and at least the
throughput of today's main process. **Fail:** any differing decision that
cannot be explained by a bug in the old code.

### S4. Speak the old protocols from Rust

Write the phone transport (Noise IK plus the stream framing) and the
extension link (protocol 2) in Rust. Run the unchanged TypeScript peers
against them: `scripts/remote-access-e2e.mjs`,
`scripts/test-remote-access-hostile.mjs` and the extension's own tests.
Use an existing identity folder and an existing paired token.

**Pass:** the existing suites are green with no change on the peer side,
and an existing pairing connects without pairing again. **Fail:** any
change needed in the phone app or the extensions.

### S5. Leave Electron without losing anything

Two checks. First: take the current public Electron build, point it at a
test feed, and let it update into a dummy native app with the same app id
on macOS, Windows and Linux. Check that `~/.codarastudio` is untouched,
that a `safeStorage` secret was carried over, and whether the in-app
browser profile can be opened by the helper. Second: run a Cora manager
turn with Pi and the `resources/pi-cora/` extension on a bundled Node,
with no Electron binary present.

**Pass:** the update lands on all three systems with data and secrets
intact, and the Pi turn completes. **Fail:** any system needs a manual
reinstall, or Pi needs Electron.

---

## Sources

All read on 21 Nov 2026.

| Source | Its date | Used for |
|---|---|---|
| [crates.io API](https://crates.io/api/v1/crates/gpui) (one call per crate named in this document) | live | versions, dates, licences, downloads, owners, dependencies |
| [zed `crates/gpui/Cargo.toml`](https://github.com/zed-industries/zed/blob/main/crates/gpui/Cargo.toml), [`README.md`](https://github.com/zed-industries/zed/blob/main/crates/gpui/README.md), [root `Cargo.toml`](https://github.com/zed-industries/zed/blob/main/Cargo.toml) | `main` today | GPUI version, licence, platforms, AccessKit, crate split, the alacritty fork |
| [zed `crates/terminal/Cargo.toml`](https://github.com/zed-industries/zed/blob/main/crates/terminal/Cargo.toml), [`crates/editor/Cargo.toml`](https://github.com/zed-industries/zed/blob/main/crates/editor/Cargo.toml) | `main` today | GPL licences |
| [GPUI Kit README](https://github.com/longbridge/gpui-component/blob/main/README.md), [webview README](https://github.com/longbridge/gpui-kit/blob/main/crates/webview/README.md) | `main` today | components, tests, webview limits |
| [GPUI Fast README](https://github.com/longbridge/gpui-fast/blob/main/README.md), [scroll layers](https://github.com/longbridge/gpui-fast/blob/main/docs/scroll-layers.md), [story scroll CPU](https://github.com/longbridge/gpui-fast/blob/main/docs/story-scroll-cpu.md) | autumn 2026 | scroll cost of upstream GPUI and of the fork |
| [ghia-bench README](https://github.com/fdarian/ghia-bench/blob/main/README.md) | 5 Nov 2026 | the only Electron against GPUI measurement found |
| [Hacker News thread 50390881](https://news.ycombinator.com/item?id=50390881) | early Nov 2026 | the "GPUI isn't that optimized" comment and its table |
| [zed discussion 24260](https://github.com/zed-industries/zed/discussions/24260), [zed issue 25306](https://github.com/zed-industries/zed/issues/25306) | Feb 2025 | older scroll reports, a maintainer's explanation |
| [zed pull request 62379](https://github.com/zed-industries/zed/pull/62379) | opened 9 Aug 2026, still open | native window composition |
| ["Building a native coding-agent GUI in Rust and GPUI"](https://baeseokjae.github.io/posts/native-app-for-coding-agents-rust-gpui/) | 1 Oct 2026 | channels, pitfalls, Paneflow's lessons, Zed download sizes (secondhand) |
| [Paneflow README](https://github.com/ArthurDEV44/paneflow) | today | the closest comparable app, its licence |
| [Zed 1.0 post](https://zed.dev/blog/zed-1-0) | 29 Apr 2026 | platforms; it gives no numbers |
| [Tauri 3 webview runtime docs](https://v3.tauri.app/develop/webview-runtime/), [Tauri Linux graphics](https://v2.tauri.app/develop/debug/linux-graphics/) | today | CEF runtime, WebKitGTK limits |
| [cef-rs](https://github.com/tauri-apps/cef-rs) | today | platforms, bundling |
| READMEs of [egui](https://github.com/emilk/egui/blob/main/README.md), [Iced](https://github.com/iced-rs/iced/blob/master/README.md), [Slint](https://github.com/slint-ui/slint/blob/master/README.md), [Dioxus](https://github.com/DioxusLabs/dioxus/blob/main/README.md), [Blitz](https://github.com/DioxusLabs/blitz/blob/main/README.md), [Floem](https://github.com/lapce/floem/blob/main/README.md), [Xilem](https://github.com/linebender/xilem/blob/main/README.md), [Makepad](https://github.com/makepad/makepad/blob/main/README.md), [cxx-qt](https://github.com/KDAB/cxx-qt/blob/main/README.md) | today | maturity statements, licences, accessibility |
| [Qt WebEngine debugging](https://doc.qt.io/qt-6/qtwebengine-debugging.html) | Qt 6 docs | remote debugging (secondhand, via search summary) |
| [DevClass on Azure Artifact Signing](https://www.devclass.com/security/2026/01/14/code-signing-windows-apps-may-be-easier-and-more-secure-with-new-azure-artifact-service/4079554) | 14 Jan 2026 | Windows signing for EU organisations (secondhand) |
| [libghostty 1.0 news](https://alternativeto.net/news/2026/11/libghostty-1-0-brings-a-stable-c-abi-for-terminals/) | Nov 2026 | stable C ABI (secondhand) |

Not verified, and marked so where used: Qt's licence terms; CEF's own
licence; which system webviews expose the DevTools protocol; the 2025
survey of Rust GUI crates (seen only in summaries); Iced and Makepad
accessibility and IME status; screen reader quality of any GPUI app; the
Tauri 3 CEF bug reports; whether Zed plans scroll layers upstream.
