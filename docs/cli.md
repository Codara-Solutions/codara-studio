# The `cora` CLI

`cora` is two things. On its own it is a coding agent in your terminal, built on
Pi, with no Codara Studio app and no Electron. `cora studio` is a remote for a
running Studio: start and answer Cora chats, follow a run and its workers live,
read and edit a run's board, manage accounts and automations, and let one agent
hand work to Cora from its own terminal. This page covers both. Agents in Studio's
panes call `cora tool`, `task`, `inbox`, `inspect`, `server` and `workflow` by those
names, so these six work with or without `studio` in front. Every other Studio
command needs it: `cora auth list` stops and says so, with no model call. The same
goes for a command after options, such as `cora --json task list`: options go after
the command. To send such words as a prompt, quote them (`cora "auth list"`), use
`cora exec`, or put `--` first.
[cli/README.md](../cli/README.md) goes deeper on the fullscreen chat UI, the live
dashboard and the harness benchmark.

## The standalone agent

It needs Node 22.18 or newer. It runs from a clone of this repository, so keep the
folder: `npm install -g .` links to it. Run `npm ci` first, because linking a folder
does not install its dependencies.

```sh
git clone --depth 1 https://github.com/Codara-Solutions/codara-studio
cd codara-studio/cli
npm ci
npm install -g .
cora login
```

| Command | What it does |
|---|---|
| `cora` | Interactive session in this folder, in Pi's terminal interface. |
| `cora exec "prompt"` | One-shot run. The prompt can also come from stdin, at any size. |
| `cora exec --json "prompt"` | One JSON event per line, ending with a `cora_result` line. |
| `cora resume [id]`, `--resume [id]` | Continue a session with its full tool history, from any folder. Any unique start of the id works. |
| `cora login [claude\|chatgpt]` | Sign in, or list what is signed in. |
| `cora models [search]` | List the models you can use. |

