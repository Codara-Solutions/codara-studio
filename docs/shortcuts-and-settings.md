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
the Keybindings tab and that file call it. A chord you bind yourself wins over
a default on the same keys, so a default added in an update never takes over
a chord you already use.

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
| Clean up worktrees | (unbound) | `worktrees.cleanup` |
| Show run details | Mod+Shift+I | `session.openInspector` |

### Navigation

| Action | Default | Command id |
|---|---|---|
| Switch Cora run | Mod+K | `runSwitcher.open` |
| Jump to a workspace, tab or agent | Cmd+J on macOS, Ctrl+Shift+J on Windows and Linux | `jump.open` |
| Switch to workspace 1 to 9 | Ctrl+1 ... Ctrl+9 on macOS, Alt+1 ... Alt+9 on Windows and Linux | `workspace.selectByIndex` |
| Back to the previous workspace | Cmd+Option+Left on macOS, Alt+[ on Windows and Linux | `workspace.back` |
| Forward to the next workspace | Cmd+Option+Right on macOS, Alt+] on Windows and Linux | `workspace.forward` |
| Open Automations | Mod+Shift+A | `automations.open` |
| Open Usage | Mod+Shift+U | `usage.open` |
| Review changes | (unbound) | `review.open` |
| Open Cora Board | Mod+Shift+B | `board.open` |
| Focus chat composer | Mod+L | `composer.focus` |
| Search in files | Mod+Shift+F | `search.open` |

#### The jump palette

`jump.open` opens one search over every workspace, every open terminal,
editor, diff and browser tab, and every agent pane, in all workspaces at
once. With nothing typed, the rows that need you come first (an agent waiting
on an answer, or a workspace whose Cora run is blocked), then agents that
finished while you were elsewhere, then everything by when you last used it.
Typing filters by name first, then by path, URL, branch and workspace, and
also matches initials and skipped letters, so `fa` finds `fix-auth`.

- Enter opens the selected row: it switches workspace if needed, selects the
  tab and, for a terminal pane, a file or a browser tab, puts the keyboard in
  it.
- Mod+1 to Mod+6 open the first six rows directly.
- Arrow keys, Page Up and Page Down move the selection. Esc, a click outside
  or the palette's own chord closes it and gives the keyboard back to where it
  was.
- A name nothing goes by yet offers **Create worktree** with that name as the
  branch. It runs the same creation as the rail's "Create isolated worktree"
  next to the repository of the workspace on screen, and opens that dialog
  with git's message if it fails. One worktree is created at a time. SSH
  workspaces do not offer it.

The rows are read when the palette opens and stay put while it is open. A
tab closed in the meantime is not selected; a toast says so.
Tabs of a workspace you have not opened since Codara started are not listed
yet; its workspace row is.

#### Workspace 1 to 9, back and forward

`workspace.selectByIndex` counts the workspaces as the rail shows them, top
to bottom, with each folder's workspaces in place and the workspaces of a
collapsed folder skipped. It is a range: in Keybindings you record the
modifiers with any digit, and they then apply to 1 to 9. The range needs Ctrl,
Alt or Cmd so the digits keep typing numbers. The digit is read from the key's
position too, so it works on layouts like AZERTY where the digit row types
symbols. With Alt held only the digit row counts: Alt plus numpad digits types
a character by its code on Windows (Alt+0233 is é).

Back and forward walk the workspaces you have been in, like a browser's
history. A workspace deleted since is skipped.

Why these defaults: Ctrl+J is a new line in a terminal (Claude Code and Pi
use it), so Windows and Linux open the palette with Ctrl+Shift+J. Ctrl+Alt is
AltGr on Windows, which types characters like @ and #, so the workspace range
there is Alt+digit. Ctrl+Alt+Left and Right switch desktops on GNOME,
Cinnamon and Xfce and Alt+Left and Right move by word, hence Alt+[ and Alt+].
On a layout without [ and ] keys, rebind back and forward in Keybindings.

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
| Switch to tab 1 to 9 | Mod+1 ... Mod+9 (fixed; on macOS Cmd only, since Ctrl+1 ... Ctrl+9 switch workspaces) | `view.selectByIndex` |
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
| Copy terminal context | (unbound) | `terminal.copyContext` |
| Run a quick command | Mod+Shift+P | `quickCommands.open` |

