# What Codara writes on your machine

Codara Studio keeps everything in one folder. It does not edit the agent
CLIs' own config or logins unless you turn on **Codara tools in other apps**,
and the few other places it writes are listed below, so you can audit them or
undo them. Paths are for macOS and Linux; on Windows `~` is your user profile
folder.

## Codara's own folder: `~/.codarastudio/`

Set `CODARA_HOME_DIR` to use another location. Older installs used `~/.Cora`,
`~/.Codara` or `~/.SparkAgent`; those are migrated on first start. Files with
a `spark-` prefix keep the product's old name for compatibility.

| Path | Contents |
|---|---|
| `spark-state.json`, `spark-settings.json`, `spark-preferences.json` | Workspaces and tabs, settings, and UI preferences. The OpenRouter key in the settings file is encrypted by the operating system (Keychain on macOS, DPAPI on Windows, libsecret or KWallet on Linux). Where no encryption is available, as on Linux without a keyring, it stays in plain text and the file is readable only by you. |
| `runs/<id>/run.json`, `runs/<id>/events.jsonl` | Every Cora run: transcript, workers, board, whiteboard, and an event journal. |
| `memory/` | Cora's memory, global and per workspace, as plain markdown you can edit. Lines Cora saves with `codara_remember` (tagged `[cora ...]`) stay until you or Cora remove them; lessons it records on its own (tagged `[auto ...]`) expire after 30 days. |
| `scheduler.json` | Armed automation triggers. They fire only while the app is open. |
| `notifications.json`, `notification-mutes.json` | The notification center's history (at most 200 rows; read rows are dropped after 7 days, any row after 30) and the sources you muted. A history file that cannot be read is kept beside it as `notifications.json.corrupt-<time>`. |
| `onboarding.json` | Where you are in the first-run guide. |
| `agent-socket.json` | The loopback address and token of the running app (mode 0600), rewritten on every start. |
| `hooks/`, `hooks/processed/` | Claude Code hook events and Codex turn-complete events, one JSON file each. Processed files are kept for a week. |
| `claude-hooks/` | A durable copy of the hook script, so the hook survives app updates. |
| `codex-hooks/` | A durable copy of the Codex notify script (`codara-codex-notify.py`), for the same reason. |
| `builtin-mcp.json` | The CLIs you switched the Codara Studio MCP server off for. |
| `integrations/` | What Codara passes to the Claude Code and Codex sessions it starts, rewritten at every start: `claude/settings.json` (the hooks, given with `--settings`), `claude/mcp-<mode>.json` (the `codara-studio` server, given with `--mcp-config`), `codex-notify.json` (your own Codex `notify`, which Codara's chains to), and `claude/args.txt`, `codex/args.txt` for the commands you type in a Codara pane. |
| `global-config-cleanup.json`, `backups/global-config-cleanup/<time>/` | The one-time removal of what earlier versions wrote into your Claude Code and Codex config: a report, and a backup of every file it changed with a `manifest.json`. |
| `pi-agent/` | Cora's Pi state: the Cora side of each account (`accounts/<id>/auth.json`), Cora's Pi sessions, the MCP bridge config of each running session and its `.status.json` connection report (no secrets), `skills/` for skills only Cora should load, and a `settings.json` holding Cora's provider retry budget (mode 0600; other keys you add there are kept). Cora never reads your own `~/.pi`. |
| `claude-cli/` | Claude Code accounts: each account's login (`accounts/<id>/login.json`, mode 0600) and the one slot every Codara terminal on a Codara account runs in (`live/home`, its `CLAUDE_CONFIG_DIR`). |
| `codex-cli/`, `grok-cli/` | One private home per Codex or Grok account (`accounts/<id>/...`), its `CODEX_HOME` or `GROK_HOME`. |
| `shell/active-cli-env` | Which account home running Studio shells should follow. |
| `spark-remote-hosts.json`, `spark-known-hosts.json`, `spark-remote-secrets.json` | SSH workspaces: saved hosts, pinned host keys, and passwords or passphrases encrypted by the operating system (if encryption is unavailable, they are not saved). |
| `remote/` | Remote access: the desktop's identity (private key mode 0600), paired devices and the mutation ledger. |
| `share/` | Share as link (mode 0700): `identity.json`, the key that signs your uploads (mode 0600, created the first time you share), and `pages.json`, the links you shared from this computer with the file name each came from. See [share-links.md](./share-links.md). |
| `logs/main.log` | The main-process log, capped at 1 MB with one rotation. |
| `logs/worktree-audit.jsonl` | One line for every worktree an agent created, removed or was refused (mode 0600): ids, paths, branches, commits and the reason, never tokens. Rotated once at 5 MB. |

## How Codara sessions get its tools

Codara passes its hooks, the `codara-studio` MCP server and the Codex notify
program on the command line of each Claude Code or Codex session it starts,
so a session started anywhere else behaves as if Codara were not installed:

- **Claude Code** gets `--settings ~/.codarastudio/integrations/claude/settings.json`
  (the hooks) and `--mcp-config=.../mcp-<mode>.json` (the server, in the
  `=` form so a prompt typed after it is not read as another config). Claude
  keeps only the last `--settings` it is given, so if you pass your own,
  yours wins and that session runs without Codara's hooks. Under
  `--strict-mcp-config`, Codara adds no server.
- **Codex** gets `-c mcp_servers.codara-studio={...}`, `-c notify=[...]` (which
  runs your own `notify` afterwards with the same payload), and
  `-c tui.notifications=true` when you left that unset. A Codex that Codara
  itself starts in a folder (a worker or an autorun) also gets that folder
  marked trusted for the session, with `-c projects=...`; your
  `config.toml` is not edited.
- **Commands you type** in a Codara pane get the same arguments: the shell
  integration defines `claude` and `codex` functions for that pane only,
  which read `integrations/<cli>/args.txt`. They are not defined if you have
  your own function of that name; an alias such as
  `claude='claude --verbose'` still goes through them in bash and zsh, but
  one that names another path (or a fish or cmd pane) runs the CLI without
  Codara's flags. Management commands (`claude mcp`, `codex login` and the
  like) run untouched.
