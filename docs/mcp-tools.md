# MCP tools

Codara Studio ships one MCP server, `codara-studio`, that lets agents use the
app: drive the built-in browser, open and read terminals, edit a chat's board
and whiteboard, and, for Cora, run workers and automations. This page explains
who gets the server, which tool set each kind of agent sees, and what every
tool does. The tool definitions are the source of truth: browser tools live
in per-area modules under `resources/codara-studio-mcp/tools/`, the rest in
`resources/codara-studio-mcp/server.js`. Update this page when a tool is
added or renamed.

## Who gets it

- **Claude Code, Codex and Grok.** On launch Codara adds the server to
  `~/.claude.json`, `~/.codex/config.toml` and Grok's `config.toml` when the
  CLI is installed. Each CLI has its own on/off switch in the Capability
  Center (the **Tools** button in the Cora composer), under Tools (MCP
  servers). A CLI you switch off stays off. The Behavior section's **Keep
  Codara Studio tools installed in Claude, Codex and Grok** controls whether
  Codara keeps the entries current on launch.
- **Cora and its Pi workers.** They load the same tools in-process, so there
  is nothing to install.

The managed entries carry a version marker; when it changes, Codara rewrites
them on the next launch. The Codex entry also sets `tool_timeout_sec = 660`
and `startup_timeout_sec = 20`, because Codex gives up on a tool after 60
seconds by default and `codara_terminal_run` may wait up to ten minutes.

Every call is forwarded to the running app over its loopback socket. If the
app is closed, or a crash left a stale handshake behind, a tool returns a
"Codara appears to be offline" error instead of hanging. For the next 30
seconds a call no longer waits for the app to start, so an agent that retries
hears the answer at once; the first call after Codara is back works. A token
Codara no longer accepts reads as "Codara rejected this session's
credentials" rather than a bare HTTP 401.

## Protocol behavior

- `initialize` negotiates the protocol version (2025-06-18, 2025-03-26 or
  2024-11-05) and returns `instructions`: a few lines on how the tool families
  fit together, limited to the families in the roster. `serverInfo.version`
  is the app version.
- Every tool carries annotations: a title, and `readOnlyHint`,
  `destructiveHint`, `idempotentHint` and `openWorldHint` where they apply, so
  clients can auto-approve reads and warn before destructive calls.
- Results are compact JSON. Errors are tool results with `isError: true` and a
  message saying what to do next; socket errors keep their code, for example
  `(Codara error -32003: not allowed for this agent)`.
- `notifications/cancelled` aborts the HTTP request behind a call (a long
  wait, a terminal run) and the call gets no reply. Long calls with a
  `progressToken` send a progress heartbeat every 10 seconds;
  `codara_preview_run` reports each step.
- A request body is limited to 64 KB, or 1 MB for whiteboard and board
  updates. The server refuses a larger call before sending it, and the socket
  answers an oversized one with a JSON-RPC error rather than a reset.
- Tools never take a `runId`. The chat comes from the environment Codara
  launched the agent with, and a call that names another run is refused.

## Tool sets

The server picks one tool set when it starts, from the `SPARK_MCP_MODE`
environment variable that Codara sets for the agent:

| Set | Who sees it | What it adds |
|---|---|---|
| `studio` (default) | Agents you run yourself in any terminal | Browser, terminals, `codara_notify_user` and the worktree tools; whiteboard and board only inside a Cora chat |
| `worker` | Workers in automation passes | `studio` with the whiteboard and board read-only, plus `codara_ask_user` and `codara_request_next_iteration` |
| `execute` | A Cora chat that orchestrates work | `studio`, plus orchestration, automation management and the worktree tools |
| `automation` | The chat that designs automations | `studio`, plus automation management, `codara_ask_user` and `codara_name_chat` |

A Cora chat that answers directly, without workers, gets `studio` plus
`codara_remember` and the worktree tools, with the whiteboard and board
read-only. Cora's chat workers and Talk chats do not get the worktree tools. Requests to draw
on the whiteboard, change the board or schedule work therefore go to the
orchestrating chat, and a direct chat hands over to it when a follow-up needs
those tools. The whiteboard and board belong to a chat, so they are only
listed when Codara started the agent for one (`SPARK_RUN_ID` is set); an
agent you run yourself does not see them, and a call without a chat fails
with "only works inside a Cora chat". When Cora works on an imported pull request from an
untrusted source, it only gets the orchestration tools that spawn, wait for,
and message workers, ask you, name the chat and complete the run: no browser,
terminal, memory or automation tools.