Mod+W already closes just the selected pane when a terminal tab has more than
one, so `terminal.closePane` only matters if you want a separate chord.

`terminal.copyContext` does what the pane toolbar's **Copy terminal context**
button does (see [Terminal clipboard, links and context](#terminal-clipboard-links-and-context)).
It has no default chord because the free Ctrl+Alt letters type characters
through AltGr on many keyboard layouts, and a terminal must keep receiving
them.

Run a quick command opens the palette of your saved commands (see
[Quick commands](#quick-commands)): type to filter, Enter runs the selected
one, Shift+Enter edits it.

### Workers

"New ... worker pane" starts a fresh session right away. To resume an earlier
session, search for it in the rail's Sessions view, or type in the jump
palette and pick "Search agent sessions" (see
[Agent session search](agent-session-search.md)). None of these has a default
chord.

| Action | Default | Command id |
|---|---|---|
| New Claude worker pane | (unbound) | `worker.newClaude` |
| New Codex worker pane | (unbound) | `worker.newCodex` |
| New Grok worker pane | (unbound) | `worker.newGrok` |
| New Pi worker pane | (unbound) | `worker.newPi` |

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

Open Settings with `Mod+,`. The sidebar groups the pages under App,
Workspace, Agents and models, and System, and its search box finds any setting by name
or keyword and scrolls to it. Settings closes with Escape, the close button,
Done, or Cancel and Save on pages with unsaved changes; a click outside the
dialog does nothing, so a stray click never drops what you were doing. The
Capability Center behaves the same way.

The pages:

| Tab | What lives there |
|---|---|
| General | Getting started (reopens the first-run guide, turns feature tips on or off, and lets tips you have seen come back), Window (keep running in the background when the window is closed, middle-click to close tabs, the workspace switch badge), Sleep (keep the computer awake while agents work, always or never, and on a Linux laptop with the lid closed; see [Keep the computer awake](#keep-the-computer-awake)). |
| Appearance | Theme, and Glass (liquid glass for menus, popovers, toasts and dialogs, with tint, blur, refraction and fringe under **Fine-tune glass**). |
| Notifications | In the app (toast and how long it stays), On your computer (native OS notification, sound, dock badge and taskbar flash). |
| Editor | Code editor (Vim mode, autosave) and inline AI autocomplete. |
| Terminal | The shell for new panes, output history and scrollback lines, whether programs may copy to the clipboard (OSC 52), a resource overview, and the run terminal lifecycle for worker panes. |
| Quick commands | Saved shell commands and agent prompts: add, edit, reorder, delete, and where each is offered. Also what a right-click in a terminal does. See [Quick commands](#quick-commands). |
| Git | Remotes (background fetch, Instant git triggers, and a custom webhook receiver under Advanced), Alerts (notify on teammate pushes, new pull requests, and CI failing on your pull request), Worktrees (whether agents may create and remove worktrees, and remove ones you created, the repository's worktree setup file, and under Advanced your own setup command for new worktrees and extra ignored files an agent may delete with a merged worktree). |
| Browser | Links (auto-open the browser for local dev servers, open links in the default browser or the Codara browser, ask where terminal links open), and the Chrome extension (**Keep agents in your Chrome**, link status, pairing, paired browsers, agent activity). |
| Shared pages | The links you shared from the editor: copy one, change when it expires, or delete it (see [share-links.md](./share-links.md)). |
| API and model | An OpenRouter key, and how Git commit messages are generated. |
| Agents | Your accounts (see [accounts.md](./accounts.md)), **Install Pi** when Pi is not installed yet, and **Open Capability Center** and **Worker models** buttons, which close Settings and open the Capability Center on MCP servers or on worker models. |
| Sessions | Turn agent session search on or off and choose what it indexes (see [agent-session-search.md](./agent-session-search.md)), browse and resume Claude and Codex sessions from any local project, choose whether running agent sessions (Claude Code, Codex, Grok and Pi panes) resume when Codara reopens, whether terminal panes keep their output across restarts (**Keep terminal output across restarts**, on by default), and how long an idle agent in a background workspace may wait before it sleeps (**Let idle agents sleep**, see below). |
| Remote access | Turn phone access on, pair a device, and revoke paired devices (see [remote-access.md](./remote-access.md)). |
| Keybindings | Rebind or unbind every command above. |
| Runs | Every Cora run: browse, keep, delete. |
| About | Version and links (a development build shows the nearest release tag plus the commits since it), and Diagnostics: the freezes and crashes recorded on this computer, and **Export diagnostics**. |

**Open links in** decides where a link you click opens: **Default browser**
(the default) hands it to your machine's browser, **Codara browser** opens it
in a browser tab of the current workspace. It covers links in terminals
(plain URLs and OSC 8 hyperlinks, on Ctrl or Cmd+click or when **Ask where
terminal links open** is off), Cora chat and markdown previews, the GitHub
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

### Terminal clipboard, links and context

**Links.** A plain click on a link in a terminal (a plain URL or an OSC 8
hyperlink) opens a small menu: **Open in Codara browser**, **Open in default
browser** and **Copy link**. A `file:` link offers **Open in Codara** and
**Copy link**, a `mailto:` link **Open in mail app** and **Copy link**, and
any other scheme only **Copy link**. Ctrl+click (Cmd+click on macOS; either
works everywhere) skips the menu and opens the link where **Open links in**
says. Dragging across a link selects text and opens nothing. The menu works
from the keyboard (arrows, Home, End, Enter, Escape) and gives focus back to
the terminal when it closes. Turn off **Ask where terminal links open** in
Browser, Links, to open links on a plain click as before.

**Copies from programs (OSC 52).** tmux, Neovim and programs on a machine you
reach over SSH can put text on this computer's clipboard with the OSC 52
escape sequence. **Let programs copy to the clipboard** on the Terminal
page (on by default, applied when you save) allows it, up to about
768 KB per copy. Programs can never read the clipboard this way: a request to
read it is ignored. A copy is also ignored when it comes from output written
back into a pane (a restored or reattached terminal), from a pane that is not
on screen, or from a pane you cannot type into. With the setting off, the
first refused copy shows a "Terminal copy blocked" notice. For tmux, set
`set -g set-clipboard on`; Neovim 0.10 and later uses OSC 52 on its own
over SSH.

**Copy terminal context.** The button in the pane toolbar, or the
`terminal.copyContext` command, copies up to the pane's last 200 lines of output (or
the selection, when there is one) with its working directory and shell, as a
block ready to paste into an agent. The working directory is the one the
shell last reported, or the folder the pane opened in when the shell does not
report it.

**Character widths.** Terminals measure characters with the Unicode 11
tables, so an emoji or a CJK character takes two cells, as Claude Code,
Codex, tmux and Neovim expect, and boxes drawn around them line up. Emoji
joined into one picture (a family, or an emoji with a skin tone) can still
take more cells than they show.

### Keep the computer awake

Long agent runs stop when the computer goes to sleep. The cup beside the
system meters in the title bar shows what Codara does about it, and a click
on it picks the mode. The same choice is in Settings, General, **Sleep**
(search "keep awake" or "sleep").

- **While agents work** (the default) keeps the computer awake while
  something works: a Claude Code, Codex, Grok or Pi pane in the middle of a
  turn, a Cora chat with a turn or a worker running, an automation or
  workflow, or a worker. A terminal agent that has printed nothing for 30
  minutes stops counting. Once the last one finishes, the computer can sleep
  again.
- **Always** keeps it awake whenever Codara is open.
- **Off** leaves sleep to your system settings.

The cup is lit, with steam, while Codara holds the computer awake, plain
while it waits for work, and crossed out when the mode is Off. Its tooltip
and the popover say what is working right now. The cup and the popover work
from the keyboard: Tab to the cup, Enter to open, the arrow keys to choose a
mode, Escape to close.

Only idle sleep is held off. The screen can still turn off and lock, and you
can still put the computer to sleep yourself. Codara asks the system through
Electron's `powerSaveBlocker` (`prevent-app-suspension`): an idle sleep
assertion on macOS, a power request on Windows (`powercfg /requests` lists
it), a sleep inhibitor on Linux. The hold belongs to the Codara process, so it ends when Codara
quits or crashes; Codara also drops it as it quits. After the computer wakes
from a sleep it could not prevent (a closed lid, a critical battery), Codara
takes the hold again.

**Keep awake with the lid closed** (off by default) appears only on a Linux
laptop running systemd, the one place a closed lid can be held without admin
rights or a change to a system setting. While Codara holds the computer
awake, it also runs `systemd-inhibit --what=sleep:handle-lid-switch
--mode=block cat`, so closing the lid does not suspend the laptop
(`systemd-inhibit --list` shows it as Codara Studio). The helper waits on a
pipe from Codara and exits the moment Codara goes away, even if Codara is
killed. While that lock is held it also holds off a suspend you start
yourself: the system may refuse it or ask for an administrator password, so
turn the option off or quit Codara first. If the system refuses the lock,
Codara says so in the popover and Settings and tries again later, waiting
longer each time. A closed laptop on battery keeps draining. On macOS and Windows a closed
laptop sleeps unless an administrator changes a power setting, so the option
is hidden there.

### Fix with agent

Source Control can hand a problem to an agent with what it needs to fix it:

- **Fix checks with agent** on a pull request with failing checks: the
  failing checks, and the end of each failed GitHub Actions job's log (the
  last lines plus earlier error lines, up to three jobs).
- **Fix with agent** under a commit a git hook rejected (`pre-commit`,
  `prepare-commit-msg` or `commit-msg`, `core.hooksPath` included): the
  hook's output, the staged files and the message you tried.
- **Resolve with agent** while a merge, rebase, cherry-pick or revert has
  conflicts: the conflicted files with their conflict markers.
- **Address review comments** on an open pull request: its unresolved review
  threads.

A dialog shows what the agent receives (open **Show the full prompt** to read
it all), takes an optional note, and asks where to send it: an agent already
running in a terminal of the workspace, the open Cora chat, a new Cora chat,
a new Claude Code, Codex, Grok or Pi in its own terminal tab (the prompt goes
in once the agent is ready), or the agent inbox. Nothing is sent until you
press **Send** (`Mod+Enter`); **Copy prompt** copies it instead. The next
fix starts on the kind of target you used last.

GitHub is read with your own `gh`. Logs, hook output, file excerpts and
comments are capped, secrets in them are replaced by `[redacted]`, and the
prompt tells the agent to treat them as data, not instructions. The prompts
ask the agent not to push, commit or bypass hooks. Local workspaces only for
now.

**Notify me when CI fails on my pull request** (Settings, Git, Alerts) sends
one alert when a check fails on the pull request of a workspace's branch,
once per failing commit; a pull request that was already failing when Codara
first saw it stays quiet until a later run fails. Clicking the alert opens
Source Control. It asks GitHub only when the branch or its upstream moved,
every 90 seconds while checks run, and every 15 minutes otherwise.

### Quick commands

A quick command is a shell command or an agent prompt you save once and run
in one click. Run one from:

- the play button in the tab bar, next to Automations,
- Shift+right-click in a terminal, which opens a menu with Copy, Paste and
  your commands (they run in the terminal you clicked),
- Run a quick command (Mod+Shift+P), a palette you filter by typing.

Each command is offered everywhere (**All workspaces**) or only in the
workspaces of one repository; a copy-branch workspace counts as its source
repository. A repository's commands come first in the menus. Add, edit,
reorder and delete them in **Settings, Quick commands**, or with Add and the
pencil button in any of the menus.

A **shell command** runs in the **Focused terminal** (the terminal pane you
were last in) or in a **New terminal** tab in the workspace folder. Typed
into the focused terminal, **Press Enter** decides whether it runs or waits
for you to edit it. When an agent or another full-screen program (vim, less)
runs in the focused terminal, the command runs in a new terminal instead, so
it never lands in the agent's input. With **Press Enter** off it is not typed
anywhere else: a notice asks you to click into a shell, so a command you keep
as a draft never runs on its own.

An **agent prompt** goes to:

- **Focused agent**: the Claude Code, Codex, Grok or Pi session in the focused
  terminal. Over a plain shell it is not sent, so a prompt never runs as a
  shell command.
- **Cora**: the Cora chat open in this workspace, or a new chat.
- **New agent**: a new terminal tab with the agent you pick. The prompt is
  sent once the agent is ready for input; if it is not ready within a minute,
  the prompt is copied to the clipboard instead.

**Send right away** off leaves the prompt in the agent's input to edit.

Two variables fill in when a command runs: `{branch}` (the git branch of the
folder it runs in) and `{cwd}` (that folder). `${branch}` is left alone for
the shell. In a shell command the value is typed unquoted, so put `"{cwd}"` in
double quotes when a folder may contain spaces, and a value holding a
character a shell would read as code (`;`, `$`, a quote, a backtick, a
parenthesis and the like) stops the command with a notice instead of running
it.

**Right-click in a terminal** chooses what a plain right-click does: **Copy
or paste** (the default: copy the selection, or paste when nothing is
selected) or **Open menu**. Shift+right-click always does the other one. A
read-only mirror pane keeps copy and paste.

Quick commands are stored with your other preferences in
`spark-preferences.json` and stay on this computer; the phone app does not
show them yet.

### Diagnostics

Codara keeps a record of its own freezes and crashes on this computer, and
uploads nothing. A watchdog thread notices when the main process stops
answering for 5 seconds, notes the stack of the JavaScript that blocks it, and
records the freeze once it ends (or at the next start, if it never did). Time
the app spends waiting for your answer in one of its own dialogs, such as the
question before quitting while Cora works, is not a freeze.
Crashes of the app or its processes leave a crash report in
`~/.codarastudio/crash-dumps/`. Settings, About shows the count under
**Freezes and crashes**.

**Export diagnostics** saves a zip for a bug report: the main log, the freeze
record, the recent events, the event loop delay over the last hour, the list
of crash reports (names and sizes only, never their contents), versions, and
your settings with secrets taken out. Tokens, keys, email addresses and home
folder paths are removed from every file before it is written.
[on-your-machine.md](./on-your-machine.md) lists the files.

Environment variables turn parts of it off: `CODARA_HANG_WATCHDOG=0` (freeze
detection), `CODARA_HANG_WATCHDOG_STACKS=0` (no stacks; they are also skipped
while a debugger is attached, unless set to `1`), `CODARA_CRASH_REPORTER=0`
(crash reports) and `CODARA_EVENT_LOOP_PROBE=0` (the event loop delay).
`CODARA_HANG_WATCHDOG_THRESHOLD_MS` changes the 5 second threshold.

### Quitting, restarting and updating while agents work

- Quitting while Cora or a terminal agent is in the middle of a turn asks
  first. The prompt names what is still working ("Claude Code in api",
  "2 Codex agents in web", "Cora in 1 chat") and says whether terminal agents
  resume when Codara reopens. An agent stopped on a question inside a turn
  counts too, marked "waiting for you". Plain shells, idle agents and Cora's
  own worker panes do not (Cora's runs are counted as runs). **Keep working**
  cancels the quit.
- **Restart and install** on the update chip never cuts work off. While
  something is working, the chip lists it and restarts by itself once nothing
  has been working for 5 seconds. **Restart now** restarts at once and stops
  that work; **Don't restart yet** stops waiting, and the downloaded update
  still installs the next time Codara quits.
- **Keep terminal output across restarts** (Sessions, Restore; on by
  default): a terminal pane reopened after a quit, an update or a crash shows
  the output it had, then a dim `[Restored from before Codara restarted]`
  line, then its new shell or its resumed agent. Colors are kept; cursor
  movement, links and terminal queries are not replayed, and a full-screen
  program such as Codex keeps only its last screen. The output is saved in
  Codara's own folder (see [on-your-machine.md](./on-your-machine.md)).
  Closing a pane deletes its saved output, and turning the setting off
  deletes all of it.

### Feature tips

Now and then Codara shows one short tip about a feature you have not tried
yet, such as splitting a terminal, pointing at a page element for an agent,
or the notification center. A tip appears at most once a day and once per
session, a few minutes after Codara opens, and only at a calm moment: not
while you type, click, scroll or move the pointer, not while a page in the
Codara browser has the keyboard, not while a dialog, menu or the first-run
guide is open, and only when the feature's control is on screen. It never
covers the chat composer or a dialog, and steps aside while one is open.

- **Show me** starts a short tour: the guide card from the first-run tour
  points at the real control with a ring around it. Click the control, or
  **Done**, to finish; Escape ends the tour.
- **Got it** or Escape closes the tip. That tip does not come back.
- **Don't show tips** turns tips off. Turn them back on with **Feature tips**
  in Settings, General, Getting started. **Tips you have seen** with
  **Show them again** lets shown tips come back (greyed out until a tip has
  been shown).

To choose what is worth a tip, Codara notes which features you have used, the
first time you use each one, in `feature-tips.json` in the Codara home
(`~/.codarastudio`). It stays on this computer and is never uploaded. A
feature you already use never gets a tip.

### Terminal agent notifications

When Claude Code, Codex, Grok or Pi runs in a terminal pane, Codara tells you
when a turn ends or the agent needs you. The switches on the
Notifications page of Settings choose where these alerts appear (toast, system notification, sound).

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

### Idle agents sleep

An agent terminal (Claude Code, Codex, Grok or Pi) that finished its turn and
sits untouched in a workspace you are not looking at is stopped after the
time set in Settings, Sessions, **Let idle agents sleep**
(`agentHibernationMinutes`: Off, 15, 30, 60 or 120 minutes; 30 by default).
Its output stays in the pane, a **Sleeping** chip marks it, and the rail's
agent count says how many agents are asleep. Open the pane again and the
agent resumes its exact session in place.

Codara only lets an agent sleep when all of these hold, and keeps it running
whenever it cannot tell:

- the agent's turn ended, it is not waiting for an answer, and there is no
  text you typed but did not send;
- nothing was typed into or printed by the pane for the whole idle time;
- its session can be resumed exactly as it is;
- nothing else runs in the pane: no dev server or other program you started,
  and no command the agent started after it launched (the MCP servers it
  starts at launch do not count);
- the pane is not pinned with **Keep awake** (the sun button in the pane's
  toolbar, shown on agent panes).

Cora's worker panes and phone panes never sleep. A sleeping pane that is
still asleep when you quit counts as a running agent, so **Resume running
agent sessions when Codara reopens** brings it back too.

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

### The Agents view

The switch at the top of the rail's Workspaces section picks what the
section lists: **Workspaces**, your workspaces in your own order (the
default), **Agents**, every agent of every workspace sorted by what it
needs from you, or **Sessions**, which searches your past agent sessions
(see [agent-session-search.md](./agent-session-search.md)). Codara remembers
the choice when it restarts. While the
Workspaces list shows, the **Agents** side of the switch counts the agents
waiting on you.

The Agents view has three groups, each with its count. Click a group's name
to fold it; the folding is remembered.

- **Needs you**: a terminal agent waiting at a permission prompt or a
  question, one that stopped with an error, and Cora chats that asked you
  something or are paused. The one waiting longest comes first.
- **Working**: terminal agents in a turn and Cora chats that are planning,
  working or reviewing, including automation runs and board cards while they
  work. The latest start comes first.
- **Done**: terminal agents back at their prompt, and Cora chats that
  finished, failed or were cancelled in the last 12 hours (a finished chat
  you have not opened stays until you do). Unseen ones come first, marked
  with a dot. A terminal agent Codara stopped to save memory (see
  [Idle agents sleep](#idle-agents-sleep)) shows here as **Sleeping**;
  opening its card resumes it.

Each card shows the agent (Claude Code, Codex, Grok, Pi or Cora), its
workspace with the workspace's status when one is set (from the workspace
row's menu or by an agent), the account it runs on when Codara knows it, what it is doing or
asked, the tool it is running when the agent reports one, and how long it
has been in that state. A terminal agent's card is titled by your last prompt
when the agent's hooks report it, otherwise by its tab.

A **Needs you** card has a reply box. For a Cora question the answer options
show as buttons above the box. For a terminal agent that stopped with an
error, the text is pasted into its pane and submitted, as if you had typed it
at its prompt. A terminal agent waiting at a permission prompt, a question or
a plan to approve shows **Answer in terminal** instead, which opens its pane:
those prompts are menus that take keys, and pasted text followed by Enter
could pick the highlighted answer, often Yes, without you choosing it.
Clicking a card, or Enter on it, switches to its workspace and opens its pane
or chat.

Keys: Left and Right move between **Workspaces**, **Agents** and
**Sessions**; in the
list, Up and Down (or Home and End) move between cards, Tab reaches a card's
reply box or its **Answer in terminal** button, and Escape goes back to the
card.

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
| Skills | The skills agents can load, with a switch for Cora and workers and the same CLI columns. A skill imported from git says where it came from, shows **Update available** when its folder changed upstream, and has **Update** and **Roll back**. Skills from Claude Code plugins are listed below, read only. |
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

### Skill origins and updates

**Add skill** can import a skill from a folder, a zip file or a git
repository. Codara remembers where each one came from (the address, branch or
tag, commit and folder in the repository) in its own folder, never inside the
skill, and the skill's row shows it. Copying a skill to the Claude or Codex
CLI with **Add** carries that record to the copy.

For skills from git, Codara asks the repository whether it moved when the
Capability Center opens, at most every six hours (30 minutes after a failed
check), and when you click **Check for updates**. A check runs `git
ls-remote` and, only when the branch moved, reads that commit's folder
listing without downloading files, so a repository of many skills flags only
the skills whose folder changed. It uses no model and no tokens, and never
opens a sign-in window.

**Update** replaces the skill with the repository's version and keeps the
one it replaced; **Roll back** restores that version in one click. The skill
keeps its name, so its switch and the agents that know it are unaffected,
and new Cora chats and workers load the new version. A copy inside a CLI's
skill folder is changed only when you click one of these.

Skills that come with Claude Code plugins are listed under **From Claude
Code plugins**: the enabled plugins' skills for this workspace, with the
plugin, marketplace and version. Claude Code installs, updates and removes
them with `/plugin`; only the Claude CLI loads them.

Skills reach Cora too. Cora loads the skills kept in `.pi/skills`,
`.agents/skills`, the workspace's `.claude/skills` and `.codex/skills`, and
your user skill folders for Pi, Claude and Codex. A skill switched off here
is not loaded by new Cora sessions. Removing a skill moves its folder to the
trash.

## The worktree cleanup screen

The cleanup screen lists every worktree of the repositories behind your
workspaces, so you can find the ones that only take up space and remove
several at once. Open it from the menu on a workspace's row in the rail (**Clean up
worktrees…**, which starts filtered to that workspace's repository) or
with the `worktrees.cleanup` command (unbound by default; bind it in
Keybindings). SSH workspaces are not listed.

Each row shows the branch, the folder, its size on disk, the last activity
(the newest of its last commit, checkout or index change), uncommitted
changes, how far it is ahead of or behind its upstream, whether it is merged
into the base branch (by a merge, a squash or rebase, or a merged pull
request), and its pull request when the GitHub CLI is signed in. Sizes are
measured in the background, one worktree at a time and for at most four
minutes per opening, and kept in `worktree-sizes.json` so the next opening
starts with them; **Measure sizes again** measures the rows shown again. The
search box matches branch, folder, repository, workspace and pull request;
**Merged**, **Stale for** (7 to 90 days without activity) and **Larger than**
narrow the list, and the column headers sort it.

Removal goes through two steps. **Review removal** checks each picked
worktree again and shows what would be lost. These always stay, whatever you
confirm: the main checkout, a worktree in use (an open terminal, an active
Cora run, a running dev server, the agent that made it still open, a running
program, or Codara itself), a locked worktree (even when its folder is away),
one with another checkout inside it, and one that holds your home folder or
another tool's (such as `~/.claude`). A worktree with uncommitted work, or
with commits that are not merged, needs its own confirmation. **Delete branches that are merged** (on by
default) deletes a branch only when it is merged and not a long-lived one
like `main` or `develop`; a branch with commits that are not merged is never
deleted, and the last step lists it under **Branches kept for review**.
Before removing a worktree Codara saves its last commit, and its uncommitted
changes when they are small enough (ignored files never), under
`refs/codara/removed-worktrees/` for 30 days. Each removal checks again under
the repository lock and stops if anything changed since the review. A
workspace row for a removed worktree leaves the rail, and every removal is
logged to `logs/worktree-audit.jsonl`.
