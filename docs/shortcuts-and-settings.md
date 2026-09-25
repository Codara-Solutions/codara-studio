# Keyboard shortcuts and settings

This page lists every keyboard command with its default chord, then walks
through the tabs of the Settings dialog and the separate Capability Center so
you know where each option lives. Press `Mod+Shift+/` in the app for the same
shortcut list as a cheat sheet.

## Shortcuts

`Mod` is Cmd on macOS and Ctrl on Windows and Linux. Every command can be
rebound or unbound in Settings, **Keybindings**. A command marked "(unbound)"
has no default chord; bind one there to use it from the keyboard. The defaults
come from `src/renderer/src/shortcuts/commands.ts`, and the command id is what
the Keybindings tab and that file call it.

### General

| Action | Default | Command id |
|---|---|---|
| Show keyboard shortcuts | Mod+Shift+/ | `shortcuts.open` |
| Open settings | Mod+, | `settings.open` |
| Show run details | Mod+Shift+I | `session.openInspector` |

### Navigation

| Action | Default | Command id |
|---|---|---|
| Switch Cora run | Mod+K | `runSwitcher.open` |
| Open Automations | Mod+Shift+A | `automations.open` |
| Open Usage | Mod+Shift+U | `usage.open` |
| Open Cora Board | Mod+Shift+B | `board.open` |
| Focus chat composer | Mod+L | `composer.focus` |
| Search in files | Mod+Shift+F | `search.open` |

### View

| Action | Default | Command id |
|---|---|---|
| Toggle left sidebar | Mod+B | `sidebar.toggleLeft` |
| Toggle right sidebar | Mod+Alt+B | `sidebar.toggleRight` |
| Toggle terminal | Ctrl+Backtick (Ctrl on every platform) | `terminal.toggle` |
| Zoom in | Mod+= or Mod+Shift+= | `view.zoomIn` |
| Zoom out | Mod+- or Mod+Shift+- | `view.zoomOut` |
| Reset zoom | Mod+0 | `view.zoomReset` |
| Toggle markdown preview | Mod+Shift+V | `markdown.togglePreview` |

### Tabs

| Action | Default | Command id |
|---|---|---|
| Switch to tab 1 to 9 | Mod+1 ... Mod+9 (fixed) | `view.selectByIndex` |
| New chat | Mod+Alt+N | `chat.new` |
| New terminal tab | Mod+T | `tab.newTerminal` |
| Quick Open file | Mod+P | `tab.newEditor` |
| New browser tab | Mod+E | `tab.newPreview` |
| New whiteboard | Mod+Shift+W | `tab.newWhiteboard` |
| Close active tab | Mod+W | `tab.close` |
| Close other tabs | Mod+Alt+T | `tab.closeOthers` |
| Cycle to next tab | Ctrl+Tab | `tab.cycleNext` |
| Cycle to previous tab | Ctrl+Shift+Tab | `tab.cyclePrev` |

### Terminal

| Action | Default | Command id |
|---|---|---|
| New terminal pane (equal sizes) | Mod+Alt+D | `terminal.newBalancedPane` |
| Split terminal pane right | Mod+D | `terminal.splitRight` |
| Split terminal pane down | Mod+Shift+D | `terminal.splitDown` |
| Close active terminal pane | (unbound) | `terminal.closePane` |
| Toggle terminal pane zoom | Mod+Shift+Enter | `terminal.toggleZoom` |

Mod+W already closes just the selected pane when a terminal tab has more than
one, so `terminal.closePane` only matters if you want a separate chord.

### Workers

"New ... worker pane" starts a fresh session right away. "Open ... worker
sessions" shows the workspace's recent sessions so you can resume one. None of
these has a default chord.

