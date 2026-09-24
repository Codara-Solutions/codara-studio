# Codara Studio

Codara Studio is a desktop app for working with AI coding agents. It puts
your terminals, your agent CLIs (Claude Code, Codex, Grok and Pi), a built-in
browser the agents can drive, and an orchestrating agent called **Cora** in
one window, so you can hand off work, watch it happen, and step in when an
agent needs you.

It is for developers who already use terminal coding agents and want one
place to run several of them side by side, across projects and accounts.

- **Download:** [studio.codarasolutions.com](https://studio.codarasolutions.com)
  (macOS and Windows). macOS builds are signed and notarized. Windows builds
  are not signed yet, so SmartScreen warns on first run;
  [SECURITY.md](./SECURITY.md) shows how to verify an installer. On Linux,
  build it yourself (see [Build from source](#build-from-source)).
- **Updates:** releases are cut nightly whenever something new has been
  merged, and a running app hears about a new release within seconds.
- **License:** MIT.

## What you get

- **Terminals and workspaces.** Tabs and split panes, grouped into one
  workspace per project folder, local or over SSH. Shell integration for zsh,
  bash and PowerShell lets Codara tell when a command or an agent turn starts
  and ends. Your shell startup files are never edited.
- **Agent CLIs in panes.** The **+** menu opens a Claude Code, Codex, Grok or
  Pi pane in one click. Codara notices when Claude Code, Codex or Grok
  finishes a turn or needs you, even in a background workspace.
- **Cora, the orchestrator.** Describe the work in a Cora chat. Cora plans it,
  hands pieces to Claude, Codex, Grok or Pi workers in their own panes,
  checks the results, and asks you only when it must. Every chat has a kanban
  board and a whiteboard that you and Cora both edit.
- **A browser agents can use.** A real Chromium tab that Claude Code, Codex,
  Grok and Cora drive through Codara's MCP tools: navigate, click, type, take
  screenshots, read the console and network.
- **Automations.** Reusable graphs of agent workers and plain steps (shell,
  script, HTTP, file, notification) that run on a schedule, on a git or folder
  event, or on demand, with budgets and loop limits.
- **Several accounts per CLI.** Keep more than one Claude, ChatGPT or Grok
  sign-in and switch which one is Active. For Claude Code and Codex a switch
  works like `/login` as another account, so your settings, history and MCP
  sign-ins stay put.
- **Everything else you need nearby.** A code editor, file search, git and
  GitHub pull requests, usage and cost meters, desktop notifications, a `cora`
  CLI to drive Cora from any terminal, and optional pairing with the Codara
  phone app to follow and answer from anywhere.

## Quick start

1. Install the app and open it. A first-run guide checks your tools (Git,
   Python 3, Node.js, Claude Code, Codex), connects an account, and helps you
   pick a project folder. See [Getting started](./docs/getting-started.md).
2. Open a terminal with Cmd+T (Ctrl+T on Windows and Linux) and run `claude`,
   `codex`, `grok` or `pi` as usual, or pick one from the **+** menu.
3. Click **Cora** in the tab bar and describe what you want done.
4. Ask any agent to check its work in the browser: the Codara Studio MCP
   server is added to Claude Code, Codex and Grok for you.

To connect to your agents, Codara adds its MCP server to the Claude Code,
Codex and Grok configs and a hook to `~/.claude/settings.json`. Each CLI's MCP
entry can be switched off in the Capability Center (the **MCP and skills**
button in the Cora composer). Every file Codara touches outside its own
`~/.codarastudio` folder is listed in
[docs/on-your-machine.md](./docs/on-your-machine.md).

Cora runs on the [Pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
(`@earendil-works/pi-coding-agent`, 0.85.1 or newer). Install it with
`npm install -g @earendil-works/pi-coding-agent` or with **Install Pi** in
Settings, Agents, and update it yourself whenever you like; until you do,
Cora runs on a Pi build bundled with the app. The same `pi` works in any
terminal.

## Accounts in brief

Each account is one sign-in (Claude, ChatGPT or Grok) that both Cora and the
matching terminal tool use. One account per CLI is the **Active** one.

- **Claude Code and Codex** run every account in your own `~/.claude` and
  `~/.codex`. Switching the Active account works like `/login` as another
  account: MCP sign-ins, settings, history and project trust stay, and
  terminals outside Codara see the new account too. It also works the other
  way: a `/login` or `codex login` in any terminal as an account Codara knows
  makes it the Active one within a minute.
- **Grok** keeps a private home per managed account.
- **Pi** panes use your own `~/.pi` and its own sign-ins.
- Codara is the one refresher of a Claude login: while Studio runs, it renews
  the Active login before Claude Code would, and Cora asks Codara instead of
  refreshing its own copy.

Manage accounts in Settings, Agents, or with `cora auth`. The full story is in
[docs/accounts.md](./docs/accounts.md).

## Documentation

| Page | Read it when you want to |
|---|---|
| [Getting started](./docs/getting-started.md) | Install the app and get through the first-run guide. |
| [Accounts](./docs/accounts.md) | Add accounts, switch the Active one, and understand sign-in and refresh. |
| [Shortcuts and settings](./docs/shortcuts-and-settings.md) | Look up a key binding or find which Settings tab holds an option. |
| [The `cora` CLI](./docs/cli.md) | Drive Cora and inspect runs from a terminal. |
| [MCP tools](./docs/mcp-tools.md) | See which Codara tools an agent gets and what each one does. |
| [Whiteboards and review](./docs/whiteboard-review.md) | Understand Cora's project maps and what "Cora reviewed" means. |
| [Remote access](./docs/remote-access.md) | Pair a phone and understand what a paired device can do. |
| [What Codara writes on your machine](./docs/on-your-machine.md) | Audit or undo every file and setting Codara touches. |
| [Glossary](./docs/glossary.md) | Look up a term: run, worker, loom, pass, Active account, and more. |
| [Architecture](./docs/architecture.md) | Find the code behind a behavior. |
| [Releasing](./docs/releasing.md) | Ship or recover a release (maintainers). |

`docs/harness-lab/` and `docs/benchmarks/` hold measurement records from
experiments on Cora's harness. They are evidence, not guides.

## Build from source

You need Node 22 or newer (see `.nvmrc`), a C++ toolchain for the native
modules (`node-pty`, `sodium-native`), and Python 3.8 or newer for the Claude
Code hook script.

```sh
npm install              # also rebuilds native modules for Electron
npm run dev              # hot-reloading development build
npm run typecheck        # node, web and e2e projects
npm test                 # the unit suites (scripts/test-*.{cjs,mjs})
npm test -- hook         # only suites whose name matches a regex
npm run test:e2e         # Playwright against a fresh build
npm run package:linux    # an AppImage for Linux (package:mac, package:win too)
```

Before opening a pull request, read [CONTRIBUTING.md](./CONTRIBUTING.md).
AI agents working in this repository follow [AGENTS.md](./AGENTS.md).
[docs/architecture.md](./docs/architecture.md) maps the code.

## Releases

The `Release` GitHub Actions workflow runs every night at 02:17 UTC. It tests,
builds and signs everything merged since the last `vX.Y.Z` tag, tags the built
commit, then publishes the installers and update feeds. A night with nothing
new is skipped. [docs/releasing.md](./docs/releasing.md) covers version bumps,
recovery of a failed publication, and the manual fallback.

## License

Codara Studio is open source under the [MIT License](./LICENSE), copyright
Codara Solutions. Use it, modify it, redistribute it and build on it,
commercially or otherwise; keep the copyright and permission notice with
copies of the software. Report security problems as described in
[SECURITY.md](./SECURITY.md).