- **Grok** has no such flags; its Codara account homes carry a copy of your
  `config.toml` with the server added.

The **Codara Studio** switch for each CLI in the Capability Center, MCP
servers, turns the server off for the sessions Codara starts.

## Files owned by other tools that Codara edits

| Path | What Codara does | How to turn it off |
|---|---|---|
| `~/.claude.json`, `~/.codex/config.toml`, and Grok's `config.toml` | Only with **Codara tools in other apps** on (Settings, Behavior; off by default): adds the `codara-studio` MCP server so sessions outside Codara can use it. Turning it off removes the entries. | Leave the setting off. |
| The MCP configs above and a project's `.mcp.json` or `.codex/config.toml` | Only when you add, edit, copy, sync or remove a server in the Capability Center. Writes are atomic, keep the file's permissions and the keys Codara does not edit. | Do not use those actions. |
| `~/.claude/settings.json`, `~/.claude.json`, `~/.codex/config.toml`, Grok's `config.toml` (once) | On the first start of a version that no longer writes them, Codara removes what earlier versions added: its hooks, its `codara-studio` entries (unless **Codara tools in other apps** is on) and its `notify`, putting your previous `notify` back. Only the entries made for this Codara home go; a Codara started with a temporary home or from a worktree build changes none of these files. Each file is backed up first, and a file you changed in the meantime is left for the next start. Settings, About shows where the backup is. | Not needed: it runs once and touches only Codara's own entries. |
| Your own CLI folders, through a Codara account's links | A Codara account's home links to your `~/.claude` (projects, sessions, skills, agents, commands, plugins, settings, history and the like), `~/.codex` (everything but the login and its caches) or `~/.grok`, so the CLI running in Codara reads and writes that shared state as it would at home. Codara does not write there on its own, and a link target that does not exist is not created. | Use your own login: new sessions then run in your own folder. |
| Your global npm packages | **Install Pi** in Settings runs `npm install -g @earendil-works/pi-coding-agent@~0.85.1` (the Pi line Codara is tested against) once, when you click it. Codara never updates or removes it. | Install Pi yourself, or not at all: until Pi is installed, Cora runs on a Pi build bundled with the app. |
| `~/.cache/spark/shell-integration/` | Staged copies of the shell integration files that Studio terminals source. | No setting yet; worker and agent panes already run without it (`SPARK_NO_SHELL_INTEGRATION=1`). |
| `~/.zshrc`, `~/.bashrc`, `~/.bash_profile` (macOS), fish `conf.d/codara-claude-follow.fish`, your PowerShell profile (Windows) | Only in the installed app, with **Use the Active Claude account in other terminals** on (Settings, Accounts; on by default): one guarded line between `# >>> codara studio claude >>>` markers, so a plain `claude` in other terminals uses the Active Claude account (see [accounts.md](./accounts.md#claude-in-other-terminals)). Only files of shells you use; a missing file is created only for your login shell. Each file is backed up to `~/.codarastudio/backups/claude-follow/` first. Files in a git repository and signed PowerShell profiles are left alone. | Turn the setting off: the lines go. The Windows uninstaller removes them too; on macOS and Linux they do nothing once the app is gone. |
| `~/.claude.json` (MCP servers and trusted folders only) | With the same setting on: MCP servers (`mcpServers`, per folder too), folder trust and `.mcp.json` approvals are kept in step both ways with the active account's copy, so what you add in either place is there in both. Other keys, `oauthAccount` above all, are never written. | Turn the setting off. |
| `~/.claude/settings.json`, `CLAUDE.md`, `keybindings.json`, `history.jsonl` (Windows only) | With the same setting on: these are shared with Codara's accounts through hard links, and when a program replaces one of them the change is copied to your file. If both changed, yours is kept and the other copy goes to Codara's backups. | Turn the setting off. |
| Your repositories' refs under `refs/codara/removed-worktrees/` | When an agent removes a merged worktree, its last commit is saved there first, named by date and workspace, so the worktree can be restored. Refs older than 30 days are deleted at the next removal. | Turn off **Let agents create and remove worktrees** in Settings, General. |
| `%APPDATA%\powershell\Community\Terminal-Icons\*.xml` (Windows only) | Deletes a cache that breaks the Terminal-Icons module inside Studio terminals. | Not configurable. |
| Git refs in your workspace repository: `refs/spark/runs/<run>` and `refs/spark/undo/<run>` | Cora snapshots the workspace before each message so **Undo message and code** can restore it. That undo asks for a second click, puts back every file changed since the message (and removes files created since), and first saves the files as they were on `refs/spark/undo/<run>`, so an undo can be reversed with `git checkout refs/spark/undo/<run> -- <path>`. Neither ref moves a branch or HEAD. | Deleting the chat removes both refs. |
| `<tmpdir>/spark-terminal-notify.log` | A diagnostic trail of agent state changes in terminals (no terminal content). | Set `SPARK_TERMINAL_NOTIFY_LOG=0`. |

Your logins are never written: not the `Claude Code-credentials` Keychain
item, `~/.claude/.credentials.json`, `oauthAccount` in `~/.claude.json`,
`~/.codex/auth.json` or Grok's `auth.json`. Codara reads only who they are
signed in as, and once, when **Use the Active Claude account in other
terminals** first takes effect, the MCP sign-ins stored next to your Claude
login, to copy the ones the active account lacks. Start Codara with `SPARK_CODEX_NOTIFY=0` to leave Codex's
`notify` out of the sessions it starts.

For Pi, Codara reads without editing: while a Pi pane runs, it lists the
session files of that folder in `~/.pi/agent/sessions/` (names and
modification times, never their contents), so the pane can come back in the
same Pi session when Codara reopens. It records the session id in
`agent-session-starts.json`. Cora itself never reads `~/.pi`.

For Codex panes, Codara also reads the session file Codex is writing
(`~/.codex/sessions/.../rollout-*.jsonl`) from its end, looking only for the
turn started, turn complete and turn aborted records, so a finished turn is
announced with Codex's own last message even without the notify program.

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
| `SPARK_AGENT_ARGS_DIR` | Where the pane's `claude` and `codex` functions find the arguments Codara adds (`~/.codarastudio/integrations`). |
| `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME` | Point the CLI at the Active Codara account's home. Not set when you use your own login. |

A Studio terminal is a terminal of its own, even when you started Codara from
another one. It does not inherit the launching terminal's name or pane
address (`TERM_PROGRAM`, `WEZTERM_PANE`, `TMUX`, `KITTY_WINDOW_ID` and the
like), so a tool that opens something "in the current pane", such as a script
calling `wezterm cli split-pane`, cannot reach the window Codara was started
from. Its `TERM` is always `xterm-256color`.

Terminals do not get the agent socket's token. Tools that call the app, such
as the Codara Studio MCP server and the `cora` CLI, read its address and
token from `agent-socket.json`. Only Cora's processes for an imported pull
request get `SPARK_AGENT_SOCKET` and `SPARK_AGENT_TOKEN`, with a token scoped
to that run, and they are not terminals.

With your own login Active, Claude Code, Codex and Grok get no home variable
from Codara and run in your own `~/.claude`, `~/.codex` and `~/.grok` (or
your own `CLAUDE_CONFIG_DIR`, `CODEX_HOME` or `GROK_HOME`, if you set one),
exactly as in any other terminal.

## Network

The app talks to `https://studio.codarasolutions.com` for update checks and a
stream that announces new releases, to the sign-in providers you use, if you
turn on remote access, to the Codara relay, and, when you share a page as a
link, to the Codara share service: only the page you chose, after you click
Share, and the list, expiry and delete calls of Settings, Shared pages. There
is no telemetry.
