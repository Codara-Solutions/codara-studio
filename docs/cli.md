# The `cora` CLI

`cora` is a terminal remote for Codara Studio. With it you can start and
answer Cora chats, follow a run and its workers live, read and edit a run's
board, manage accounts and automations, and let one agent hand work to Cora
from its own terminal. This page shows how to set it up and lists every
command. [cli/README.md](../cli/README.md) goes deeper on the fullscreen chat
UI, the live dashboard and the harness benchmark.

## Setup

The CLI lives in `cli/` in this repository and needs Node 22 or newer. From a
checkout:

```sh
npm link                  # once: puts `cora` on your PATH
cora help                 # the command list
npm run cora -- status    # or run it without linking
```

`cora` finds the running app through `~/.codarastudio/agent-socket.json` (the
loopback address and token the app writes on start) and talks JSON-RPC to it.
If the app is closed, commands that need it fail with a clear message.

These commands read `~/.codarastudio/runs` directly and work with the app
closed: `runs`, `run`, `log`, `agents` and `watch`.

Every command accepts `--json` for raw output and `--home DIR` to point at a
different Codara home. Wherever a command takes `<run>`, a full run id or any
unique prefix of one works.

## Common tasks

```sh
cora                                   # fullscreen Cora chat (in a TTY)
cora start "Fix the failing tests" --cwd . --wait
cora runs                              # recent runs, newest first
cora watch                             # live dashboard of the active run
cora send <run> 2                      # answer Cora's question with option 2
cora board <run>                       # the run's kanban board
```

Claude Code and Codex sessions can use `cora` to bring in Cora or a second
opinion:

```sh
cora agent spawn <run> "Audit the fix" --title "Independent audit" --runtime codex
cora agent message <run> all "Re-check the acceptance criteria"
```

## Command reference

### Sessions

| Command | What it does |
|---|---|
| `chat [run] [--cwd DIR] [--profile NAME] [--direct \| --managed]` | Opens the fullscreen chat, new or resumed. Running `cora` with no command in a terminal does the same. |
| `start <prompt> [--cwd DIR] [--profile NAME] [--direct]` | Starts a Cora run. |
| `send <run> <message \| option#> [--wait]` | Replies to Cora, or answers its question by option number. |
| `wait <run> [--timeout SECONDS]` | Blocks until the run needs you or settles. |
| `tail <run> [--all]` | Streams the run's live events. |
| `cancel <run> [reason]` | Stops a run. |

`--direct` and `--managed` override Cora's routing between its compact direct
loop and full orchestration; see [cli/README.md](../cli/README.md).

### Profiles and memory

| Command | What it does |
|---|---|
| `profile list` | Lists named Cora profiles. |
| `profile create <name> [--description TEXT] [--instructions TEXT]` | Creates a profile with its own memory. |
| `profile use <name \| id>` | Makes a profile the default for new chats. |

### Accounts

| Command | What it does |
|---|---|
| `auth list [provider]` | Lists every account, numbered. |
| `auth add <provider> [label]` | Signs in another account in your browser. |
| `auth use <provider> <# \| label \| id>` | Makes an account the Active one for Cora and its CLI together. |
| `auth login <provider> <account> [--default]` | Reconnects an expired sign-in; `--default` also makes it Active. |
| `auth rename <provider> <account> <new label>` | Renames an account. |
| `auth remove <provider> <account> [--yes]` | Removes an account after asking. |
| `auth cli list [claude \| codex \| grok]` | Lists the CLI side of each account. |
| `auth cli rename <runtime> <account> <new label>` | Renames a CLI identity. |
| `auth cli remove <runtime> <account>` | Removes a CLI identity that no account uses. |

Providers are `anthropic`, `openai-codex` and `xai` (aliases: `claude`,
`codex`, `chatgpt`, `grok`). One sign-in now serves Cora and the CLI together,
so the app refuses `auth cli add`, `auth cli login`, `auth cli use` and
`auth cli logout`, which `cora help` still lists; use `auth add`, `auth login`
and `auth use` instead. [accounts.md](./accounts.md) explains the model.

### Runs and agents

| Command | What it does |
|---|---|
| `runs` | Lists runs. Works offline. |
| `run <run>` | Shows one run: status, steps, workers. Works offline. |
| `log <run>` | Prints the conversation. Works offline. |
| `agents [run]` | Lists every worker with its status and model. Works offline. |
| `watch [run]` | A live dashboard of a run and its workers, redrawn every second. Works offline. |
| `agent spawn <run> <prompt> [--title T] [--runtime claude \| codex \| grok] [--effort E]` | Adds a worker to a run. |
| `agent message <run> <all \| task-id> <message>` | Messages one worker, or all of them. |

### Boards, whiteboards and automations

| Command | What it does |
|---|---|
| `board <run>` | Prints the run's kanban board. |
| `board <run> add <title> [--desc TEXT]` | Adds a card to the Idea lane. |
| `whiteboard <run>` | Prints the run's whiteboard. |
| `whiteboard <run> set <markdown>` | Replaces the whiteboard's content. |
| `auto list [--run RUN]` | Lists the automations of a workspace. |
| `auto run \| pause \| resume \| on \| off <automation-id> [--run RUN]` | Runs, pauses, resumes, enables or disables an automation. |

Automation commands work in the workspace of the newest run on disk, or of
the run you pass with `--run`.

### Benchmark

| Command | What it does |
|---|---|
| `bench [--split train \| holdout \| all] [--task NAME[,NAME]] [--repeat N] [--keep]` | Runs the harness benchmark through the live app and scores it 0 to 100. |
| `bench --agent hermes \| codex \| claude [--model M] [--effort E]` | Runs the same tasks through another headless agent for comparison. |
| `bench matrix --models all \| M1,M2 --output DIR [--task NAME] [--repeat N]` | Runs a model matrix with one artifact per model. |
| `bench --output FILE` | Saves a JSON artifact with every check. |
| `bench list` | Shows the suite's tasks. |
| `bench history` | Shows the score history. |

### App

| Command | What it does |
|---|---|
| `status` | Is the app running? Version and activity. |
| `read <paneId> [--lines N]` | Prints the recent output of a terminal pane. |
| `ws prune` | Removes workspaces whose folder no longer exists. |
| `rpc <method> [params-json]` | Calls any socket method directly. |

The `app.*` methods reachable through `cora rpc` (screenshots, in-page
evaluation) are for development: they are available in unpackaged builds,
and in packaged builds only when the app was started with
`CODARA_DEV_TOOLS=1`.