`--model` takes `sonnet`, `opus`, `fable`, `terra`, `sol`, `astra` or any
`provider/id`. `--effort` takes `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or
`max`.

### Models

A name like `sonnet` means the newest model of that family your account offers, so
a new model needs no upgrade. `cora` asks each provider what the account offers and
keeps the answer for six hours in `~/.cora/catalog.json`. `cora models` always asks
again. If a provider cannot be reached, or its login has expired, `cora` keeps the
last answer, and then falls back to `cli/harness/models.json`. Asking never refreshes
a login.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | The model reported `complete`, or `unreported` for a plain answer with no report. |
| 1 | The run failed: a provider error, a timeout, an empty or cut-off reply, or an internal error. |
| 2 | The command was wrong, or there is no login for that provider. |
| 3 | The model reported `partial`, `blocked` or `failed`. A `complete` with a failed check counts as `partial`. |
| 130 | Ctrl+C stopped the run while it waited for a usage limit to reset. The `cora_result` status is `stopped`. |

The model reports its status with a tool call and then answers in a normal reply, which is
the `text` of `cora_result`. A session has one writer: a second `cora` on it stops with
`session <id> is in use by another cora` after about 7 seconds, the time it takes to
tell a live writer from one that died, whose session it then takes over. A process
that loses its lock, for example when a laptop sleeps, stops and prints the `cora resume`
command, since another run may have changed the session in the meantime.

A rate limit of up to a minute is waited out and retried. A usage limit with a known reset
time is waited out too, in `cora` and `cora exec`: one line says what happened, when it
resets and that Ctrl+C stops it, then the same session goes on by itself. The rules:

- A wait never goes past six hours, which covers the five-hour window. A later reset, such
  as a weekly limit, stops the run. `"limitWait": { "maxMinutes": N }` in `settings.json`
  changes that.
- With no known reset the run stops with exit 1. Nothing polls.
- The run goes on 30 seconds after the reset (`marginSeconds`), to allow for clock
  differences, and tells the model in one note that it paused.
- If the limit is still on then, the run stops with exit 1. It waits again only after a
  real reply has shown the limit lifted.
- The wall clock decides, so a laptop that sleeps through the reset goes on as it wakes.
- The session lock stays held during the wait. If another `cora` takes the session over,
  this one stops rather than go on from old history.
- Ctrl+C stops the wait and leaves a session that `cora resume` continues. Esc does too in
  the terminal interface, which stays open. A killed wait resumes the same way.
- `--no-limit-wait`, or `"limitWait": false` in `settings.json`, stops at the limit with
  exit 1, says when it resets, and sets `resetsAt` in `cora_result`.

`--json` emits `{"type":"limit_wait","status":...,"resetsAt":...}` for each step: `waiting`,
then `resumed` or `stopped`, or instead `too_long` or `still_limited`. `cora_result` counts
them in `limitWaits`. A caller with its own deadline should watch for `waiting` or pass
`--no-limit-wait`.

A failed request is retried by itself, from the same context, so finished tool
calls never run twice. The error names the provider and the real cause.

### Accounts

`cora` uses a `cora login` sign-in if there is one, and otherwise Studio's Active
account, in place, without copying it. A Studio account can be shared with Claude
Code or the Codex CLI, and those rotate refresh tokens, so a second refresher
would sign them out. So `cora` asks a running Studio to renew a Claude login, the
same request Studio's own sessions make, and with Studio closed it refuses an expired
shared login rather than spending it. Nothing can renew a shared ChatGPT login for
`cora`, so it uses one only until it expires, then refuses and says what to do.
`cora login` creates a separate sign-in that only `cora` refreshes. An API key in the
shell never replaces a login. Login files are replaced whole under Pi's lock, so a
kill during a refresh leaves the old file.

### Files and settings

Everything lives in `~/.cora` (`CORA_HOME`): `auth.json`, `sessions/`, `skills/`,
`catalog.json`, `settings.json` and `models.json` in Pi's format. `httpIdleTimeoutMs` in
`settings.json` sets the hung-stream timeout. `bashTimeout` sets the time limit on each
bash call the model makes: `{ "defaultSeconds": 120, "maxSeconds": 1800 }`. A call past its
limit is killed with its process group, and the model gets the output so far and a line
saying that any later commands in that call did not run. The model can ask for a longer
limit up to the maximum, and runs longer jobs in the background. MCP servers come from `~/.cora/mcp.json`
or `--mcp-config FILE`, in `.mcp.json` format. A project's own `.mcp.json` does not
start by itself, because it can run any command. For a custom endpoint, set
`baseUrl` and `apiKey` in `models.json`, or set `CORA_BASE_URL`.

### Compaction

A long session is summarized between turns once its context passes 400,000 tokens,
or sooner on a model whose window leaves less room: the limit is the window minus
15%, with at least 32,768 tokens held back (`gpt-6-astra`, at 272,000, compacts at
231,200). The run then continues by itself. `/compact [focus]` does it by hand in the
terminal interface.

The summary is checked before it replaces anything. Code rebuilds the facts from the
session file every time: your messages word for word, files read and changed through
the read, write and edit tools, failed commands with their errors, the session id and the
folder. The model writes only the story around them. A history too large for one request is summarized in pieces, each
updating the last. A summary with a required part missing, an invented file, or too
large is retried once, and after that the session continues uncompacted with a warning.
A kill during compaction changes nothing, so `cora resume` works. The full history stays
in the session file.

Plain runs print `cora: compacted 412k -> 31k` on stderr. `--json` emits
`{"type":"compaction","status":"ok","reason":"threshold","tokensBefore":412000,"tokensAfter":31000}`,
or `"status":"failed"` with `error`, and `cora_result` carries a `compactions` count.

`~/.cora/settings.json` only, never a project's settings:

```json
{ "compaction": { "atTokens": 400000, "keepRecentTokens": 40000, "timeoutMs": 180000 } }
```

`keepRecentTokens` is how much of the latest conversation stays word for word.
`compaction.enabled: false` turns automatic compaction off. Project instructions and
skills are sent whole with every request, so they are never summarized.

## Driving Studio: `cora studio`

The remote commands below are all under `cora studio`. The CLI needs Node 22 or
newer. From a checkout:

```sh
npm link                         # once: puts `cora` on your PATH
cora studio help                 # the command list
npm run cora -- studio status    # or run it without linking
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
cora studio start "Fix the failing tests" --cwd . --wait
cora studio runs                              # recent runs, newest first
cora studio watch                             # live dashboard of the active run
cora studio send <run> 2                      # answer Cora's question with option 2
cora studio board <run>                       # the run's kanban board
```

Claude Code and Codex sessions can use `cora` to bring in Cora or a second
opinion:

```sh
cora studio agent spawn <run> "Audit the fix" --title "Independent audit" --runtime codex
cora studio agent message <run> all "Re-check the acceptance criteria"
```

Agents without MCP support call the same browser, terminal and worktree
tools through `cora tool` (see [MCP tools](mcp-tools.md)):

```sh
cora tool list
cora tool preview_audit --kind accessibility     # axe-core failures with @refs
cora tool preview_audit --kind quality           # performance, best-practice and SEO checks
cora tool preview_performance --action load      # traced reload with Core Web Vitals
cora tool preview_performance --action start     # then interact, then --action stop
cora tool preview_performance --action memory --ms 5000 --snapshot
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
`codex`, `chatgpt`, `grok`). One sign-in serves Cora and the CLI together, so
the older `auth cli add`, `auth cli login`, `auth cli use` and `auth cli logout`
forms are gone; `cora` points you to `auth add`, `auth login`, `auth use` or
`auth remove` instead. [accounts.md](./accounts.md) explains the model.

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

### Workflows

