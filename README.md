# Codara Studio

Codara Studio is a desktop control surface for AI coding agents. It is an
Electron app that combines a terminal multiplexer, a built-in orchestrating
agent called Cora, a Chromium preview that agents can drive, and the account
plumbing needed to run several Claude Code, Codex, and Grok identities side by
side. One window where your agents work, ask questions, and ship, while you
watch.

**Download:** [studio.codarasolutions.com](https://studio.codarasolutions.com).
macOS builds are signed and notarized. Windows builds are currently unsigned;
see [SECURITY.md](./SECURITY.md) for how to verify one. Linux is build from
source only. The app self-updates: every push to `main` becomes a release and
running apps hear about it within seconds.

Codara Studio is MIT licensed. Contributions land through pull requests
([CONTRIBUTING.md](./CONTRIBUTING.md)); vulnerabilities go through
[SECURITY.md](./SECURITY.md); conventions for AI agents working in this repo
live in [AGENTS.md](./AGENTS.md).

## What it does

- **Terminals and workspaces.** Split panes, tabs, and workspaces per project
  folder (local or over SSH), with shell integration for zsh, bash, and
  PowerShell. Every terminal Codara opens knows which agent account it should
  sign in as.
- **Cora.** A built-in orchestrator that plans work, spawns Claude, Codex, Grok,
  or Pi workers in their own panes, keeps a kanban board and a whiteboard per
  conversation, and asks you only when it has to. Cora runs on the bundled Pi
  coding-agent runtime with a Codara extension.
- **Runs, boards, and whiteboards.** Every Cora conversation is a run with a
  live graph of workers, a task board, and a canvas, all persisted on disk and
  readable with the app closed.
- **Preview.** A real Chromium `<webview>` tab that any Claude Code or Codex
  session can drive through the bundled MCP server: navigate, click, type,
  screenshot, read console and network. No Playwright, no headless browser.
- **Automations.** Looms (node graphs of workers and deterministic steps) that
  run on a schedule, on a git trigger, or on demand, with budgets and
  iteration loops.
- **Accounts.** Several Claude, Codex, and Grok logins on one machine, each in
  its own private login directory, sharing your chat history and settings.
- **Run terminal lifecycle.** Worker panes belong to their run: Temporary
  worker panes close automatically when a run settles, Service panes remain
  until their run is deleted, and failed closes retry automatically.
- **Notifications and remote access.** Codara tells you when an agent finishes
  or needs you, across terminals you typed into yourself and Cora runs, and
  can pair with a phone to watch and answer from anywhere.

See [docs/glossary.md](./docs/glossary.md) for the vocabulary (run, step,
worker, wave, loom, pass, board, whiteboard, workspace, dock) and
[docs/architecture.md](./docs/architecture.md) for how the pieces fit.

## Quick start

1. Install the app, open it, and add a workspace (a project folder).
2. Open a terminal tab and run `claude` or `codex` as usual, or start a Cora
   chat from the composer and describe the work.
3. In Settings, Agents tab, add the accounts you want Studio terminals to use.
4. Ask an agent to open the Preview: the `codara_preview_*` tools are installed
   into Claude Code, Codex, and Grok automatically (see below).

## Agent integration

Codara ships one MCP server (`resources/codara-studio-mcp/server.js`) with
four tool rosters selected by `SPARK_MCP_MODE`: `studio` for terminals you run
yourself, and `worker`, `execute`, and `automation` for orchestrated runs. The
full tool table is in [docs/mcp-tools.md](./docs/mcp-tools.md).

The studio roster is auto-installed into `~/.claude.json`,
`~/.codex/config.toml`, and the Grok CLI's `config.toml` when those binaries
are found on disk. Toggle it in the Capability Center (the "MCP and skills"
button in the Cora composer) under Session policy, "Auto-install Codara Studio
MCP"; the setting key is `playwrightMcpAutoInstall`.

The server proxies each call to the running app over a loopback HTTP JSON-RPC
socket with a bearer token, described by `~/.codarastudio/agent-socket.json`.
If the app is closed, tools return a clean "Codara appears to be offline"
error instead of hanging.

Using the Preview from an agent:

1. Call `codara_preview_navigate({ url })` first. It creates the preview tab if
   none is open. Later calls default to the active preview tab; pass `tabId`
   to target a specific one, and `codara_preview_list` enumerates them.
2. `codara_preview_screenshot` returns the PNG as an inline image block, so the
   agent can look at the rendered UI.
3. `codara_preview_run` executes an ordered batch of steps in one round trip.
   Prefer it for multi-step flows.

Codara also installs a Claude Code hook into `~/.claude/settings.json` that
reports session, tool, and subagent events back to the app, which is how
worker panes show live state and how "finished" notifications avoid firing
while background agents are still running. Everything Codara writes outside
its own folder is listed in
[docs/on-your-machine.md](./docs/on-your-machine.md).

## The `cora` CLI

`cli/cora.cjs` is a terminal remote for the running app. It discovers the app
the same way the MCP server does. Run inspection commands work with the app
closed because they read `~/.codarastudio/runs` directly. The fullscreen
`cora chat` UI uses the bundled pi-tui package; every other command is
standard library only.

```sh
npm link                 # once, gives you a global `cora`
cora status              # is the app up? version, subscriptions, activity
cora chat                # fullscreen Cora chat (the TTY default)
cora runs                # list runs straight off disk
cora watch <run>         # live dashboard of a run and its subagents
cora board <run>         # the run's kanban board
cora auth list           # Cora subscriptions and native CLI identities
cora bench               # the harness benchmark (see cli/README.md)
cora rpc preview.list    # raw JSON-RPC escape hatch
```

Claude and Codex terminals can use it as an agent-to-agent bridge:

```sh
cora start "Fix the failing tests" --cwd . --wait
cora agent spawn <run> "Audit the fix" --title "Independent audit" --runtime codex
cora agent message <run> all "Re-check the acceptance criteria"
```

`cora help` lists everything; [docs/cli.md](./docs/cli.md) has the command
reference and [cli/README.md](./cli/README.md) covers the chat UI and the
benchmark. The `app.*` RPC namespace (screenshots, in-page evaluation) is
dev-gated: available in unpackaged builds, and in packaged builds only when
the app is launched with `CODARA_DEV_TOOLS=1`.

## Accounts

An account has two halves: a Cora half (an OAuth subscription the bundled Pi
runtime uses) and a CLI half (a private login directory for Claude Code,
Codex, or Grok). Add and manage them in Settings, Agents tab, Accounts, or
with `cora auth`.

One account per CLI is the Active one. Every terminal Codara opens uses it:
agent panes resolve it at spawn, and a plain Studio shell gets it in its
environment, so a `claude` or `codex` you type yourself signs in as the Active
account. Terminals already open keep the account they started with, and your
own terminals outside Codara are untouched. Codara never edits your shell
startup files.

Switching the Active account behaves like logging out and back in on one
home: chats, the `/resume` list, history, and settings all stay, because every
managed account shares those state surfaces with your personal `~/.claude` and
`~/.codex` through links while credentials and identity stay private to each
account. On Windows, managed accounts keep the older fully isolated behavior.

Codara does not refresh tokens itself, but it does mirror the OAuth credential
between an account's two halves so both stay signed in. The design and its
known rough edges are described in
[docs/architecture.md](./docs/architecture.md#accounts).

```sh
cora auth list                         # every Cora and native CLI account
cora auth add anthropic "Work Claude"  # add a Cora subscription in-browser
cora auth use anthropic "Work Claude"  # default for future Cora chats
cora auth cli list claude              # Claude Code terminal identities
cora auth cli add claude "Work CLI"    # sign in in a guarded Studio terminal
cora auth cli use claude "Work CLI"    # Active account for new terminals
```

## Keyboard shortcuts and settings

The most used defaults (Cmd on macOS, Ctrl elsewhere): Cmd+K switch Cora run,
Cmd+L focus the composer, Cmd+T new terminal tab, Cmd+D split right,
Cmd+Shift+D split down, Cmd+P quick open, Cmd+E new browser tab, Cmd+B toggle
the sidebar, Ctrl+` toggle the terminal, Cmd+M cycle model, Cmd+N cycle
thinking effort, Cmd+Shift+/ show the cheat sheet. Everything is rebindable in
Settings, Keybindings. The full table and the settings tabs are in
[docs/shortcuts-and-settings.md](./docs/shortcuts-and-settings.md).

## Developing

Prerequisites: Node 22 or newer (`.nvmrc`), a C++ toolchain for the native
modules (`node-pty`, `sodium-native`), and Python 3.8 or newer for the Claude
Code hook script. `npm install` rebuilds the native modules for Electron and
patches the bundled Pi OAuth page.

```sh
npm install
npm run dev          # hot-reloading Electron dev build
npm run typecheck    # node, web, and e2e projects
npm test             # the unit registry (scripts/test-*.{cjs,mjs})
npm test -- hook     # only suites whose name matches a regex
npm run test:e2e     # Playwright against the built app
```

Repository layout:

- `src/main/` Electron main process: windows, IPC, terminals, the agent
  socket, notifications, remote access, and `orchestration/` (Cora, runs,
  workers, automations, accounts).
- `src/preload/` the `window.spark` bridge exposed to the renderer.
- `src/renderer/` the React UI.
- `src/shared/` types and catalogs used by both sides.
- `resources/` shipped alongside the app: the MCP server, the Claude hook,
  the Pi extension that makes Cora, shell integration, orchestration prompts.
- `cli/` the `cora` CLI. `scripts/` build, release, and unit test scripts.
  `tests/e2e/` Playwright specs.

## Releasing

A push to `main` is a release. The GitHub Actions `Release` workflow runs the
typechecks and the full unit registry, derives the next version from the
conventional commits since the last `vX.Y.Z` tag (a breaking change bumps the
major, `feat:` the minor, anything else the patch), builds and signs macOS,
cross-builds the Windows installer, uploads both to the release bucket, and
pushes the tag. The tracked `package.json` version is not bumped by CI; tags
are the source of truth. `npm run release:mac|win|all` is the manual fallback
that builds from a pristine worktree and needs the untracked `.env.releases`.
Details in [docs/releasing.md](./docs/releasing.md).

## License

Codara Studio is open source under the [MIT License](./LICENSE), copyright
Codara Solutions. Use it, modify it, redistribute it, build on it, commercially
or otherwise; keep the copyright and permission notice with copies of the
software.