| Action | Default | Command id |
|---|---|---|
| New Claude worker pane | (unbound) | `worker.newClaude` |
| New Codex worker pane | (unbound) | `worker.newCodex` |
| New Grok worker pane | (unbound) | `worker.newGrok` |
| New Pi worker pane | (unbound) | `worker.newPi` |
| Open Claude worker sessions... | (unbound) | `worker.claudeSessions` |
| Open Codex worker sessions... | (unbound) | `worker.codexSessions` |
| Open Grok worker sessions... | (unbound) | `worker.grokSessions` |

### Agent

| Action | Default | Command id |
|---|---|---|
| Cycle model | Mod+M | `agent.cycleModel` |
| Cycle thinking effort | Mod+N | `agent.cycleEffort` |
| Open model picker | Mod+Shift+M | `agent.openModelPicker` |
| Open thinking effort picker | Mod+Shift+N | `agent.openEffortPicker` |

The two cycle chords follow what you are looking at:

- **Over a Cora chat** they act like clicking the model and effort pills in
  the composer.
- **Over a terminal pane running an agent** they type that CLI's own command:
  `/model` for the model, `/effort` for the effort. Codex has no effort
  command, so the effort chord opens its `/model` picker, where Codex sets
  reasoning depth. Pi calls it a thinking level and gets `/thinking`; a Pi
  pane takes both chords as soon as Pi is detected in it. For Claude Code,
  Codara first sends Ctrl+S (Claude Code's stash) so a half-written message
  is parked instead of being submitted with the command glued on; Claude
  Code restores it when the picker closes.

The two picker chords always open the pickers of a Cora chat.

On macOS, Electron's default menu also binds Cmd+M to Minimize; rebind
`agent.cycleModel` if the window minimizes instead.

## Settings

Open Settings with `Mod+,`. The tabs, top to bottom:

| Tab | What lives there |
|---|---|
| General | Getting started (reopens the first-run guide), Appearance (theme, liquid glass surfaces), Window (keep running in the background when the window is closed, auto-open the browser for local dev servers), Agent sessions (resume on relaunch), Tabs (middle-click to close), Notifications (in-app toast, native OS notification, sound, OS-specific cues), Git (background fetch, notify on teammate pushes and new pull requests), Instant git triggers, Copy-branch workspaces (a setup command for new worktrees). |
| Editor | Code editor (Vim mode, autosave) and inline AI autocomplete. |
| Default terminal | The shell for new panes, a resource overview, output history and scrollback lines, and the run terminal lifecycle for worker panes. |
| API and model | An OpenRouter key, and how Git commit messages are generated. |
| Agents | Your accounts (see [accounts.md](./accounts.md)), **Install Pi** when Pi is not installed yet, and a note pointing to the Capability Center for MCP servers and skills. |
| Sessions | Browse and resume Claude and Codex sessions from any local project, and choose whether running agent sessions (Claude Code, Codex, Grok and Pi panes) resume when Codara reopens. |
| Remote access | Turn phone access on, pair a device, and revoke paired devices (see [remote-access.md](./remote-access.md)). |
| Keybindings | Rebind or unbind every command above. |
| Runs | Every Cora run: browse, keep, delete. |
| About | Version and links. A development build shows the nearest release tag plus the commits since it. |

The run terminal lifecycle works like this. Temporary worker panes close when
a run settles. Service panes remain until the run is deleted.
Failed closes retry automatically.

## The Capability Center

The **MCP and skills** button in the Cora composer opens the Capability
Center, a separate dialog with five tabs:

| Tab | What lives there |
|---|---|
| MCP servers | Your MCP servers, and the built-in Codara Studio server with an on/off switch per CLI (Claude, Codex, Grok). Switching it off for a CLI removes Codara's entry from that CLI's config, and it stays off across restarts. |
| Skills | The skills agents can load. |
| Memory | What Cora remembers, globally and per workspace. |
| Worker models | Which models Cora may pick for its workers. |
| Policy | Session policy: MCP awareness, skill awareness, and **Auto-install Codara Studio MCP**, which keeps the built-in server current in each CLI on launch (setting key `playwrightMcpAutoInstall`). |

The tools the built-in server provides are listed in
[mcp-tools.md](./mcp-tools.md).