Inside Cora's own runtime (Pi), the browser, terminal, whiteboard, board,
automation and worktree tools start inactive in the orchestrating chat and are loaded on
demand with `codara_tools`, which also returns how to use them. A request that
plainly needs a family loads it on the first turn. This keeps every request
smaller. Cora and her workers also have `fetch_url`, which reads one web page
as text, next to `web_search` and the free `deep_search`.

## Browser

Tools for the built-in Chromium browser tabs (called "preview" in tool names).
In every set.

Browser tools work in the caller's workspace, even when you are looking at
another one. A Cora run uses its run's workspace and only the tabs it opened. A
Claude, Codex or other agent running in a Studio terminal uses the workspace of
that terminal: a navigate reuses only a tab that agent opened (or opens a new
background one), and other calls fall back to the user's tab in that workspace,
never a run's tab or another agent's. Only a caller outside every Studio
terminal, such as an agent started from another terminal app, works in the
workspace on screen.

| Tool | What it does |
|---|---|
| `codara_preview_list` | Lists the browser tabs in the workspace, with id, title, URL and which one is active. |
| `codara_preview_navigate` | Loads a URL (http, https or file) in a tab, creating one for the run if needed. |
| `codara_preview_snapshot` | Reads the page as a compact outline with `@references` that other tools accept as selectors. Can return only what changed since a previous snapshot. |
| `codara_preview_click` | Clicks one element by `@reference` or unique CSS selector. |
| `codara_preview_type` | Types into a field, or picks an option in a native dropdown. |
| `codara_preview_press_key` | Sends a key (Enter, Escape, Tab, arrows, a character) to the focused element or a selector. |
| `codara_preview_evaluate` | Runs JavaScript in the page and returns the result. |
| `codara_preview_wait_for` | Waits until a selector is attached, visible or hidden. |
| `codara_preview_screenshot` | Captures the tab as a PNG, with the scale needed to turn image pixels into page coordinates. |
| `codara_preview_mouse` | Trusted mouse input (click, double-click, right-click, down, up) at a selector or coordinates. |
| `codara_preview_scroll` | Scrolls with a trusted mouse-wheel event. |
| `codara_preview_hover` | Moves the mouse over an element, triggering real hover styles and tooltips. |
| `codara_preview_drag` | Trusted drag from one point or element to another. |
| `codara_preview_key` | Trusted keyboard input with optional modifiers. |
| `codara_preview_upload` | Sets the files of an `<input type=file>`. |
| `codara_preview_console` | Reads the tab's captured console messages. |
| `codara_preview_network` | Reads the tab's captured network requests. |
| `codara_preview_resize` | Resizes the viewport, for example to test a mobile layout. |
| `codara_preview_run` | Runs a batch of the steps above in one call. |

