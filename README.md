# Codara Studio

Desktop control surface (Electron) for supervising AI coding agents — terminals,
runs, automations, and a built-in browser Preview.

- Product overview: [`PRODUCT.md`](./PRODUCT.md)
- Visual/design system: [`DESIGN.md`](./DESIGN.md)

## Preview browser-use

Codara ships a zero-install browser-use / computer-use surface: the built-in
**Preview** tab is a real Chromium `<webview>`, and any manually-run or
orchestrated `claude` / `codex` CLI can drive it through the bundled
`codara-studio` MCP server. No Playwright, no headless Chrome, no extra
browser window — the agent acts on the exact pixels and DOM the user sees.

The server is auto-installed into `~/.claude.json` and `~/.codex/config.toml`
(toggle: **Settings → Capabilities**, or `playwrightMcpAutoInstall`). When the
`claude` / `codex` binary is detectable on disk, Codara creates the config entry
even if the CLI has never been launched. It proxies each tool call back to the
running app over a loopback HTTP + bearer-token channel described by
`~/.codarastudio/agent-socket.json`.

### Using it

1. **The Codara app must be running.** The MCP server reads the handshake file on
   every call; if Codara is closed the tool returns a clean "Codara appears to
   be offline" error instead of hanging.
2. **First call `codara_preview_navigate({ url })`.** It auto-creates the
   preview tab if none is open — you do not have to ask the user to open one.
   Subsequent calls default to the active preview tab (pass `tabId` to target a
   specific one; `codara_preview_list` enumerates them).
3. **Screenshots return inline images.** `codara_preview_screenshot` (and any
   `screenshot` step in `codara_preview_run`) return the PNG as an inline image
   block, so the agent can literally look at the rendered UI.

### Tools

Discovery / DOM:
`codara_preview_list`, `codara_preview_url`, `codara_preview_navigate`,
`codara_preview_snapshot`, `codara_preview_evaluate`, `codara_preview_wait_for`,
`codara_preview_screenshot`.

Input:
`codara_preview_click`, `codara_preview_type`, `codara_preview_press_key`, plus
scroll/hover/drag/mouse/upload and console/network probes.

Batch:
`codara_preview_run` executes an ordered batch of steps in a single round-trip —
strongly preferred for multi-step verification flows (drive `7 / 2 =` and read
the display in one call, not seven).

The same server also carries the terminal studio roster
(`codara_terminal_create/read/write/close`) and, for orchestrated runs, the
Execute and Automation rosters (`codara_spawn_workers`,
`codara_wait_for_workers`, `codara_board_*`, `codara_whiteboard_*`, …).

## The `cora` CLI

`cli/cora.cjs` is a zero-dependency terminal remote for the running app — the
fastest way to poke a new feature without a Playwright harness. It discovers
the app exactly like the MCP servers do (reads `~/.codarastudio/agent-socket.json`,
speaks bearer-authed JSON-RPC to the loopback socket). See `cli/README.md`
for the command surface, the live dashboard, and the harness benchmark.

```sh
npm link                 # once — gives you a global `cora`
cora status              # is the app up? version, subscriptions, activity
cora runs                # list runs straight off disk (works app-closed)
cora watch <run>         # live dashboard of a run and its subagents
cora log <run>           # the conversation transcript
cora board <run>         # the run's kanban board
cora auth list           # Cora subscriptions + native CLI identities
cora bench               # the harness benchmark (see cli/README.md)
cora ws prune            # remove workspaces whose directory is gone
cora rpc preview.list    # raw JSON-RPC escape hatch (any method)
```

Claude and Codex terminals can also use the CLI as an agent-to-agent bridge:

```sh
cora start "Fix the failing tests" --cwd . --wait
cora agent spawn <run> "Audit the fix" --title "Independent audit" --runtime codex
cora agent message <run> all "Re-check the acceptance criteria"
```

### CLI accounts

Every account you add in **Settings → Accounts** has its own private login
directory, and one account per CLI is marked **Active**. Every terminal Codara
Studio opens uses the Active account — agent panes resolve it at spawn, and a
plain Studio shell gets it in its environment, so even a `claude` or `codex`
you type yourself signs in as the Active account (terminals already open keep
the account they started with). Your own terminals outside Codara are
untouched: a plain `claude` or `codex` there keeps whatever login it always
had. Codara never edits your shell startup files.

Switching the Active account behaves like logging out and back in on one home:
your chats, `/resume` list, history, and settings all stay — each account keeps
only its own sign-in. Under the hood, every managed account shares the
user-state surfaces (Claude's `projects/`, `settings.json`, history; Codex's
`sessions/`, `config.toml`, history) with your personal `~/.claude` /
`~/.codex` through links, while credentials and identity files stay private to
each account. On Windows, managed accounts keep the older fully-isolated
behavior.

```sh
cora auth list                         # every Cora + native CLI account
cora auth add anthropic "Work Claude"  # add a Cora subscription in-browser
cora auth use anthropic "Work Claude"  # default for future Cora chats
cora auth cli list claude              # Claude Code terminal identities
cora auth cli add claude "Work CLI"    # sign in in a guarded Studio terminal
cora auth cli use claude "Work CLI"    # Active account for new terminals
```

The two account roles are deliberately separate. `cora auth use` chooses a
Cora subscription for future chats; `cora auth cli use` chooses the native
Claude/Codex/Grok identity for new Studio terminals. Existing Cora runs and
already-open terminals keep the account they started with.

Codara never reads, copies, or refreshes a credential for any of this: it points
directories, and the CLIs own everything inside them.

(An earlier build offered "Use the Active account in your terminal", which
sourced a generated env file from `~/.zshrc` / `~/.bashrc`. It was removed:
Claude Code stores its chats and settings in the redirected config directory,
so switching accounts made a plain `claude` lose them. Studio deletes the old
pointer files under `~/.codarastudio/cli/active/` on start, and Settings → Accounts
shows how to remove the leftover shell block if you had turned it on.)

`cora help` lists everything. The `app.*` RPC namespace (screenshots, in-page
evaluation, notifications — reachable via `cora rpc app.…`) is dev-gated:
always available in unpackaged builds, and in packaged builds only when the app
is launched with `CODARA_DEV_TOOLS=1` — a shipped app's socket must not let
another local process screenshot the user's terminals. Preview and run
commands work everywhere.

### Run terminal lifecycle

Temporary worker panes close automatically when a run settles. Service panes
remain until their run is deleted, and failed closes retry automatically.
