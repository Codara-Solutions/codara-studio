# What Codara writes on your machine

Codara Studio keeps almost everything in one folder, but it also touches a few
files that belong to the agent CLIs, so that they can find the app and so that
account switching works. This page lists all of it, so you can audit it or
undo it. Paths are for macOS and Linux; on Windows `~` is your user profile
folder.

## Codara's own folder: `~/.codarastudio/`

Set `CODARA_HOME_DIR` to use another location. Older installs used `~/.Cora`,
`~/.Codara` or `~/.SparkAgent`; those are migrated on first start. Files with
a `spark-` prefix keep the product's old name for compatibility.

| Path | Contents |
|---|---|
| `spark-state.json`, `spark-settings.json`, `spark-preferences.json` | Workspaces and tabs, settings, and UI preferences. The OpenRouter key in the settings file is encrypted by the operating system (Keychain on macOS, DPAPI on Windows, libsecret or KWallet on Linux). Where no encryption is available, as on Linux without a keyring, it stays in plain text and the file is readable only by you. |
| `runs/<id>/run.json`, `runs/<id>/events.jsonl` | Every Cora run: transcript, workers, board, whiteboard, and an event journal. |
| `memory/` | Cora's memory, global and per workspace, as plain markdown you can edit. |
| `scheduler.json` | Armed automation triggers. They fire only while the app is open. |
| `notifications.json` | The notification center's history. |
| `onboarding.json` | Where you are in the first-run guide. |
| `agent-socket.json` | The loopback address and token of the running app (mode 0600), rewritten on every start. |
| `hooks/`, `hooks/processed/` | Claude Code hook events, one JSON file each. Processed files are kept for a week. |
| `claude-hooks/` | A durable copy of the hook script, so the hook survives app updates. |
| `builtin-mcp.json` | The CLIs you switched the Codara Studio MCP server off for. |
| `pi-agent/` | Cora's Pi state: the Cora side of each account (`accounts/<id>/auth.json`), Cora's Pi sessions, and the MCP bridge config. Cora never reads your own `~/.pi`. |
| `claude-cli/`, `codex-cli/` | The saved logins of every Claude Code and Codex account that is not the Active one (mode 0600), and a record of which account's login is live in your `~/.claude` or `~/.codex`. |
| `grok-cli/` | One private home per managed Grok account. |
| `shell/active-cli-env` | Which Grok home running Studio shells should follow. |
| `spark-remote-hosts.json`, `spark-known-hosts.json`, `spark-remote-secrets.json` | SSH workspaces: saved hosts, pinned host keys, and passwords or passphrases encrypted by the operating system (if encryption is unavailable, they are not saved). |
| `remote/` | Remote access: the desktop's identity (private key mode 0600), paired devices and the mutation ledger. |
| `logs/main.log` | The main-process log, capped at 1 MB with one rotation. |

## Files owned by other tools that Codara edits

| Path | What Codara does | How to turn it off |
|---|---|---|
| `~/.claude/settings.json` | Adds a `hooks` block that runs `codara-hook.py` for session, tool, subagent and notification events. Every Claude Code session reads it, but the hook exits at once unless it runs in a Codara pane. Dead entries from older versions are pruned. | No setting yet. Removing the entries whose command mentions `codara-hook.py` lasts until the next app start. |
| `~/.claude.json` | Adds the `codara-studio` MCP server entry. | The Claude switch for the Codara Studio server in the Capability Center, MCP servers. |
| `~/.codex/config.toml`, and Grok's `config.toml` | Adds a `[mcp_servers.codara-studio]` section. | The Codex or Grok switch in the same place. |
| Your Claude Code login (the `Claude Code-credentials` Keychain item on macOS, `~/.claude/.credentials.json` elsewhere) and `oauthAccount` in `~/.claude.json` | Switching the Active Claude account replaces only these sign-in keys and the account identity, the way `/login` as another account does. MCP sign-ins, settings, history and project trust are never touched. While Studio runs, Codara also renews this login before it expires. | Keep a single Claude account; the Active one is then your own login. |
| `~/.codex/auth.json` | Switching the Active Codex account swaps this file. | Keep a single Codex account. |
| Managed Grok homes under `~/.codarastudio/grok-cli/` | Link your personal `~/.grok` state into each account's home so a switch keeps your sessions. Credentials stay private to each account. | Remove the account in Settings, Agents. |
| Your global npm packages | **Install Pi** in Settings runs `npm install -g @earendil-works/pi-coding-agent` once, when you click it. Codara never updates or removes it. | Install Pi yourself, or not at all: until Pi is installed, Cora runs on a Pi build bundled with the app. |
| `~/.cache/spark/shell-integration/` | Staged copies of the shell integration files that Studio terminals source. Your `~/.zshrc`, `~/.bashrc` and PowerShell profile are never modified. | No setting yet; worker and agent panes already run without it (`SPARK_NO_SHELL_INTEGRATION=1`). |
| `%APPDATA%\powershell\Community\Terminal-Icons\*.xml` (Windows only) | Deletes a cache that breaks the Terminal-Icons module inside Studio terminals. | Not configurable. |
| `<tmpdir>/spark-terminal-notify.log` | A diagnostic trail of agent state changes in terminals (no terminal content). | Set `SPARK_TERMINAL_NOTIFY_LOG=0`. |

For Pi, Codara reads without editing: while a Pi pane runs, it lists the
session files of that folder in `~/.pi/agent/sessions/` (names and
modification times, never their contents), so the pane can come back in the
same Pi session when Codara reopens. It records the session id in
`agent-session-starts.json`. Cora itself never reads `~/.pi`.

Everything about accounts is explained in [accounts.md](./accounts.md).

## Environment variables in Studio terminals

Codara sets these in the terminals it opens. They are the contract with child
CLIs, hooks and the MCP server, and keep the legacy `SPARK_` prefix.

| Variable | Meaning |
|---|---|
| `SPARK_PANE_ID`, `SPARK_AGENT_PANE_ID` | The Codara pane the process runs in. The hook script tags its events with it. |
| `SPARK_HOOK_URL`, `SPARK_HOOK_TOKEN` | Where agents in the pane report hook events. |
| `SPARK_HOME_DIR` | The Codara home, for hooks and MCP children (the same folder as `CODARA_HOME_DIR`). |
| `SPARK_MCP_MODE`, `SPARK_RUN_ID`, `SPARK_NODE_ID`, `SPARK_AUTOMATION_ID` | In worker panes: which MCP tool set to expose, and which run, node or automation the worker belongs to. |
| `SPARK_TERMINAL` | Marks a Studio terminal. |
| `SPARK_NO_SHELL_INTEGRATION`, `SPARK_USER_ZDOTDIR`, `SPARK_FOLLOW_ACTIVE_ACCOUNT` | Shell integration controls. |
| `GROK_HOME` | Points Grok at the Active managed account's home. |

Terminals do not get the agent socket's token. Tools that call the app, such
as the Codara Studio MCP server and the `cora` CLI, read its address and
token from `agent-socket.json`. Only Cora's processes for an imported pull
request get `SPARK_AGENT_SOCKET` and `SPARK_AGENT_TOKEN`, with a token scoped
to that run, and they are not terminals.

Claude Code and Codex get no Codara-specific home variable: every account runs
in your own `~/.claude` and `~/.codex` (or your own `CLAUDE_CONFIG_DIR` or
`CODEX_HOME`, if you set one), exactly as in any other terminal.

## Network

The app talks to `https://studio.codarasolutions.com` for update checks and a
stream that announces new releases, to the sign-in providers you use, and, if
you turn on remote access, to the Codara relay. There is no telemetry.