| Command | What it does |
|---|---|
| `workflow list` | Lists saved workflows (built-in, yours, and the project's). |
| `workflow show <name>` | Prints one workflow's source. |
| `workflow check <name \| file.js> [--args JSON]` | Checks a script without running it and prints the estimate. |
| `workflow run <name \| file.js> [--args JSON --max-agents N --concurrency N --tokens N]` | Asks for approval in the context chat, then starts the workflow. |
| `workflow status <workflow-run>` | Prints its progress; works offline. |
| `workflow wait <workflow-run> [--timeout SECONDS]` | Waits until it finishes or stops. |
| `workflow stop \| resume <workflow-run>` | Stops it, or resumes it; finished agents do not run again. |
| `workflow save <file.js> [--scope user \| project]` | Saves a script under its `meta.name`, after approval in the chat. |

Like automations, workflow commands use the newest chat run (or `--run`) for
their workspace.

### Benchmark

| Command | What it does |
|---|---|
| `bench [--split train \| holdout \| all] [--task NAME[,NAME]] [--repeat N] [--keep]` | Runs the harness benchmark through the live app and scores it 0 to 100. |
| `bench --agent hermes \| codex \| claude [--model M] [--effort E]` | Runs the same tasks through another headless agent for comparison. |
| `bench matrix --models all \| M1,M2 --output DIR [--task NAME] [--repeat N]` | Runs a model matrix with one artifact per model. |
| `bench --output FILE` | Saves a JSON artifact with every check. |
| `bench list` | Shows the suite's tasks. |
| `bench history` | Shows the score history. |

### Agent tools

`cora tool` calls the Codara Studio MCP tools from a terminal, for agents
without an MCP client and for scripts. It runs in a Codara terminal, acts on
that terminal's workspace, and answers like an MCP call; images and long
bodies are saved under Codara's workspace data folder and their paths printed.
The `codara_` prefix of a tool name is optional, and every command takes
`--json` for the raw result. Flag values are read as JSON
when they parse, otherwise as text, and a flag with no value is true.
[mcp-tools.md](mcp-tools.md) describes every tool.

| Command | What it does |
|---|---|
| `tool list` | Lists the tools. |
| `tool help <name>` | One tool's description and arguments. |
| `tool <name> ['{"arg":1}'] [--arg value ...]` | Calls a tool. |
| `inbox [--peek] [--limit N]` | What the user picked or commented on in a Codara browser tab and sent to the inbox, oldest first. Read items are removed unless `--peek`. Same as `tool preview_inbox`. |
| `inspect <@ref\|selector> [--tabId ID]` | Describes an element to edit it: selector, box model, styles, CSS rules, source `file:line`, and a cropped image saved as a file. `--x N --y N` names a point instead. Same as `tool preview_inspect`. |

```sh
cora tool preview_network --failed                       # failed requests of your tab
cora tool preview_network --status 4xx --type fetch,xhr
cora tool preview_network --id 1234.5                    # one request with its response body
cora tool preview_network --har                          # HAR 1.2 file, secrets redacted
cora tool preview_emulate --device phone --colorScheme dark
cora tool preview_emulate --network slow3g --cpu 4
cora tool preview_emulate --reset
cora tool preview_storage --action get --area local
cora tool preview_storage --action clear --area cookies
cora tool preview_storage --action fresh --url http://localhost:3000   # logged-out tab
cora tool preview_storage --action discard --tabId <id>
```

The browser tools reach the tabs of the user's own browser through the
Codara extension (see [mcp-tools.md](mcp-tools.md#the-users-own-browser)):

```sh
cora tool preview_chrome --action status       # paired browsers and shared chrome: tabs
cora tool preview_snapshot --tabId chrome:1234567
cora tool preview_click --tabId chrome:1234567 --selector @e12
cora tool preview_screenshot --tabId chrome:1234567
```

### App

| Command | What it does |
|---|---|
| `status` | Is the app running? Version and activity. |
| `read <paneId> [--lines N]` | Prints the recent output of a terminal pane. |
| `ws prune` | Removes workspaces whose folder no longer exists. |
| `rpc <method> [params-json]` | Calls any socket method directly. |
| `tool list \| help <name> \| <name> [args-json] [--arg value]` | Calls a codara-studio tool from any Codara terminal, with the same tool set and results as an MCP call. |

The `app.*` methods reachable through `cora studio rpc` (screenshots, in-page
evaluation) are for development: they are available in unpackaged builds,
and in packaged builds only when the app was started with
`CODARA_DEV_TOOLS=1`.

### Browser capture from a shell

`cora tool` calls the same browser tools an MCP client gets (see
[mcp-tools.md](mcp-tools.md#screenshots-visual-diffs-sizes-and-recordings)),
so an agent without MCP support can capture the page from its Codara pane.
Each call prints the result as JSON; images and recordings are files, and
their `path` is in the output.

```sh
cora tool preview_screenshot --fullPage --maxWidth 800        # compact JPEG of the whole page
cora tool preview_screenshot --selector @e12 --format png     # one element
cora tool preview_screenshot '{"clip":{"x":0,"y":0,"width":320,"height":200},"scale":2}'
cora tool preview_compare --mode baseline --name home         # before a change
cora tool preview_compare --name home                         # after: percent, regions, diff image path
cora tool preview_compare --mode sizes --colorScheme both     # phone, tablet, desktop in one image
cora tool preview_record --format gif                         # start; drive the flow, then:
cora tool preview_record --stop                               # the GIF's path
cora tool preview_record --format mp4                         # a sharp, small video instead
```

Add `--tabId <id>` (from `cora tool preview_list`) to act on a tab other
than the agent's own.
