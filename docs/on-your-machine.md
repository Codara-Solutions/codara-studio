# What Codara writes on your machine

Codara Studio keeps almost everything under one folder, but it also touches a
few files that belong to the agent CLIs so that they can find the app. This
page lists all of it so you can audit or undo it. Paths are for macOS and
Linux; on Windows `~` is your user profile directory.

## Codara's own folder: `~/.codarastudio/`

Override the location with `CODARA_HOME_DIR`. Older installs used `~/.Cora`,
`~/.Codara`, or `~/.SparkAgent`; those are migrated on first start.

| Path | Contents |
|---|---|
| `spark-state.json`, `spark-settings.json`, `spark-preferences.json` | Workspaces and tabs, settings, UI preferences. The `spark-` prefix is the legacy product name kept for compatibility. |
| `runs/<id>/run.json`, `runs/<id>/events.jsonl` | Every Cora run: transcript, workers, board, whiteboard, event journal. |
| `agent-socket.json` | Loopback URL and bearer token of the running app (mode 0600). Rewritten on every start. |
| `hooks/`, `hooks/processed/` | Claude Code hook events as one JSON file each; processed files are kept a week. |
| `pi-agent/` | Cora's Pi state: Cora subscriptions (`accounts/<id>/auth.json`), memory, sessions. Your own `~/.pi` is never read by Cora. |
| `claude-cli/`, `codex-cli/` | The saved login of every Claude Code and Codex account that is not the Active one (`accounts/<id>/login.json` or `auth.json`, mode 0600), and which account's login is live in your own `~/.claude` or `~/.codex`. |
| `grok-cli/` | Managed Grok account homes (a private `GROK_HOME` each). |
| `shell/active-cli-env` | Which Grok home a running Studio shell should follow. |
| `remote/` | Remote-access identity (private key, mode 0600), paired devices, ledger. |
| `logs/main.log` | The main-process log (1 MB, one rotation). |

## Files owned by other tools that Codara edits

| Path | What Codara does | Turn it off |
|---|---|---|
| `~/.claude/settings.json` | Adds a `hooks` block that runs `codara-hook.py` for session, tool, subagent, and notification events. A durable copy of the script is placed under `~/.codarastudio` so the hook survives app updates. Dead entries left by older versions are pruned. | There is no setting for this yet: removing the entries whose command mentions `codara-hook.py` works until the next app start, which re-adds them. |
| `~/.claude.json` | Adds the `codara-studio` MCP server entry. | Capability Center, Session policy, "Auto-install Codara Studio MCP". |
| `~/.codex/config.toml` and the Grok CLI `config.toml` | Adds `[mcp_servers.codara-studio]`. | Same toggle. |
| `~/.cache/spark/shell-integration/` | Staged copies of the shell integration files sourced by Studio terminals. Your `~/.zshrc`, `~/.bashrc`, and PowerShell profile are never modified. | No user setting yet; worker and agent panes already run without it (`SPARK_NO_SHELL_INTEGRATION=1`). |
| Your Claude Code login (the `Claude Code-credentials` Keychain item on macOS, `~/.claude/.credentials.json` elsewhere) and `oauthAccount` in `~/.claude.json` | Switching the Active Claude account replaces only the account's own sign-in keys and identity, the way `/login` as another account does. MCP sign-ins, settings, history and project trust are never touched. | Keep a single account; the Active one is your own login. |
| `~/.codex/auth.json` | Switching the Active Codex account swaps this file. | Keep a single Codex account. |
| Your global npm packages | Settings' Install Pi runs `npm install -g @earendil-works/pi-coding-agent` once, when you click it. Codara never updates or removes it. | Install Pi yourself, or not at all (Cora needs it). |
| Managed Grok homes under `~/.codarastudio/grok-cli/` | Symlinks to your personal `~/.grok` state so an account switch keeps your sessions. Credentials stay private per account. | Forget the account in Settings, Agents, Accounts. |
| `%APPDATA%\powershell\Community\Terminal-Icons\*.xml` (Windows only) | Deletes a cache that breaks the module inside Studio terminals. | Not configurable. |
| `<tmpdir>/spark-terminal-notify.log` | Diagnostic trail of terminal-agent state transitions (no terminal bytes). | `SPARK_TERMINAL_NOTIFY_LOG=0`. |

## Environment variables Codara sets in its terminals

These form the contract with child CLIs and hooks; they keep the legacy
`SPARK_` prefix.

| Variable | Meaning |
|---|---|
| `SPARK_PANE_ID` | The Codara pane the process runs in; the hook script tags events with it. |
| `SPARK_AGENT_SOCKET`, `SPARK_AGENT_TOKEN` | How to reach the app's loopback JSON-RPC socket. |
| `SPARK_MCP_MODE`, `SPARK_RUN_ID`, `SPARK_NODE_ID`, `SPARK_AUTOMATION_ID` | Which MCP roster to expose and which run, node, or automation a worker belongs to. |
| `SPARK_HOME_DIR` | The Codara home for child processes (alias of `CODARA_HOME_DIR`). |
| `SPARK_TERMINAL`, `SPARK_VERSION` | Identifies a Studio terminal and the app version. |
| `SPARK_NO_SHELL_INTEGRATION`, `SPARK_USER_ZDOTDIR`, `SPARK_FOLLOW_ACTIVE_ACCOUNT` | Shell integration controls. |
| `GROK_HOME` | Points Grok at the Active managed account's private home. Claude Code and Codex get no Codara home variable: every account runs in your own `~/.claude` and `~/.codex` (or your own `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, if you set one), exactly as in any other terminal. |

## Network

The app talks to `https://studio.codarasolutions.com` for update checks and a
server-sent event stream that announces new releases, to the OAuth providers
you sign in with, and, if you enable remote access, to the Codara relay. There
is no telemetry.
