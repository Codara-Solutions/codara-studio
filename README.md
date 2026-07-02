# Spark Agent

Desktop control surface (Electron) for supervising AI coding agents — terminals,
runs, automations, and a built-in browser Preview.

- Product overview: [`PRODUCT.md`](./PRODUCT.md)
- Visual/design system: [`DESIGN.md`](./DESIGN.md)

## Preview browser-use

Spark ships a zero-install browser-use / computer-use surface: the built-in
**Preview** tab is a real Chromium `<webview>`, and any manually-run or
orchestrated `claude` / `codex` CLI can drive it through the bundled
`spark-preview` MCP server. No Playwright, no headless Chrome, no extra browser
window — the agent acts on the exact pixels and DOM the user sees.

The server is auto-installed into `~/.claude.json` and `~/.codex/config.toml`
(toggle: **Settings → Capabilities**, or `playwrightMcpAutoInstall`). When the
`claude` / `codex` binary is detectable on disk, Spark creates the config entry
even if the CLI has never been launched. It proxies each tool call back to the
running app over a loopback HTTP + bearer-token channel described by
`<spark-home>/agent-socket.json`.

### Using it

1. **The Spark app must be running.** The MCP server reads the handshake file on
   every call; if Spark is closed the tool returns a clean "Spark App appears to
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
