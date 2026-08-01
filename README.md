# Codara Studio

Desktop control surface (Electron) for supervising AI coding agents — terminals,
runs, automations, and a built-in browser Preview.

- Product overview: [`PRODUCT.md`](./PRODUCT.md)
- Visual/design system: [`DESIGN.md`](./DESIGN.md)

## Preview browser-use

Codara ships a zero-install browser-use / computer-use surface: the built-in
**Preview** tab is a real Chromium `<webview>`, and any manually-run or
orchestrated `claude` / `codex` CLI can drive it through the bundled
`cora-preview` MCP server. No Playwright, no headless Chrome, no extra browser
window — the agent acts on the exact pixels and DOM the user sees.

The server is auto-installed into `~/.claude.json` and `~/.codex/config.toml`
(toggle: **Settings → Capabilities**, or `playwrightMcpAutoInstall`). When the
`claude` / `codex` binary is detectable on disk, Codara creates the config entry
even if the CLI has never been launched. It proxies each tool call back to the
running app over a loopback HTTP + bearer-token channel described by
`<spark-home>/agent-socket.json`.

### Using it

1. **The Codara app must be running.** The MCP server reads the handshake file on
   every call; if Codara is closed the tool returns a clean "Codara appears to
   be offline" error instead of hanging.
2. **First call `spark_preview_navigate({ url })`.** It auto-creates the preview
   tab if none is open — you do not have to ask the user to open one. Subsequent
   calls default to the active preview tab (pass `tabId` to target a specific
   one; `spark_preview_list` enumerates them).
3. **Screenshots return inline images.** `spark_preview_screenshot` (and any
   `screenshot` step in `spark_preview_run`) return the PNG as an inline image
   block, so the agent can literally look at the rendered UI.

### Tools

Discovery / DOM:
`spark_preview_list`, `spark_preview_url`, `spark_preview_navigate`,
`spark_preview_snapshot`, `spark_preview_evaluate`, `spark_preview_wait_for`,
`spark_preview_screenshot`.

Input:
`spark_preview_click`, `spark_preview_type`, `spark_preview_press_key`.

Batch:
`spark_preview_run` executes an ordered batch of steps in a single round-trip —
strongly preferred for multi-step verification flows (drive `7 / 2 =` and read
the display in one call, not seven).

## The `cora` CLI

`bin/cora.cjs` is a zero-dependency terminal remote for the running app — the
fastest way to poke a new feature without a Playwright harness. It discovers
the app exactly like the MCP servers do (reads `~/.Codara/agent-socket.json`,
speaks bearer-authed JSON-RPC to the loopback socket).

```sh
npm link                 # once — gives you a global `cora`
cora status              # is the app up? version, home dir, windows
cora shot ui.png         # screenshot the app window itself
cora eval 'document.title'
cora notify run.complete --title "Done" --body "It works"
cora glass refraction 140   # tune liquid glass live; also veil/blur/chroma
cora open localhost:5173    # drive the built-in Preview…
cora pshot page.png         # …and look at it
cora runs                # list runs straight off disk (works app-closed)
cora rpc preview.list    # raw JSON-RPC escape hatch (any method)
```

### Using a Codara account in your own terminal

Every account you add in **Settings → Accounts** has its own private login
directory, and one account per CLI is marked **Active**. Turning on *"Use the
Active account in your terminal"* (same panel) makes a plain `claude` or `codex`
in a new terminal window sign in as that account instead of the login your
terminal had before.

How it works: Codara keeps two stable pointers plus a generated env file under
`~/.Codara/cli/active/`, and appends a marked block to your `~/.zshrc` (or
`~/.bashrc`) that sources it. A copy of the original file is kept once, and
turning the setting off removes exactly that block. The pointers are rebuilt
whenever the Active account changes and every time the app starts, so deleting
the Active account falls back to your own login rather than dangling.

```sh
cora accounts cli    # which accounts exist, and which is Active (works app-closed)
```

Two details worth knowing:

- **Codex** follows the pointer live — switching the Active account applies to
  terminals you already have open, because `CODEX_HOME` is exported as the
  symlink and Codex re-reads it on every run.
- **Claude Code** is pinned when the shell starts. `CLAUDE_CONFIG_DIR` is
  exported as the resolved account directory, not the symlink, because Claude
  Code derives its macOS Keychain item from that exact string — a shared
  symlink path would put every account in one credential slot. Open terminals
  keep the account they started with; new ones pick up the current Active
  account.
- When the Active account is your **existing terminal login**, nothing is
  exported at all. For Claude Code an exported path is never equivalent to an
  unset one, so unset is the only setting that keeps your original sign-in.

Codara never reads, copies, or refreshes a credential for any of this: it points
directories, and the CLIs own everything inside them.

`cora help` lists everything. The app-level commands (`shot`, `eval`, `notify`,
`prefs`, `glass`) ride the dev-gated `app.*` RPC namespace: always available in
unpackaged builds, and in packaged builds only when the app is launched with
`CODARA_DEV_TOOLS=1` — a shipped app's socket must not let another local process
screenshot the user's terminals. Preview and run commands work everywhere.

### Run terminal lifecycle

Temporary worker panes close automatically when a run settles. Service panes
remain until their run is deleted, and failed closes retry automatically.