`codara_preview_url` is no longer listed (`codara_preview_list` returns every
tab's URL and title) but stays callable for agents that still use it. Outside
a Cora chat, browser calls act on the workspace of the terminal the agent runs
in, not on whichever workspace is on screen.
Tips for agents: call `codara_preview_navigate` first, read the page with
`codara_preview_snapshot` and act on its `@references`, and prefer
`codara_preview_run` for multi-step flows. The trusted tools (`mouse`,
`scroll`, `hover`, `drag`, `key`) produce input the page cannot tell apart
from a real user's.

## Terminals

In every set, except `codara_spawn_terminals`, which is only in `execute`.

| Tool | What it does |
|---|---|
| `codara_terminal_create` | Opens a new terminal tab owned by the agent, tinted so you can see an agent drives it. Temporary terminals close when the run finishes; `retention: "service"` keeps one (a dev server, say) until the run is deleted. |
| `codara_terminal_run` | Runs one command in a terminal the agent created, or in a new one, and waits for it: returns the exit code, the output and a `cursor`. With Codara's shell integration the shell reports when the command ended; otherwise the call returns once output has been quiet. A command still running at `timeoutMs` (default 30 seconds, at most 10 minutes) keeps running. Refuses a pane that is busy, including one another `codara_terminal_run` call is still using. |
| `codara_terminal_list` | Lists the terminal panes in the agent's workspace: title, cwd, which agent CLI runs there and its state, whether the shell is running a command, which pane is the caller's and which ones it may write to. |
| `codara_terminal_write` | Types into a terminal the agent created, submitting with Enter by default. |
| `codara_terminal_read` | Reads a terminal pane without escape codes. Returns a `cursor`; pass it back as `since` to get only output written after it. `mode: "screen"` renders what a full-screen program (an agent CLI, vim, top) shows instead of the raw stream. |
| `codara_terminal_close` | Closes a terminal the agent created. It cannot close yours or another run's. |
| `codara_spawn_terminals` | Opens one tab split into Claude Code, Codex, Grok or Pi panes for you to drive, launched the way the **+** menu launches them. An optional model and effort apply to each group; for Pi they become `--model` and `--thinking`. |

## Notifications

Only in `studio` outside a Cora chat (a Cora run announces its own outcome).

| Tool | What it does |
|---|---|
| `codara_notify_user` | Sends a Codara notification from the agent's own pane: `done` when it finished a long task, `needs_input` when it is blocked on you. Clicking it opens the pane, and nothing shows while you are already looking at that pane. When Codara already reads the agent's own turn signals in that pane (Claude Code hooks or status reports, the Codex notify program or its session file), the call returns `published: false` with `reason: "announced_by_codara"`, because an alert sent mid-turn would arrive before the real end and displace the exact one. Otherwise it shares the pane's notification key with Codara's own end-of-turn alert, so the two arrive as one. At most one per kind every 5 seconds. An agent outside a Codara terminal, or with Codara closed, gets `published: false` back rather than an error. |

## Worktrees

In `studio` outside a Cora chat, in `execute`, and in a Cora chat that answers
directly. An agent gets a separate checkout of its own repository on its own
branch, which you see in the rail under the repository, and removes it once
the branch is merged. The repository is always the one the agent runs in: its
terminal pane or its Cora chat decides, never a tool argument. SSH workspaces
are not supported yet.

| Tool | What it does |
|---|---|
| `codara_worktree_create` | Creates a worktree on a new branch (default `agent/<purpose>-<id>`, from the default branch after a fetch) or, with `checkout: true`, on an existing branch. The agent's own cwd does not change; it works under the returned `path`. The repository's copy-branch setup command comes back as `setupCommand` to run in a terminal there. Asking again for the same branch returns the existing worktree. At most 20 agent worktrees per repository. |
| `codara_worktree_list` | Lists the repository's Codara-managed worktrees: who created each, uncommitted and ignored files, terminals, runs and processes using it, merge status, and `removable` with the `blockers` that `codara_worktree_remove` would report. `checkMerge: true` fetches and asks GitHub, so it is slower. Worktrees Codara does not manage are listed under `unmanaged` and are never touched. |
| `codara_worktree_remove` | Removes a worktree and, by default, the branch it created. `dryRun: true` only checks. |

`codara_worktree_remove` never forces anything. It removes a worktree only
when all of these hold, and otherwise returns an error result with a `code`,
the `blockers` and a `hint`:

- an agent created it, unless you turned on **Let agents remove worktrees I
  created** in Settings > General; GitHub issue and pull-request workspaces
  are removed from the rail only;
- its exact last commit is merged into the target (its base, or `target`):
  the target contains it, a merged pull request from the same repository has
  it as head, or merging it into the target changes nothing (a squash merge).
  A `target` the agent names must be another local or remote-tracking
  branch, never the worktree's own branch, its pushed copy or a commit id;
- it has no uncommitted or untracked files (edits hidden by
  `assume-unchanged` or `skip-worktree` count), no merge or rebase in
  progress, and no ignored files beyond build output and caches
  (`node_modules/`, `dist/`, `.venv/` and similar, plus the patterns you add
  for the repository in Settings); `discardIgnoredFiles: true` deletes the
  rest;
- no submodule or nested repository is checked out in it, and no other
  checkout or worktree sits inside it, ignored folders included. The search
  through ignored folders visits at most 50,000 folders; when it runs out,
  or a folder cannot be read, removal is refused with
  `WORKTREE_NESTED_SCAN_INCOMPLETE` and the folder it gave up on, because an
  unfinished search cannot rule a nested checkout out. The agent can delete
  that folder itself if it only holds build output or dependencies, such as
  `node_modules/`, and try again;
- no other owner may still be working in it: a worktree another Cora run
  created is kept while that run is active, and one an agent in another
  terminal created is kept while that terminal is open, because such an
  agent works there through absolute paths and `git -C` and no usage check
  can see it;
- no terminal, active Cora run or process uses it, and the caller is not
  inside it.

The `code` is the first blocker; `blockers` lists them all, and a dry run or
`codara_worktree_list` reports the same codes without removing anything:

| Code | Meaning | What the agent should do |
|---|---|---|
| `WORKTREE_USER_CREATED` | You created it and agents may not remove your worktrees. | Ask you. |
| `WORKTREE_ORIGIN_MANAGED` | It is a GitHub issue or pull-request workspace. | Leave it; you remove it from the rail. |
| `WORKTREE_OWNED_BY_ACTIVE_RUN` | Another Cora run created it and is still active (`details.ownerRunId`). | Leave it to that run; ask you if it must go now. |
| `WORKTREE_OWNED_BY_LIVE_AGENT` | An agent in another terminal created it and that terminal is still open (`details.ownerPaneId`). | Leave it to that agent, or ask you. |
| `WORKTREE_NOT_MANAGED` | The folder cannot be read, so it may still hold work, or it is no longer a git worktree in Codara's worktrees folder. | Ask you. |
| `WORKTREE_LOCKED` | `git worktree lock` protects it. | Ask you. |
| `WORKTREE_DETACHED_HEAD`, `WORKTREE_BRANCH_MISMATCH` | It is not on the branch Codara recorded. | Check out that branch again, or ask you. |
| `WORKTREE_DIRTY` | Uncommitted, untracked or hidden (`assume-unchanged`, `skip-worktree`) changes. | Commit or discard them yourself. |
| `WORKTREE_OPERATION_IN_PROGRESS` | A merge, rebase, cherry-pick or similar is in progress. | Finish or abort it. |
| `WORKTREE_IGNORED_FILES` | Ignored files that are not build output or caches. | Move them, or pass `discardIgnoredFiles: true`. |
| `WORKTREE_SUBMODULES` | A submodule or committed nested repository is checked out. | Ask you. |
| `WORKTREE_NESTED_REPOSITORY` | Another checkout or worktree sits inside it (`details.nestedRepositories`). | Move or remove it first, or ask you. |
| `WORKTREE_NESTED_SCAN_INCOMPLETE` | The search for nested checkouts could not finish (`details.unscannedFolder`). | Delete that folder if it only holds build output or dependencies, then retry; otherwise ask you. |
| `WORKTREE_NOT_MERGED` | The last commit is not merged into the target. | Push and merge it, or ask you to delete it from the rail. |
| `WORKTREE_TARGET_NOT_FOUND` | The merge target does not exist or cannot be a target. | Pass `target`, the branch it was merged into. |
| `WORKTREE_RUNNING_PANES` | Terminals are open in it. | Close your own with `codara_terminal_close`; otherwise wait or ask you. |
| `WORKTREE_ACTIVE_RUNS` | Active Cora runs work in it. | Wait for them to finish, or ask you. |
| `WORKTREE_RUNNING_PROCESSES` | Processes run in it. | Stop them, or wait or ask you. |
| `WORKTREE_CALLER_INSIDE` | The caller runs inside it. | Call from the source workspace, or ask you to delete it from the rail. |

Before deleting anything Codara saves the last commit as
`refs/codara/removed-worktrees/<date>/<workspace id>`, kept for 30 days, and
the result carries `recoverWith`, the command that restores the worktree. The
branch is deleted only if it still points at the commit that was checked.
Every create and removal, refused or not, is logged to
`~/.codarastudio/logs/worktree-audit.jsonl`. **Let agents create and remove
worktrees** in Settings turns creating and removing off; listing still works.

## Whiteboard and board

Every Cora chat has a whiteboard (a free-form canvas) and a board (a kanban of
task cards). Both are shared with you, so the tools check revisions and never
overwrite your edits. [whiteboard-review.md](./whiteboard-review.md) explains
the review workflow.

| Tool | What it does | Sets |
|---|---|---|
| `codara_whiteboard_get` | Reads the chat's whiteboard, its revision and your latest edits. | all |
| `codara_whiteboard_update` | Creates, replaces, extends or clears the whiteboard. Every edit is a draft. | not `worker` |
| `codara_whiteboard_arrange` | Lays the cards out automatically. | not `worker` |
| `codara_whiteboard_inspect` | Renders the whiteboard to a PNG with layout and source-reference checks. | all |
| `codara_whiteboard_review` | Records Cora's review of the exact revision it inspected. | not `worker` |
| `codara_board_get` | Reads the chat's board: cards, lanes and revision. | all |
| `codara_board_update` | Creates, moves and edits cards. Cards you wrote can only be deleted by you. | not `worker` |

Updates answer with the new revision and counts, not the whole graph or
board; call the get tool to read it back.

## Orchestration

Only in `execute`, except where noted.

| Tool | What it does |
|---|---|
| `codara_spawn_workers` | Hands one or more focused tasks to Cora workers, with optional runtime, model and effort hints. |
| `codara_wait_for_workers` | Waits until the listed workers finish, then returns their reports, why any of them failed, and what a slow one is doing. |
| `codara_get_worker_status` | A one-off status check of one worker. |
| `codara_message_workers` | Sends a message to one worker or all of them. |
| `codara_check_messages` | Reads messages workers sent to Cora. |
| `codara_ask_user` | Asks you a question, with options, when Cora cannot decide safely. Also in `worker` and `automation`. |
| `codara_complete` | Marks the run complete once workers finished and their work was verified. With `accept_unverified` (a reason and the task ids of every blocking verifier), Cora can overrule a verdict she judged out of contract; the run lands as completed but unverified and the reason is added to the summary you see. |
| `codara_plan_update` | Records Cora's plan for multi-phase work: your request, milestones with status, decisions and next steps. The plan survives compaction and restarts, and `codara_complete` is refused while a milestone is still open. |
| `codara_name_chat` | Gives the chat a better title when the one derived from your first message is wrong or the topic shifts. Also in `automation`. |
| `codara_remember` | Saves a lasting fact to Cora's memory, for you or for this workspace. Workers in chat runs get a read-only copy of the memory; automation workers do not. |
| `codara_request_next_iteration` | In an automation loop, decides whether another pass runs. Also in `worker`. |

## Automations

In `execute` and `automation`. Changes that enable, edit or delete an
automation are shown to you for approval in the chat first.

| Tool | What it does |
|---|---|
| `codara_list_automations` | Lists the workspace's automations and their state. |
| `codara_get_automation` | Reads one automation's full definition. |
| `codara_create_automation` | Creates an automation in this chat's workspace. |
| `codara_update_automation` | Changes an automation (asks you first). |
| `codara_run_automation` | Runs an automation now. |
| `codara_wait_for_automation` | Waits for an automation's current pass to finish. |
| `codara_set_automation_enabled` | Turns an automation's trigger on or off (asks you first). |
| `codara_pause_automation` | Pauses a running automation loop. |
| `codara_resume_automation` | Resumes a paused loop. |
| `codara_stop_automation` | Stops the current loop; the automation stays. |
| `codara_delete_automation` | Deletes an automation (asks you first). |

## Workflows

Only in `execute`, and never for an imported pull request. A workflow is a
script that fans work out to many agents; see Workflows in
[architecture.md](architecture.md#orchestration-cora).

| Tool | What it does |
|---|---|
| `codara_workflow_list` | Lists saved workflows. |
| `codara_workflow_get` | Reads one saved workflow's source. |
| `codara_workflow_check` | Checks a script without running it: syntax, `meta`, and an estimate of agents and tokens. |
| `codara_workflow_run` | Runs a saved workflow or an inline script, with optional caps. Asks you first. |
| `codara_workflow_status` | A workflow run's progress tree, and its result once it finished. |
| `codara_workflow_wait` | Waits until a workflow run finishes, stops or needs you. |
| `codara_workflow_stop` | Stops a workflow run; it can be resumed. |
| `codara_workflow_resume` | Resumes it; agents that finished are answered from the journal. Switching the run to an edited saved script asks you first. |
| `codara_workflow_save` | Saves a script for you or the project. Asks you first. |
