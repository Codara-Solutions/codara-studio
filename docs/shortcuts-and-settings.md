# Keyboard shortcuts and settings

## Shortcuts

Defaults from `src/renderer/src/shortcuts/commands.ts`. `Mod` is Cmd on macOS and Ctrl on Windows and Linux. Every command can be rebound or unbound in Settings, Keybindings; `Mod+Shift+/` opens the in-app cheat sheet. Commands with no default are reachable from menus and the command list only.

### General

| Action | Default | Command id |
|---|---|---|
| Show keyboard shortcuts | Mod+Shift+/ | `shortcuts.open` |
| Open settings | Mod+, | `settings.open` |
| Show run details | Mod+Shift+i | `session.openInspector` |

### Navigation

| Action | Default | Command id |
|---|---|---|
| Switch Cora run | Mod+k | `runSwitcher.open` |
| Open Automations | Mod+Shift+a | `automations.open` |
| Open Usage | Mod+Shift+u | `usage.open` |
| Open Cora Board | Mod+Shift+b | `board.open` |
| Focus chat composer | Mod+l | `composer.focus` |
| Search in files | Mod+Shift+f | `search.open` |

### View

| Action | Default | Command id |
|---|---|---|
| Toggle left sidebar | Mod+b | `sidebar.toggleLeft` |
| Toggle right sidebar | Mod+Alt+b | `sidebar.toggleRight` |
| Toggle terminal | Ctrl+Backtick | `terminal.toggle` |
| Zoom in | Mod+= or Mod+Shift+= | `view.zoomIn` |
| Zoom out | Mod+- or Mod+Shift+- | `view.zoomOut` |
| Reset zoom | Mod+0 | `view.zoomReset` |

### Terminal

| Action | Default | Command id |
|---|---|---|
| New terminal pane (equal sizes) | Mod+Alt+d | `terminal.newBalancedPane` |
| Split terminal pane right | Mod+d | `terminal.splitRight` |
| Split terminal pane down | Mod+Shift+d | `terminal.splitDown` |
| Close active terminal pane | (unbound) | `terminal.closePane` |
| Toggle terminal pane zoom | Mod+Shift+Enter | `terminal.toggleZoom` |

### Tabs

| Action | Default | Command id |
|---|---|---|
| Switch tab 1–9 | Mod+1 | `view.selectByIndex` |
| New chat | Mod+Alt+n | `chat.new` |
| New terminal tab | Mod+t | `tab.newTerminal` |
| Quick Open file | Mod+p | `tab.newEditor` |
| New browser tab | Mod+e | `tab.newPreview` |
| New whiteboard | Mod+Shift+w | `tab.newWhiteboard` |
| Close active tab | Mod+w | `tab.close` |
| Close other tabs | Mod+Alt+t | `tab.closeOthers` |
| Cycle to next tab | Ctrl+Tab | `tab.cycleNext` |
| Cycle to previous tab | Ctrl+Shift+Tab | `tab.cyclePrev` |

### Workers

| Action | Default | Command id |
|---|---|---|
| New Claude worker pane | (unbound) | `worker.newClaude` |
| New Codex worker pane | (unbound) | `worker.newCodex` |
| New Grok worker pane | (unbound) | `worker.newGrok` |
| Open Claude worker sessions… | (unbound) | `worker.claudeSessions` |
| Open Codex worker sessions… | (unbound) | `worker.codexSessions` |
| Open Grok worker sessions… | (unbound) | `worker.grokSessions` |

### Agent

| Action | Default | Command id |
|---|---|---|
| Cycle model | Mod+m | `agent.cycleModel` |
| Cycle thinking effort | Mod+n | `agent.cycleEffort` |
| Open model picker | Mod+Shift+m | `agent.openModelPicker` |
| Open thinking effort picker | Mod+Shift+n | `agent.openEffortPicker` |

## Settings tabs

Settings opens with `Mod+,` (`src/renderer/src/components/SettingsDialog.tsx`).

| Tab | What lives there |
|---|---|
| General | Appearance (theme, liquid glass surfaces), Window (keep running in the background when the window is closed, auto-open the browser for local dev servers), Agent sessions (resume on relaunch), Tabs (middle-click to close), Notifications (in-app toast, native OS notification, sound clip, OS-specific cues), Git (auto-fetch remotes, notify when teammates push, notify when a pull request is opened, instant git triggers), Copy-branch workspaces. |
| Editor | Code editor (Vim mode, autosave) and Inline AI autocomplete. |
| Default terminal | Default shell, resource overview, output history and scrollback lines, run terminal lifecycle for worker panes. |
| API and model | OpenRouter key and Git commit message generation. |
| Agents | Accounts (Cora subscriptions and the Claude, Codex, Grok CLI identities, which one is Active) and agent defaults. |
| Sessions | Agent sessions: resume running agent sessions when Codara reopens, session pickers. |
| Remote access | Phone pairing, paired devices, relay. |
| Keybindings | Rebind or unbind every command above. |
| Runs | All runs: browse, retain, delete. |
| About | Version and links. Dev builds show the tracked package.json version, not a release tag. |

The Capability Center (the "MCP and skills" button in the Cora composer) is a separate dialog for MCP servers, skills, Cora memory, worker models, and the session policy, including "Auto-install Codara Studio MCP" (`playwrightMcpAutoInstall`).
