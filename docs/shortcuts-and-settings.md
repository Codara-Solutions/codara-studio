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

Inside a browser tab the page gets a chord first, as in a browser. Codara
runs its own command only when the page did not handle the chord, so a site
whose Mod+K opens its own search keeps it. Mod+W and Ctrl+Tab always stay
Codara's. Keys an agent sends to a page never trigger Codara's shortcuts.

### General

| Action | Default | Command id |
|---|---|---|
| Show keyboard shortcuts | Mod+Shift+/ | `shortcuts.open` |
| Open settings | Mod+, | `settings.open` |
| Open Capability Center (tools, skills, memory) | (unbound) | `capabilities.open` |
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
| Point at an element to send to an agent (browser tab) | Mod+Shift+E | `browser.pickElement` |
| Comment on the browser page | Mod+Shift+X | `browser.comment` |

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
| Group active tab (or edit its group) | (unbound) | `tab.group` |
| Remove active tab from its group | (unbound) | `tab.ungroup` |

Tab groups work as in Chrome: a named, colored run of adjacent tabs. Right-click
a tab to add it to a new or existing group or remove it from one, or drag it
into or out of a group. The group's chip sits before its tabs: click it (or
Enter) to collapse the group to the chip and a tab count, and right-click it
(or Shift+F10) to rename it, change its color, ungroup it (the tabs stay) or
close it with its tabs, which asks first when a terminal would close with
them. Tab cycling skips the tabs of a collapsed group. Groups are saved with
each workspace's tabs. Agents put the tabs and terminals they open into a
group they name (`group` on the codara-studio tools, see
[mcp-tools.md](mcp-tools.md#tab-groups)); those groups are the same and can be
edited the same way.

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
| Stop Cora | Mod+. | `chat.stop` |

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

`chat.stop` does what the composer's stop button does in the visible Cora
chat: it ends the current turn and stops its live workers, keeping the
conversation and finished work. It does nothing when that chat is idle.

A message you send while Cora is working is queued (the send button reads
**Queue**) and goes to her when her next turn starts. Its bubble shows
**Queued** with two controls: **Send now** stops the current turn, keeping
what it already did and leaving workers running, and starts a new turn with
every queued message in the order you sent them; **Unqueue** takes the
message back into the composer. There is no setting for this.

Mod+F with focus in the Cora panel opens find for that conversation (Enter
and Shift+Enter step through matches, Escape closes it). It is not a
rebindable command; editors and terminals keep their own Mod+F.

On macOS, Electron's default menu also binds Cmd+M to Minimize; rebind
`agent.cycleModel` if the window minimizes instead.

## Settings

Open Settings with `Mod+,`. The sidebar groups the pages under Workspace,
Agents and models, and System, and its search box finds any setting by name
or keyword and scrolls to it. Settings closes with Escape, the close button,
Done, or Cancel and Save on pages with unsaved changes; a click outside the
dialog does nothing, so a stray click never drops what you were doing. The
Capability Center behaves the same way.

The pages:

| Tab | What lives there |
|---|---|
| General | Getting started (reopens the first-run guide), Appearance (theme, liquid glass surfaces), Window (keep running in the background when the window is closed, auto-open the browser for local dev servers, open links in the default browser or the Codara browser, the workspace switch badge), Agent worktrees (whether agents may create and remove worktrees, and remove ones you created), Tabs (middle-click to close), Notifications (in-app toast, native OS notification, sound, OS-specific cues), Git (background fetch, notify on teammate pushes and new pull requests), Instant git triggers, Copy-branch workspaces (a setup command for new worktrees, and extra ignored files an agent may delete with a merged worktree). |
| Editor | Code editor (Vim mode, autosave) and inline AI autocomplete. |
| Default terminal | The shell for new panes, a resource overview, output history and scrollback lines, and the run terminal lifecycle for worker panes. |
| API and model | An OpenRouter key, and how Git commit messages are generated. |
| Agents | Your accounts (see [accounts.md](./accounts.md)), **Install Pi** when Pi is not installed yet, and **Open Capability Center** and **Worker models** buttons, which close Settings and open the Capability Center on MCP servers or on worker models. |
| Sessions | Browse and resume Claude and Codex sessions from any local project, and choose whether running agent sessions (Claude Code, Codex, Grok and Pi panes) resume when Codara reopens. |
| Remote access | Turn phone access on, pair a device, and revoke paired devices (see [remote-access.md](./remote-access.md)). |
| Keybindings | Rebind or unbind every command above. |
| Runs | Every Cora run: browse, keep, delete. |
| About | Version and links. A development build shows the nearest release tag plus the commits since it. |

**Open links in** decides where a link you click opens: **Default browser**
(the default) hands it to your machine's browser, **Codara browser** opens it
in a browser tab of the current workspace. It covers links in terminals
(plain URLs and OSC 8 hyperlinks), Cora chat and markdown previews, the GitHub
panels, onboarding and Settings, and links the app window itself opens. Some
links keep a fixed destination whatever the setting says:

- Local `file:` links always open in Codara, because handing a file to the
  system would run it.
- **Open in Codara browser** actions (the file tree, **New browser tab**,
  dev-server auto-open) always use a Codara tab, and the browser toolbar's
  **Open externally** always uses your default browser.
- Links and `window.open` inside a page that is already in the Codara browser
  open a new Codara tab in that page's own workspace. Sign-in popups stay
  small windows attached to Codara.
- Agent browser tools (`codara_preview_*`) always drive Codara tabs.
- Sign-in flows (Pi subscription login) and URLs that a CLI in a terminal
  opens by itself (`gh auth login`, `xdg-open`, `open`) use your default
  browser.

The run terminal lifecycle works like this. Temporary worker panes close when
a run settles. Service panes remain until the run is deleted.
Failed closes retry automatically.

### Terminal agent notifications

When Claude Code, Codex, Grok or Pi runs in a terminal pane, Codara tells you
when a turn ends or the agent needs you. The Notifications switches in
General choose where these alerts appear (toast, system notification, sound).

- **Finished**: once per prompt you submit, when the agent's turn really
  ends (a subagent or background agent finishing does not count). The title names the agent and the tab (`Claude Code finished · api`), and
  the text quotes the agent's last message, how long the turn took, and how
  many background tasks are still running. When those tasks finish, one
  more alert says so.
- **Needs you**: a permission prompt, a question or a plan to review, with
  the tool or question named. It is separate from "finished" and appears
  again for each new prompt in the same turn.
- **Stopped**: the turn ended with an API error, or the agent exited with an
  error.
- Nothing is announced for a turn you interrupted with Esc or Ctrl+C, for
  what an agent does at launch, or while you watch the pane. A finished turn
  in a split you can see in the focused window counts as watched (not one
  hidden behind a zoomed split); a prompt there still alerts until you select
  that split.
- Clicking an alert opens the exact pane.

The signals come from the agents themselves: Claude Code's hooks and status
reports, and Codex's notify program and session file (see
[on-your-machine.md](./on-your-machine.md) for what Codara adds to your
config). Agents without those fall back to reading the screen.

### The notification center

The bell in the title bar keeps every alert, including the ones you did not
see because you were watching, Do Not Disturb was on, or the source was
muted. Its badge counts the questions you have not seen yet that are still
waiting on you (a Cora run, a terminal agent or an automation that needs you),
leaving out muted sources and questions whose pane or run is gone. The
**Needs you** tab and the pinned section count exactly the same rows. When
there are none, a dot means there are other unread alerts; teammate pushes
and muted sources do not light it.

- **Needs you** sits on top: the unseen questions, each with its action on
  the card (**Reply in terminal**, **Open run**, **Open automation**). A
  blocked Cora run or automation shows its answer options as buttons and a
  reply field, so you can answer without leaving what you are doing. An
  answered card stays where it is, turns green and says "Answer sent" until
  you close the panel; it no longer counts toward the badge. A question you
  have read or muted is still open but no longer pinned: it stays in its day
  with a **Waiting** tag and a quiet button, and the header says how many
  (for example "Needs you 6 · 9 seen"). A question stops waiting once its
  source moves on: the agent resumes, the run continues, finishes, is
  stopped, cancelled or deleted, the automation stops, or the pane closes.
  It then reads **Resolved**, or **Pane closed** when
  its pane is gone, and leaves the unread count. A terminal prompt from
  before a restart no longer counts.
- Below it the history is grouped by day, or by workspace with the folder
  button. Repeats from one source fold into one row: a prompt between two
  finished turns does not restart the count, and the last three distinct
  messages stay on the row (a bot's row reads "52 pushes to main,
  feature/sync" with **3 earlier** to expand). The same alert from several
  panes stacks under one heading such as "Claude Code finished 7× in
  api-server", which counts finished turns; the control under it counts the
  rows it opens ("Show 3 panes · 1 unread"). Pull requests stack as "Pull
  requests #41, #42 in api-server"; pushes stack only when the same people
  pushed to the same repository.
- Filters: **All**, **Needs you** and **Unread**. The filter and grouping are
  remembered.
- Clicking a row opens its exact pane, run or automation and marks it read.
  If the pane was closed or the run is no longer available, the row says so
  and opening it lands on its workspace instead; rows of a removed workspace
  open nothing. Opening the pane, run or automation yourself also marks its
  alerts read, except the messages of an automation's Notify steps.
- Hover a row for **Mark read** or **Mark unread**, **Mute** and
  **Dismiss**; they take the place of the time while the pointer is there.
  The mute menu picks how long first (**1 hour** or **Until morning**, the
  next 08:00), then what: this pane, run, automation or repository;
  the agent everywhere (**Claude Code everywhere**, **All Cora runs**, **All
  automations**); or everything in the workspace. A source that can never
  notify again, such as a closed pane or a finished run, is not offered.
  Muted sources still land in the history, silently; the footer lists active
  mutes with **Unmute**. **Clear all** removes everything except the
  questions still waiting, and says how many it keeps. **Clear all** and
  **Dismiss** can be undone for a few seconds; removals made while the undo
  bar shows are undone together.
- Keys, with the list focused: Up and Down (or J and K), Home and End, Enter
  to open, R to toggle read, M to open the mute menu (arrows move in it,
  Enter picks, Tab leaves it), Delete to dismiss, Right and Left to show or
  hide earlier messages. Escape closes the menu, then leaves a reply field, then closes
  the panel and returns focus to the bell.

The history keeps 200 rows. When it is full the oldest read row goes first,
and an open question goes last, even once read. A question superseded by a
newer alert from the same source (the run failed, the pane asked again)
reads **Resolved**. Read rows are dropped after 7 days and any
row after 30 days; a question still waiting on you keeps the 30 days even
once read. It is saved in `notifications.json` and the mutes in
`notification-mutes.json` (see [on-your-machine.md](./on-your-machine.md)).

### Automation precheck and missed runs

These two settings belong to each automation, not to the Settings dialog: open
the automation in the editor and select its trigger. The cron and interval
triggers show both; the folder, git, "After automation" and "Automation
activity" triggers show only the precheck. Manual and continuous triggers show
the precheck only with a cadence loop, whose later passes it checks.

**Before each run** takes an optional shell command. It runs in the
workspace folder before every pass that the trigger starts (and before every
pass of a cadence loop). Exit code 0 runs the pass. Any other exit code, a
timeout (1 to 600 seconds, 60 by default) or a command that cannot start skips
the pass: no agent starts and no tokens are spent, and the automation's
history shows a **skipped** row with the reason and the last lines the
command printed. The same skip again, with no pass in between, updates that
row and counts it ("skipped 12 times") instead of adding one, so a check that
often says "nothing to do" does not bury the real passes. **Run now** never
runs the check, and neither do the later passes of a loop that already started
(a cadence loop aside). **Test check** runs the command once,
right away, and says whether the pass would run. The command gets
`SPARK_AUTOMATION_ID` and `CODARA_AUTOMATION_PRECHECK=1`. It runs in your login
shell on macOS and Linux, and in Command Prompt on Windows, where a
**PowerShell** choice is also offered. A check on several lines runs them in
order and the last line's exit code decides (Command Prompt gets them joined
with `&`).

**If a run was missed** decides what happens to a scheduled time that passed
while Codara was closed or the computer was asleep. Codara checks when it
starts and when the computer wakes up, and never starts more than one pass to
catch up, however many times were missed.

- **Skip it** (the default) starts nothing and adds one **skipped** row that
  says how many times were missed.
- **Run once when back** starts one pass, marked **caught up** in the history,
  if the latest missed time is recent enough (12 hours by default, up to 7
  days). An older one is skipped and recorded the same way.

A scheduled time that passed less than 2 minutes before the computer woke up
is not missed: it runs as usual, and the earlier times of the same sleep are
not reported.

A paused or turned-off automation has no missed runs: turning one back on, or
changing its schedule, starts counting from that moment. Before this setting
existed, a cron trigger fired once, late, after the computer woke up; it now
follows the policy above, so an automation that should run after a sleep
needs **Run once when back**.

## The Capability Center

The Capability Center is where you decide what Cora, its workers and your
CLIs can use. Open it from the **Tools** button in the Cora composer, the
**Open Capability Center** button in Settings > Agents, the profile menu in
the composer (**New profile**), or the `capabilities.open` command (unbound
by default; bind it in Keybindings). It has six sections:

| Section | What lives there |
|---|---|
| Tools (MCP servers) | Your MCP servers, one row per name. **Cora** and **Workers** switch a server on for Cora and for Pi workers; the **Claude CLI**, **Codex CLI** and **Grok Build** columns show whether that CLI loads it, with **Add** to copy it there. Each row says what Cora and workers actually get, has **Test** (starts the server once and lists its tools), **Edit** and **Remove**. The built-in Codara Studio server sits on top with an on/off switch per CLI; switching it off removes Codara's entry from that CLI's config, and it stays off across restarts. |
| Skills | The skills agents can load, with a switch for Cora and workers and the same CLI columns. |
| Profiles | Separate Coras with their own instructions and memory: create one, edit its instructions (`PROFILE.md`), make it the default for new chats, or delete it. A new chat (including a board chat with no messages yet) picks its profile from the composer's profile menu; a started chat shows its profile as a chip that opens it here, and keeps it. |
| Memory | What Cora remembers for the profile you pick, globally and for this workspace. Global memory is the master switch: while it is off, workspace memory is off too and says so. **Open in editor** creates the file if nothing was remembered yet. |
| Worker models | Which models Cora may pick for its workers. Cora only uses a model whose provider has a signed-in account; the others are marked **Not signed in**. The last usable model cannot be switched off; an OpenRouter model only counts once its key is verified. |
| Behavior | Settings that apply to all workspaces. **Always verify edits with a worker** (`coraAlwaysVerifyEdits`, off by default): off, Cora makes small, low-risk edits (one to three files) herself and replies directly; on, every project change goes through a worker and a verifier on another provider. It applies the next time Cora starts in a chat. Then three worker and CLI switches: mention MCP servers in worker prompts (`agentMcpSyncEnabled`), mention skills in worker prompts (`agentSkillSyncEnabled`), and **Codara tools in other apps** (`studioToolsInOtherApps`, off by default), which also adds the `codara-studio` MCP server to your global Claude Code and Codex config so sessions outside Codara can use it; sessions Codara starts get it either way. |

Every switch applies as soon as you flip it; there is no Save step and
nothing to lose by closing. Forms you type into (a server you are adding or
editing, a new profile, profile instructions) ask before Escape, a click
outside or **Done** throws away what you typed.

**Add server** asks for the server once and where it should be available:
Cora, Pi workers, and which CLIs (Claude, Codex, Grok) for every workspace or
this one. You can paste what a README publishes instead of typing: an
`mcpServers` JSON block or one entry of it, a Codex `[mcp_servers.name]`
table, a `claude mcp add`, `claude mcp add-json` or `codex mcp add` command,
or a bare command line. **Test connection** starts the server before you save
and lists its tools. Values that look like secrets are masked until you
reveal them. Editing a server that several files define opens the copy Cora
uses and offers to update the other copies too. When the copies disagree, the
row carries a **copies differ** badge whose tooltip names the file Cora uses.

The tools the built-in server provides are listed in
[mcp-tools.md](./mcp-tools.md).

### Where your MCP servers live

The Capability Center reads and edits each CLI's own config file, so a server
you add is the same entry the CLI would write itself:

- **Every workspace** saves to your private user config: `~/.claude.json`,
  `~/.codex/config.toml` or Grok's `config.toml`. This is the default.
- **This workspace, Claude (private)** saves to your own `~/.claude.json`
  under this folder only, the way `claude mcp add` does in local scope.
  Servers other projects keep there are never listed or changed.
- **Project `.mcp.json`** and the project's `.codex/config.toml` are usually
  committed to git. A value that looks like a secret (a token, key or
  password, or an `Authorization` header) is refused there: write it as
  `${VAR}` and set `VAR` in your environment, or pick a private location.

Editing a Codex or Grok server rewrites only the command, arguments,
environment, URL and headers. Other keys such as `cwd`,
`startup_timeout_sec`, `enabled` or per-tool tables stay as you wrote them,
and the rest of the file is untouched. Codex headers are read from
`http_headers`, `env_http_headers` and `bearer_token_env_var`. Grok's
`config.toml` cannot carry request headers, so a server that needs them stays
in a Claude or Codex config.

**Sync Claude and Codex** first lists what it would copy and writes nothing
until you confirm. It keeps scope: the servers in your user `~/.codex/config.toml` are
copied to your user `~/.claude.json`, and the project's `.mcp.json` servers
to the project's `.codex/config.toml`. A Codex server turned off with
`enabled = false` is not copied, because Claude has no such switch. A secret
copied into a project file becomes a `${VAR}` placeholder and the sync
summary names the variable to set. **Add** in a CLI column adds the server
to your user config there; a name that already exists is left alone.

### What reaches Cora

Servers switched on for Cora or for Pi workers are handed to Pi when a
session starts, up to 16 per session. An open Cora chat picks up servers you
add, change or remove on your next message, without a restart. A server that
signs in through Claude's OAuth login cannot be used from Cora; give it an
`Authorization` header instead.

Skills reach Cora too. Cora loads the skills kept in `.pi/skills`,
`.agents/skills`, the workspace's `.claude/skills` and `.codex/skills`, and
your user skill folders for Pi, Claude and Codex. A skill switched off here
is not loaded by new Cora sessions. Removing a skill moves its folder to the
trash.
