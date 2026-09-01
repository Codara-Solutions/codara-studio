# MCP tool reference

The bundled MCP server (`resources/codara-studio-mcp/server.js`) exposes one of four rosters, chosen once at startup by the `SPARK_MCP_MODE` environment variable that Codara sets when it launches an agent:

- **studio** (default, and what the auto-installed entry in `~/.claude.json`, `~/.codex/config.toml`, and Grok's `config.toml` gets): preview, terminals, board, whiteboard, automations.
- **worker**: the tools a Cora worker pane needs.
- **execute**: the manager roster for an orchestrated run (spawn and wait for workers, ask the user, complete).
- **automation**: the execute roster for automation loops plus `codara_request_next_iteration`.

Every call is proxied to the running app over the loopback agent socket; if the app is closed the tool returns a "Codara appears to be offline" error. Descriptions below are the first sentence of each tool's own description; the server's schema is authoritative. Regenerate this table with `node -e` over `server.js` when tools change.

## Preview (browser use)

| Tool | Description |
|---|---|
| `codara_preview_list` | List the preview tabs currently open in Codara. Returns each tab's id, url, and whether it is the active one. Use this first to confirm a pr |
| `codara_preview_url` | Return the current URL and title of a Codara preview tab. Defaults to the active preview tab when tabId is omitted. |
| `codara_preview_navigate` | Navigate the target Codara preview tab to a URL (http://, https://, or file://). Waits briefly for dom-ready before returning. |
| `codara_preview_snapshot` | Return a compact outline of the current preview DOM (tag, id, class, role, accessible name). Use to find selectors and inspect structure wit |
| `codara_preview_click` | Click an element by CSS selector inside the target preview tab. Fires pointer/mouse events plus element.click() so React/Vue handlers fire. |
| `codara_preview_type` | Type text into an input/textarea/contentEditable inside the target preview tab. Optionally clears the existing value first. |
| `codara_preview_press_key` | Dispatch a keyboard event on the focused element (or a selector if provided). Use named keys like Enter, Escape, Tab, ArrowUp, Backspace, or |
| `codara_preview_evaluate` | Run a JavaScript snippet inside the preview tab. Last expression's value is returned (JSON-serialized). Set awaitPromise=true to await an as |
| `codara_preview_wait_for` | Wait for a CSS selector to be attached / visible / hidden, up to timeoutMs. Returns when the condition is met or times out. |
| `codara_preview_screenshot` | Capture the current preview tab as a PNG (returned base64-encoded in a data: URL). The pixels are exactly what the user sees in Codara. |
| `codara_preview_mouse` | Trusted mouse input at a CSS selector's center or explicit coordinates, indistinguishable from a real user's click (event.isTrusted=true), u |
| `codara_preview_scroll` | Scroll the page with a trusted mouse-wheel event at a selector's center or explicit CSS-pixel coordinates. Positive deltaY scrolls down, neg |
| `codara_preview_hover` | Move the mouse over a selector's center or explicit CSS-pixel coordinates with a trusted mouseMove, triggers real :hover styles, tooltips, a |
| `codara_preview_drag` | Trusted drag: mouseDown at 'from', interpolated mouseMove steps, mouseUp at 'to'. Each endpoint is { selector } or { x, y } in CSS pixels. |
| `codara_preview_key` | Trusted keyboard input to the focused element: named keys (Enter, Escape, Tab, Backspace, ArrowDown, …) or a single character, with optional |
| `codara_preview_upload` | Set the files of an <input type=file> via the DevTools protocol (the only reliable way to script a file upload). 'paths' are absolute paths  |
| `codara_preview_console` | Read the preview tab's captured console messages (ring buffer, newest last, cap 500). Filter with level=debug\|info\|warning\|error, trim with  |
| `codara_preview_network` | Read the preview tab's captured network requests (url, method, status, mimeType, failures; ring buffer cap 500). Capture attaches on first c |
| `codara_preview_resize` | Resize the preview viewport to explicit CSS-pixel dimensions (e.g. 375×667 to test a mobile layout). Returns the applied size. |
| `codara_preview_run` | Run an ordered BATCH of preview steps in ONE call (one MCP round-trip) instead of dozens of single click/press_key calls. Each step dispatch |

## Terminals

| Tool | Description |
|---|---|
| `codara_terminal_create` | Open a NEW agent-owned terminal tab in Codara Studio. The tab is visually tinted so the user can see an agent is driving it. Temporary termi |
| `codara_terminal_write` | Write text to an agent-owned terminal pane (identified by the paneId returned from codara_terminal_create). By default the text is submitted |
| `codara_terminal_read` | Read the recent visible output of a terminal pane (identified by paneId). Returns the tail of the pane's buffer with ANSI/VT control sequenc |
| `codara_terminal_close` | Stop and close an agent-owned terminal returned by codara_terminal_create. Ownership is scoped to the calling Cora run, so this cannot close |
| `codara_spawn_terminals` | Open ONE persistent terminal tab for the user, split into one interactive pane per requested Claude Code or Codex session. Use this when the |

## Board and whiteboard

| Tool | Description |
|---|---|
| `codara_whiteboard_get` | Read this Cora chat's current editable whiteboard, including its revision and the user's latest manual edits. Returns null when no board exi |
| `codara_whiteboard_update` | Create, replace, extend, or clear this chat's persisted infinite whiteboard. First call codara_whiteboard_get, preserve the user's edits, an |
| `codara_board_get` | Read this chat's Cora Board: the kanban of task cards you manage for this conversation, their lanes, and the board's revision. Lanes are ide |
| `codara_board_update` | Manage this chat's board: create cards in any lane, move or edit any card, and keep the lanes truthful as work progresses. Call codara_board |

## Automations

| Tool | Description |
|---|---|
| `codara_list_automations` | List all Cora automations ( |
| `codara_get_automation` | Fetch one automation's full definition (trigger, loop, prompt, worker, graph, state, recent history) by id. Use before updating so you can p |
| `codara_create_automation` | Create a new automation bound to THIS chat's workspace (Codara resolves the workspace/cwd from the run, never supply paths). Provide name, t |
| `codara_update_automation` | Update an existing automation. Only the fields you pass are changed; omit the rest. Same field shapes as codara_create_automation. |
| `codara_run_automation` | Run an automation immediately (a manual fire), independent of its trigger. Returns the created run id. Pair with codara_wait_for_automation  |
| `codara_wait_for_automation` | Long-poll until an automation's current run/iteration reaches a terminal state (idle/stopped/blocked) or timeout_ms elapses. Returns final s |
| `codara_set_automation_enabled` | Enable or disable an automation's trigger without deleting it. The user is asked to approve the toggle in the chat before it applies (same c |
| `codara_pause_automation` | Pause a running automation loop (it can be resumed later). The trigger may still be armed. |
| `codara_resume_automation` | Resume a paused automation loop. |
| `codara_stop_automation` | Stop an automation's current loop now (finalizes the live iteration). The automation remains and can be run again. |
| `codara_delete_automation` | Permanently delete an automation. DESTRUCTIVE. The user will be asked to APPROVE the deletion in the chat before it happens (enforced server |

## Execute roster (orchestrated runs)

| Tool | Description |
|---|---|
| `codara_name_chat` | Give THIS architect chat a short, human-readable title describing what it is about (3-6 words, e.g.  |
| `codara_spawn_workers` | Delegate one or more focused tasks to Cora workers (claude/codex subagents). Each worker entry needs a title and description; runtime/model/ |
| `codara_ask_user` | Ask the human user only for credentials/access, destructive or irreversible work, safety/policy, irreducible product scope with no safe defa |
| `codara_complete` | Mark a managed execution run as complete. Call this exactly once only after at least one coding worker was spawned for the active implementa |
| `codara_remember` | Write a durable fact to Cora's memory so a LATER session starts already knowing it. Two tiers, each a plain markdown file the user can open  |
| `codara_request_next_iteration` | For Codara AUTOMATION LOOPS only: decide whether this loop should run another iteration after the current one finishes. Call this exactly on |
| `codara_get_worker_status` | One-shot snapshot of a worker task's current status, use sparingly for ad-hoc spot checks. For waiting on completion, prefer codara_wait_for |
| `codara_message_workers` | Send a message from you (the manager) into the running batch's shared mailbox, the same mailbox the workers use to coordinate with each othe |
| `codara_check_messages` | Read messages workers have sent you (the manager) that you have not seen yet, questions when they are blocked, and milestone/progress notes, |
| `codara_wait_for_workers` | Block until the listed worker tasks reach a terminal state (accepted / failed / cancelled) or timeout_ms elapses. This is the canonical way  |

