# MCP tools

Codara Studio ships one MCP server, `codara-studio`, that lets agents use the
app: drive the built-in browser, open and read terminals, edit a chat's board
and whiteboard, and, for Cora, run workers and automations. This page explains
who gets the server, which tool set each kind of agent sees, and what every
tool does. The tool definitions in `resources/codara-studio-mcp/server.js`
are the source of truth; update this page when a tool is added or renamed.

## Who gets it

- **Claude Code, Codex and Grok.** On launch Codara adds the server to
  `~/.claude.json`, `~/.codex/config.toml` and Grok's `config.toml` when the
  CLI is installed. Each CLI has its own on/off switch in the Capability
  Center (the **MCP and skills** button in the Cora composer), under MCP
  servers. A CLI you switch off stays off. The Policy tab's **Auto-install
  Codara Studio MCP** controls whether Codara keeps the entries current on
  launch.
- **Cora and its Pi workers.** They load the same tools in-process, so there
  is nothing to install.

Every call is forwarded to the running app over its loopback socket. If the
app is closed, a tool returns a "Codara appears to be offline" error instead of
hanging.

## Tool sets

The server picks one tool set when it starts, from the `SPARK_MCP_MODE`
environment variable that Codara sets for the agent:

| Set | Who sees it | What it adds |
|---|---|---|
| `studio` (default) | Agents you run yourself in any terminal | Browser, terminals, whiteboard, board |
| `worker` | Workers in automation passes | `studio` with the whiteboard and board read-only, plus `codara_ask_user` and `codara_request_next_iteration` |
| `execute` | A Cora chat that orchestrates work | `studio`, plus orchestration and automation management |
| `automation` | The chat that designs automations | `studio`, plus automation management, `codara_ask_user` and `codara_name_chat` |

A Cora chat that answers directly, without workers, gets `studio` plus
`codara_remember`. When Cora works on an imported pull request from an
untrusted source, it only gets the orchestration tools that spawn, wait for,
and message workers, ask you, name the chat and complete the run: no browser,
terminal, memory or automation tools.

## Browser

Tools for the built-in Chromium browser tabs (called "preview" in tool names).
In every set.

| Tool | What it does |
|---|---|
| `codara_preview_list` | Lists the browser tabs in the workspace, with id, title, URL and which one is active. |
| `codara_preview_url` | Returns a tab's current URL and title. |
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
| `codara_terminal_write` | Types into a terminal the agent created, submitting with Enter by default. |
| `codara_terminal_read` | Reads the recent output of a terminal pane, without escape codes. |
| `codara_terminal_close` | Closes a terminal the agent created. It cannot close yours or another run's. |
| `codara_spawn_terminals` | Opens one tab split into Claude Code or Codex panes for you to drive. |

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

## Orchestration

Only in `execute`, except where noted.

| Tool | What it does |
|---|---|
| `codara_spawn_workers` | Hands one or more focused tasks to Cora workers, with optional runtime, model and effort hints. |
| `codara_wait_for_workers` | Waits until the listed workers finish, then returns their reports. |
| `codara_get_worker_status` | A one-off status check of one worker. |
| `codara_message_workers` | Sends a message to one worker or all of them. |
| `codara_check_messages` | Reads messages workers sent to Cora. |
| `codara_ask_user` | Asks you a question, with options, when Cora cannot decide safely. Also in `worker` and `automation`. |
| `codara_complete` | Marks the run complete once workers finished and their work was verified. |
| `codara_name_chat` | Gives the chat a short title. Also in `automation`. |
| `codara_remember` | Saves a lasting fact to Cora's memory, for you or for this workspace. |
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
