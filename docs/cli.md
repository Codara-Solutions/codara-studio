# cora CLI reference

Output of `cora help`. `cli/README.md` covers the fullscreen chat UI, accounts, the live dashboard, and the harness benchmark in depth.

```

  cora — drive Cora, Codara Studio's orchestrator, from your terminal

SESSIONS
  chat [run] [--cwd DIR --profile NAME --direct]            fullscreen Cora chat
  start <prompt> [--cwd DIR --profile NAME --direct]        start a Cora run
  send <run> <message|option#> [--wait]                    reply / answer a question
  wait <run> [--timeout SECONDS]                           block until it needs you
  tail <run> [--all]                                       stream live events
  cancel <run> [reason]                                    stop a run

PROFILES & MEMORY
  profile list                         list named Cora identities
  profile create <name> [--description TEXT --instructions TEXT]
                                       create isolated profile + memory
  profile use <name|id>                select the default for new chats

ACCOUNTS
  auth list [provider]                 list Cora + native CLI accounts
  auth add <provider> [label]          connect another Cora subscription
  auth use <provider> <#|label|id>     default account for new Cora chats
  auth login|rename|remove <provider> …
  auth cli list [claude|codex|grok]    list managed terminal identities
  auth cli add|login|use|rename|logout|remove <runtime> …
                                       manage Claude/Codex/Grok CLI accounts

RUNS & AGENTS
  runs                         list runs (works offline)
  run <run>                    one run in detail
  log <run>                    the conversation transcript
  agents [run]                 subagents: every worker, its status and model
  watch [run]                  live dashboard of a run and its subagents
  agent spawn <run> <prompt> [--title T --runtime claude|codex|grok --effort E]
  agent message <run> <all|task-id> <message>

SURFACES
  board <run>                  the run's kanban board
  whiteboard <run>             the run's whiteboard markdown
  auto list                    automations in the workspace
  auto run|pause|resume|on|off <automation-id>

BENCH
  bench [--split train|holdout|all] [--task NAME[,NAME]] [--repeat N] [--keep]
                               harness benchmark via the live app: 0-100 score
                               (correctness, par efficiency, post-green
                               discipline, orchestration); appends history.jsonl
  bench --agent hermes [--model M --effort E]
                               same-model comparison through Hermes Agent
  bench list                   show the suite's tasks (tier, split)
  bench history                score trajectory across runs
  ws prune                     remove workspaces whose directory is gone

APP
  status                       is Codara running? version + activity
  read <paneId> [--lines N]    read a terminal pane
  rpc <method> [params-json]   raw JSON-RPC escape hatch

FLAGS  --json (raw output)   --home DIR (Codara home, default ~/.codarastudio)

  <run> accepts a full id or any unique prefix.

```

The CLI finds the app through `~/.codarastudio/agent-socket.json` and talks JSON-RPC to the loopback socket. `runs`, `run`, `log`, `board`, and `whiteboard` also work with the app closed because they read `~/.codarastudio/runs` directly. The `app.*` RPC namespace reachable through `cora rpc` is dev-gated: available in unpackaged builds, and in packaged builds only when the app was launched with `CODARA_DEV_TOOLS=1`.
