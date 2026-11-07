# Design decisions

Look-and-feel decisions for Codara Studio, with the references behind them and
the rules they imply. Start here before changing how something looks, and add
a section when a new decision is made. Tokens live in
`src/renderer/src/styles.css`; reuse them rather than adding one-off colors.

## Tab groups (2026-10)

**Chosen:** the pocket. A tab group is one softly tinted container around its
label and its tabs. The label is plain text in the group's color, with no pill,
dot or fill of its own. Picked from four variants built on the real strip
(Chrome-style solid label, pocket, uppercase section label, tinted tabs).

**Why:** the Chrome-style design it replaced felt off. The label was a round
pill next to rectangular tabs and was the loudest thing in the strip. The only
link between the label and its tabs was a 2px line on the floor of the strip,
so a grouped tab looked like an ungrouped one, and nothing marked where a
group started or ended. A pocket groups by space instead of decoration.

**References:** Arc and Safari tab groups (a group is a place). Chrome tab
groups were the starting point and are what this moved away from.

**Rules:**

- A group's color appears in two places only: its label's text and its
  pocket (a 10% tint with a 32% hairline). Member tabs keep the normal tab
  face; they show the pocket through it. No underlines, dots on named groups,
  or solid color fills.
- The pocket has 10px of clear space on both sides, so a group visibly starts
  and ends.
- Collapsed, the pocket shrinks to a pill around the label, with the number of
  hidden tabs as plain text. A solid colored count looks like an unread badge.
- A label stays readable as text: dark themes use the light group tones as
  they are, and light themes mix in 40% of the theme's ink to reach 4.5:1.
- A group with one tab keeps its label. The agent or user named it, and the
  name is the point.
- A tab an agent opened from another workspace shows a small ↗ after its
  title. The workspace's name is in the tooltip and the accessible name, not
  in the tab, where it nearly doubled the tab's width.

## The agent's hand on a browser tab (2026-10)

**Chosen:** an agent that acts on a Codara browser tab shows a cursor in its
own color that glides to each point before the click, keystroke, hover,
scroll or drag lands there, and a small banner at the top of the page names
who drives the tab ("Claude Code · AI Continous Improvment is using this
tab") with a Stop button. Typing outlines the field being typed into. Both
fade four seconds after the agent's last call.

**Why:** the old cursor jumped to the point after the action and a corner
label read "Cora" for every agent. The user could not tell which agent was
working or follow what it did, and had no way to take the tab back short of
closing it.

**References:** OpenAI's Browser Use in the ChatGPT desktop app (a cursor
that moves like a hand, a notice that the agent is driving). Multiplayer
cursors in Figma for the name tag beside the arrow.

**Rules:**

- The layer is Codara's own UI above the `<webview>`, never injected into the
  page: page scripts and CSP cannot see or break it, and the agent's
  screenshots, recordings and visual diffs of the page never contain it. It
  lets every click through; only the banner takes input.
- A glide is a slightly curved, eased path of 250 to 450 ms, longer for a
  farther point, and the action waits for it, never more than 600 ms. It
  jumps instead when the tab is hidden, Codara's window is minimized or
  the system asks for reduced motion.
- The cursor and the banner dot use the agent's color (`--agent-claude`,
  `--agent-codex`, `--agent-grok`, `--agent-pi` for Cora), the same one its
  terminal tab carries; an unknown agent uses the accent.
- Stop refuses that agent's next call on that tab with a message telling it
  the user took the tab back. Other agents and other tabs are unaffected. The
  banner offers Undo for six seconds; closing the tab forgets the stop.
- The banner sits on the overlay surface (`.spark-glass--strong
  .spark-overlay-surface`), the same read tier as the pointing panels.
- On a tab of the user's own Chrome there is no layer in the page, which
  would need new extension permissions. Chrome shows its own "Codara started
  debugging this browser" bar, the extension's button names the agent while
  it acts, and the popup's Stop ends it there.
- The component lives in `components/Preview/agent-presence/` with its own
  CSS and store; BrowserPane only mounts it, so the toolbar can move freely.

## Tab links and agent tab approvals (2026-10)

**Chosen:** a link brings its tab on screen and marks it with a short accent
ring (an inset 2px ring over a soft accent wash, fading over 1.6 s). An agent
that wants to close, split or unsplit tabs it did not open shows the same
floating card as the cross-workspace terminal prompt, top right, listing every
tab that would change.

**Why:** after a switch of workspace or an unfolded group the eye needs one cue
for where the tab went, and the strip already uses an inset ring for focus, so
the flash reads as "this one" without moving anything. The card copies an
existing pattern rather than adding a modal: it never blocks typing, counts
down to the agent's timeout and stays put if the user is mid-task.

**Rules:**

- The flash is an inset box shadow, so the tab never changes size. With reduced
  motion it is a static ring for the same time, no fade.
- The card names the agent and the count in its title ("Claude Code wants to
  close 3 tabs in group “login-flow”"), then lists each tab by kind and title
  on an opaque panel, never on glass. The list scrolls past about six rows.
- A running agent or unsaved edits show as a warning dot with plain ink text
  ("agent running", "unsaved changes") on the row, plus one sentence under
  the list. Color alone never carries the warning.
- Buttons: Deny, then Allow once as the primary, on one row with the countdown;
  "Always allow “<workspace>” to close tabs here" (or "to move tabs here" on
  a split or unsplit card, a separate grant) is a full-width secondary
  button under them, so the riskier, lasting choice is never the default and
  its long label never crowds the row.
- An expired card says nothing changed and stays a few seconds with Dismiss,
  as the cross-workspace card does.

## Browser pane (2026-10)

**Chosen:** variant A of four built on the real pane (labelled toolbar,
command palette, bottom dock, minimal chrome), with C's Video or GIF choice
before recording. The frequent tools sit in the toolbar with words (Point,
Comment, Record); the rare ones moved into More (phone, tablet and desktop
sizes, full screen, copy tab id for an agent, copy id, URL and session, open
in the system browser, developer tools). A chip at the right shows how many
browser tabs are open and the memory they use, and opens a view of every
browser tab in every workspace where a tab can be put to sleep, woken or
closed.

**Why:** the toolbar was a row of unlabelled icons whose meaning had to be
learned, PORTS and the tab id took space every time for something needed
rarely, and there was no way to see which tabs were open in other workspaces
or what they cost. Full screen did not exist.

**References:** Chrome's memory saver and its tab hover cards (sleeping tabs,
memory per tab), every browser's F11 and Esc for full screen, VS Code's
Simple Browser (a browser that belongs to the editor), the Vercel toolbar
(comments on a page) and Polypane (sizes side by side).

**Rules:**

- Menus and popovers over a page are solid (`.spark-menu.bp-menu`), never
  glass: the page behind them is unknown and would make the text unreadable.
- A tool used most days has a word next to its icon; a tool used rarely goes
  in More. When the pane is narrower than 700px the words go and every icon
  stays, with its name as the tooltip and accessible name.
- A tab sleeps by hand or after 30 minutes unseen (on by default, one switch
  in the tabs view). It never sleeps while on screen, while recording, within
  ten minutes of an agent's call, or when it has its own private session
  (sleeping would lose the session). A sleeping tab keeps its title, URL and
  last picture, uses no memory, and loads again when shown or when an agent
  calls it.
- Full screen fills Codara's window; F11 again takes the whole display. Esc
  always leaves, from the toolbar or from inside the page, and so does
  switching tabs. Only the user's own keys count; an agent's Esc stays in
  the page.
- No dock: a bar along the bottom of the page would sit over the area the
  agent's cursor works in and split the tools between two edges.

## Usage in the title bar (2026-10)

**Chosen:** title bar option 3, hairlines, with popover option C, now → at
reset. Each provider in the title bar is its glyph and one thin 26px line:
the solid part is what the active account has used of the limit that matters
most, the faint part is where the forecast says it ends at the reset. Clicking
one opens a single panel where every limit reads "NOW 82% → AT RESET out
17:40 · 2h 50m early" (or "35% at reset") over a dot-and-circle track: the
dot is now, the circle is the forecast end. Etienne picked it from round 2 of
the usage mock-up (title bars: rings, one glyph, hairlines; popovers: big
number with bar, rings, now → at reset), after rejecting round 1 (the Orca
style roster with its flyout, lanes, a table and a sheet). It replaces the
text chips ("Main 5h 82% · wk 34%"), the "Usage · all agents" roster and its
per-provider flyout, and the Labs forecast styles (projection, sentence,
title-bar mark) that were never on by default.

**Why:** his words: the top part "super minimalistic", and when pressed
"informative but simple to understand and nice looking", showing "where it
thinks our usage will be based on predictions: are we going to finish it
before it resets?". The chips said how much was used but not whether it would
last, and the forecast that answers that was a Labs switch nobody had on. For
ChatGPT he wanted the banked resets usable from there: how many, and when
each expires.

**References:** the mock-up (round 2, `usage-variants/index.html`, with
`round1.html` for what was rejected), built on Studio's own dark tokens.
Orca's usage roster (github.com/stablyai/orca) still shapes the account model
behind the Switch menu. t3code (github.com/pingdotgg/t3code) for how a reset
is spent: the credit id is sent, and the request id is derived from the
account and the credit.

**Rules:**

- Colour only for risk. The hairline and its glyph are ink-dim while fine and
  turn danger only when the forecast says a limit runs out before it resets
  (or it is used up). In the panel the "now" number is ink, warn past 70%
  used, danger when it runs out. No green anywhere: fine is the quiet state.
- The forecast is never shown alone: the faint part and the circle always
  come with the "at reset" number or the run-out time and how early, and the
  hairline's tooltip and accessible name say it in one plain sentence.
- A hairline draws the limit that runs out first, else the one forecast to
  end highest; plan-wide windows before a model's cap.
- Running out is said only when it is more likely than not (the forecast's
  odds at or above one in two).
- Never a made-up number: a window the forecast has no history for (no view,
  or no past day like today) says "not enough history yet" and draws no
  circle. With the forecast turned off, the panel shows only "now" and the
  reset time.
- The forecast is on by default. Settings, Agents, Usage has the switch; only
  the user's own choice turns it off (usageForecastChosen), since the Labs
  builds saved `usageForecast: false` for everyone.
- One panel, no flyout. Per provider: glyph, name, the active account (or the
  plan when there is no one else to switch to) and, on the right, "Switch"
  when there is another account to move new sessions to, else the email.
  The Switch menu lists every account, the active one checked; switching is
  the same request Accounts makes.
- "<Account> has 98% left · Switch" appears only while one of the active
  account's limits runs out and another switchable account has at least 25%
  room and more than the active one. Nothing nudges while things are fine.
- ChatGPT's banked resets list each reset with its expiry, absolute and
  relative, soonest first; one expiring within a day gets a warn dot. "Use a
  reset" spends the one that expires first, by its credit id, after a confirm
  that names it ("The reset expiring today 19:48 goes first. This can't be
  undone."). When ChatGPT says none applies (applicable 0), or nothing is used
  yet, the button is off and a sentence says why.
- A provider with nothing to draw is one line ("Grok: limits appear once Cora
  is signed in · Connect"). Plain words for the private own login: "Claude
  Code keeps these private".
- Providers keep the Accounts order (Claude, ChatGPT, Grok) whatever the
  numbers say, so nothing jumps place between two looks.
- The footer has two links, "Usage details" and "Accounts". The separate Usage
  opener in the title bar shows only when there is no hairline to click.

## System activity (2026-11)

**Chosen:** variant A, one ranked list, without its per-row bars. Pressing a
title-bar meter opens one list, heaviest first, of panes, what closed panes
left running, Codara itself and other apps. Each row is the agent and workspace
("Claude Code · codara-studio"), what is heavy in it ("next-server, claude"),
and one figure on the right. Etienne picked it over a list of programs in cores
and a sentence-first view grouped by workspace, in his words: "top part of A
but without the line of each thing just the % like it has to the right is
enough".

**Why:** the panel could not answer "what is eating my CPU?". Panes always came
first, so Codara at 138% sat under rows at 0%. The headline said 19% of the
machine while rows counted 100% per core, up to 2400% here. Rows were named by
the chat title, often the person's own last message. And 24 `sh` loops at about
2000% were lost inside Other apps, with no way to tell who started them.

**References:** the mock-up on Studio's own tokens, with the same fake process
data as a normal moment and as the runaway, next to the old panel. Windows Task
Manager for a list that adds up to its headline.

**Rules:**

- CPU rows read as a share of the whole machine, the scale of the headline, so
  they add up to it. "100% is one core" stays inside the sampler.
- One list, sorted by the figure alone. Nothing holds a place for being an
  agent.
- No bars, tracks or sparklines on a row: the figure on the right is enough.
- A row is named by who it is. What the agent was asked moves to the row's
  detail ("Last prompt: ..."), a Cora worker's title too ("Task: ...").
- Idle rows fold into one line that opens: under 1% of one core on CPU, and on
  RAM anything left running under 64 MB. Before the first CPU reading nothing
  is called idle.
- Colour only for risk, with an icon and words: a row with at least half the
  machine, or a left-running row using a full core. Such a row opens by itself
  so what it runs shows without a click. No green and no colour for "fine".
- What a closed pane left running is named by what it is ("sh ×24 left
  running"), then its agent and workspace if they are known. It says "no open
  terminal", which is all Studio knows. Nothing about it is made up: an unknown
  owner is left out, and a process that might still have a pane, such as one
  from a second Studio, stays in Other apps.

**Ownership:** `SPARK_PANE_ID` is inherited through `setsid` and reparenting, so
Linux can still name the pane after the parent, the session and the pane are
gone. A cgroup cannot do this: only a personal launcher puts agents in their
own scope, and Studio does not. macOS and Windows have no such reading yet, so
there a process that lost its parent stays in Other apps.

## Source Control (2026-11)

**Chosen:** layout B, agent lanes, with layout A's small commit box docked at
the bottom. One lane per checkout of the active project: line 1 is its branch
with the pull request mark, line 2 its most urgent agent's state word (or "No
agent · from main") and its diff size since the base, the same two lines a
worktree has in the rail. The checkout the window is on is a lane too, last, and
holds what the panel used to be: branch menu with small Pull, Push and Fetch,
change lists, stash, GitHub (the journey, the PR, issues and PRs) and history.
Picked by Etienne from four layouts built on the panel's real sizes and tokens
(files first, agent lanes, review first, graph with stacks).

**Why:** the panel answered "what am I saving" for one person on one branch.
With several agents the question is "what did they change, and can it land". The
Save and Review rooms and about 380px of controls above the first file are gone;
the room bar was a mental model the commit box no longer needs.

**References:** T3 Code and Conductor (a list of agent worktrees with diff size
and a next step), Linear's issue rows (two quiet lines, colour only for state),
VS Code (the commit box as part of the source control view).

**Rules:**

- A lane's row unfolds it and never switches workspace, so all agents can be read
  from one place. The chevron is inside the one click target; nothing else in the
  row acts. Going somewhere is the lane's own actions and its file rows.
- The next step comes first and there is one primary look, Merge. Needs you opens
  the agent; failing checks offer Fix checks; Merge shows only on an open, non
  draft PR whose checks passed or report nothing, with no agent working or asking.
  Merge always goes through the existing confirm dialog, after GitHub is read again.
- Lanes order by what needs the user: needs you, failing checks, ready to merge,
  working, done, idle, quiet. The active checkout stays last so the list above it
  does not jump as its detail grows. Merged worktrees use the rail's own fold.
- Who works where comes from the rail's rule (`buildRailFamily`), so the rail and
  the panel never disagree. The rail stays "where is everyone"; lanes add "what
  did they change, and what next".
- Diff size is everything since the branch left its base, committed or not, so an
  agent that committed does not read as +0. Commits the base gained later do not count.
- The commit box always commits the active checkout. Amend and Split wait in its
  ⋯ menu, Generate is a sparkle inside the message box.
- Failed checks are never a green tick: the journey's step reads failed, ✕ in
  `--danger`, with the same glyphs as `PullRequestMark`.
- An SSH workspace shows only its own lane: every other lane would be a round trip.
- The list and the commit box are separate columns of the panel, so the box never
  covers a lane. A lane unfolded near the bottom scrolls its buttons into view.

**Start an agent and review with an agent (2026-11):** New agent sits above the
lanes: a task, Claude Code or Codex, the branch to start from, in a new worktree by
default, through the same session start agents use. Review with agent is on any lane
with changes.

- The user picks who reviews, and who a finding goes to. Nothing is fixed to one
  agent. Reviewers are a new Codex or Claude Code session, a new Cora chat, or an
  agent already running. A running agent gets a prompt in its own session.
- The reviewer preselected is the last one picked, unless that is a new agent of the
  family that wrote the work: a second opinion comes from the other family.
- A finding's Send menu starts on the last choice, then on the agent that wrote the
  work, marked "wrote this" and listed first. A reviewer running in that worktree is
  never taken for the writer. Any note can be sent alone.
- Findings come back through `codara_review_findings` with a one-time id only that
  reviewer's prompt holds, and become ordinary review notes with the reviewer's name.
  They are untrusted: bad paths drop, secrets are removed, and sent on they say
  "Finding by X, an agent, untrusted".
- Anything that starts a new agent says it spends usage before the click. A review in
  progress shows on the lane as "Reviewing · Codex"; clicking it stops waiting.
- New agent offers Claude Code and Codex only, because a session cannot run Cora. Cora
  can review through a new chat.

**Collision warning (2026-11):** one quiet line under a lane in `--warn`, "session.ts
clashes with feat/dark-charts if both merge.", between running lanes only. It reads
committed work, because that is what merges. Etienne is unsure agents need it, so it
is built to remove: `lane-collisions.ts`, `git-lane-collisions.ts`,
`LaneCollisions.tsx`, the `collision` prop on `LaneRow` and one IPC handler. It is off
for SSH workspaces and on git older than 2.38. It runs with no click behind it, so it
also stays out of any repository where a merge could start a program the repository
configures: a custom merge driver, a partial clone, an initialized submodule.

## Worktrees in the rail (2026-10)

**Chosen:** variant A, a tree, with variant B's folded merged group. A
project's worktrees hang under its row on a thin tree line. Each worktree row
has no tile: line 1 is its branch with the pull request mark right-aligned
(#42 with ✕, ✓ or a dot for its checks), line 2 is its most urgent agent's
state dot and word, its age and " · note", or "No agent · from main". The
project row keeps its tile and name and rolls everything up in one line ("1
needs you · 5 working"). Merged worktrees fold into one "▸ N merged · Clean up"
line at the bottom. Picked from four variants built on the real rail (tree,
dense branch list, agent threads, lifecycle pockets); Etienne chose A with B's
fold.

**Why:** worktree rows used to sit flat in the rail, indented 14px, each as
tall as a project, so a busy repository pushed everything else off screen and
nothing said which agent worked where. The summary under a row toggled a list
instead of opening the row, so a click on the most visible text did the
unexpected thing.

**References:** VS Code's explorer and Linear's sidebar (a thin tree line, the
child row lighter than its parent), GitHub's PR list for the check glyphs.

**Rules:**

- Clicking anywhere on a row opens that row. Nothing inside a row toggles.
  Folding has its own 14px chevron at the row's left edge; rows with nothing
  under them keep the gutter empty so every tile lines up.
- An agent shows on one row, the one it works in: its pane's workspace, or
  the worktree it created when its chat stays in the project, no other agent
  runs inside it and it is not merged (otherwise the creator was a
  coordinator and stays on the project). A creator of several such
  worktrees shows on the newest. The project's own agents (a coordinator)
  list at the top of the tree; clicking one opens its tab.
- A background agent (a coordinator's subagent in another workspace's
  repository, which has no pane there) shows on the worktree it made with
  codara_worktree_create and `workspace`, or wrote a note on with
  codara_workspace_status and `worktree`. The row gains one muted line above
  the state line, "Claude subagent · from <workspace> › <its tab>" (runtime name, tab only when known), since the rail is
  too narrow for both on one line; the state line is unchanged. It stays
  until the branch merges or the worktree goes. It is not counted at the
  right edge: its coordinator's pane already is, in its own workspace.
- A worktree git lists that Codara did not make (plain `git worktree add`)
  is listed under its project as "External worktree", no tile, with the note
  an agent left on it. Clicking it opens it as one of the project's worktrees.
- Order under a project: needs you, working, done, idle, no agent; rail order
  among equals. Merged worktrees always go last, in their fold, folded by
  default and faded (52%) when opened.
- Colour only for state: the dot always, the state word only for needs you
  (danger, semibold) and working (info). Everything else is muted ink. No new
  tokens: `--rule` for the tree line, the existing agent state tones.
- A worktree whose project is not in the rail stays a top-level row, indented
  as before.
- Two projects on one folder: the worktree hangs under the one higher in the
  rail as the user sees it.
- Clean up on the fold removes one merged worktree at once; for more, it
  first shows the explorer's confirm with their names.
- Clean up never ends silently (2026-10-25: Etienne pressed it on a worktree
  holding only `test-results/` and saw nothing). Its answer shows next to the
  button that asked, not only in a toast: the rows go (with a toast), the same
  confirm asks "<name> holds .env. Remove anyway?" for ignored files a fresh
  checkout won't bring back, or a short line under the fold or row says what
  holds it back. That line starts with what to do ("Close the tab “x” in Repo
  first: …"), is muted ink with a warn dot (danger for a failure), wraps to
  at most three lines, and goes on ×, on the next Clean up, or once the
  worktree leaves the rail. Test and build output never counts as something
  a worktree holds.

## One home for agent counts (2026-10)

**Chosen:** B, number only. The number at a workspace row's right edge is the
one place the rail counts agents: a muted "3" while they are idle, "1/3" in
the workspace's accent while one works, unchanged. The line under the name
speaks only when something needs the user or finished: "needs you" (danger,
semibold), "ready", "in inbox", "done" or "done today". It never says "N
working" or "N agents idle", so an idle workspace is a one-line row. Picked
from the 2026-10-27 rail mock-up (A to D); Etienne chose B.

**Why:** a row said its agent count twice, once in the line ("1 agent idle",
"2 working · 1 idle") and once in the number beside it. One home for agent
counts; the line under a workspace speaks only when something needs you or
finished.

**Rules:**

- A project's number counts its whole family: its own agents plus every
  worktree's (merged ones too), working and sleeping alike, so a folded
  project still shows that agents work inside it. Its tooltip and accessible
  name say how many of them are in worktrees ("1 of 3 agents working, 2 in
  worktrees"), counting the agents shown on worktree rows. The row is busy
  (`aria-busy`) while any agent of the family works.
- Tasks of the workspace's list that are still running are not agents. When
  they show on the line they read as tasks ("1 task running"), muted and
  last, never as "working".
- The line's tooltip and accessible name say who needs you and why and give
  the task list. They never tally agents: the number does, from its own
  census, and two counts could disagree.
- "Working" in the number means what the agent lines call working: mid-turn,
  in the background, quiet ("No output") or starting. A quiet agent mid-turn
  never reads as idle.
- The rail variant lives in `summarizeWorkspace(..., { variant: "rail" })`;
  other callers keep the full line.
- Worktree rows under a project keep their own agent line (state dot and
  word): it names one agent, it is not a count.

## Agents tab (2026-10)

**Chosen:** D′, "straight T3 Code, a bit nicer and more minimal". The Agents
tab is an inbox after T3 Code's thread sidebar: what needs you or finished on
top, then Working, Snoozed and Settled shelves with plain counts (since
2026-11 the top list has headings too, see the rules below). Each row has no
box and three lines: the project, then the title,
then the branch and pull request. A status word sits top right (Input,
Failed, Done, Working with a live timer) and gives way to the age once the
row is seen. Etienne picked D from four variants on the real rows (D straight
T3 Code, E T3 in Studio's colours, F grouped by workspace, G one line per
agent), asking for it a bit nicer and more minimal; D′ is that refinement,
recorded next to D in the mock-up before it was built.

**Credit:** the design, its words and its behaviour come from T3 Code
(github.com/pingdotgg/t3code, MIT, by Theo / Ping Labs). The code is Codara's
own; the header of `AgentInboxList.tsx` names the source too.

**Why:** the old view drew every agent as a card with a coloured edge, a
harness mark, a workspace tile in its colour, a status phrase and often a
reply box, so five agents filled the rail and finished work never left.
T3 Code's rule is that every agent is either working or out of the way:
settle what is done, snooze what can wait, and a merged pull request settles
itself.

**References:** T3 Code's sidebar (`SidebarThreadRow`, its collapsible
section headers, the snooze presets and the undo notice in the footer).

**Rules:**

- Fewer marks per row than T3 Code: the agent's mark only when it is not
  Claude Code, project tiles in muted ink (no workspace colour), +/- line
  counts only on a finished agent's pull request, the check as Studio's ✓ ✕
  or a dot.
- Colour is for state only: the status word and its icon (`--warn` Input,
  `--danger` Failed, `--ok` Done, `--info` Working), the check glyph, +/-.
  A seen row's title is dimmed (`--ink-dim`); only the open row gets a
  surface (`--hover-strong`).
- Hover, or keyboard focus, turns the status slot into Snooze and ✓ Settle.
  E settles the focused row. Snooze offers 1 hour, 3 hours, this evening
  (18:00, gone once passed), tomorrow 09:00 and next Monday 09:00; two that
  land on the same minute keep the named one.
- A settled agent comes back when it does something new (starts working,
  asks, or finishes a turn the user has not seen); a snooze ends early only
  for a question or a fresh failure, never for a finished turn.
- A merged pull request settles its workspace's finished agents once. Undo,
  or new work after the merge, keeps the agent in view for that merge.
  Pinned, working and waiting agents are never auto-settled.
- Undo is one quiet line in the footer ("Settled, Ctrl+Z to undo") for eight
  seconds; Ctrl+Z (⌘Z) works while focus is in the list.
- The right-click menu is T3 Code's, trimmed: Open, Merge PR (our one
  addition, only while the pull request is open with passing checks),
  Settle, Snooze ›, Pin, Rename, Mark unread, Copy link, Delete. Snooze's
  times and Delete's confirmation replace the list in place.
- Merge PR re-reads GitHub first. Into main, master or the repository's
  default branch it opens the Git panel's merge confirmation; into any other
  base it squash-merges on the click, pinned to the head commit, and settles
  the row.
- Rows do not answer questions in place: opening the row goes to the agent.
  The question is the row's tooltip.
- Every row sits under a heading, and each heading's count is its rows:
  Needs you, Done, Working, Snoozed, Settled, in that order. T3 Code leaves
  what needs you and what finished as an unlabelled list above shelves pinned
  to the bottom; in use that list read as rows with no section (2026-11), so
  it became the Needs you and Done sections, open by default. Needs you's
  count is the switch's badge.

## Merged worktrees leave on their own (2026-11)

**Chosen:** removal, not hiding. Etienne: "once they are merged they should
disappear from here, because it clutters the workspace". The merged fold already
hid them and they still took a line and the disk, so a worktree whose work is
provably merged now goes by itself, with a toast that says so. **Settings, Git,
Worktrees, Remove merged worktrees on their own** turns it off (on by default).

**Rules it implies:**

- Two tiers. What passes every rule goes on its own; everything else stays in
  the merged fold, one click from Clean up, and goes on its own once what held
  it is gone. Nothing new is drawn for the second tier.
- Unattended means fail closed: what could not be read counts as in use, and
  only a removal nobody needs to confirm may run. Dirty, untracked, ignored
  files worth keeping, unpushed, locked, in use or merged only locally all stay.
  It never forces, and the last commit stays recoverable for 30 days.
- Matching content is not enough on its own: the branch's last commit must still
  be on its remote branch. A squash merge whose remote branch was deleted goes on
  the merged pull request instead; without that lookup it stays in the fold.
- The window is asked again at the last moment, under the repository lock, and
  anything but a clear "not held" keeps the worktree.
- A row with a tab stays, whatever the tab holds. Main cannot see an editor
  buffer or a draft, so the rail decides this one.
- An empty worktree (nothing ever committed) is never removed on its own. After
  a week untouched with no agent, its row offers Clean up on hover, with a
  tooltip that says nothing was committed there.
- Ignored data never holds merged work back (2026-11-06, "4 merged · Clean up"
  sat for days on `data/` folders): it is copied to the archive
  (`~/.codarastudio/worktree-archive/<date>/<repo>--<branch>/`, 30 days) and
  counted before anything is deleted. The maker's tab holds merged work only
  while its shell is inside and it was active in the last 30 minutes. Clean up
  is left for what needs a human: unmerged and stale, dirty or detached.
- One toast per pass, not one per worktree: "Removed 4 merged worktrees" with
  "1.6 GB freed, data archived for 30 days (click to open it)". The existing
  local toast, success tone; a click opens the archive folder. No dialog.

## Session picker (2026-11)

**Chosen:** B, "Browser". A list beside the end of the highlighted conversation,
in the read-tier glass dialog. Etienne picked B from four variants on one
comparison page (A a quick switcher palette, B the browser, C a Recent section
and flyouts in the + menu, D a full History tab), and added: "make it so we can
rename them, search by name and what was said by us or the agent".

**References:** Studio's own jump palette for the keyboard and focus behaviour;
the transcript dialog for the surface; the Cora chat for the shape of a
conversation (your words in a bubble, the reply without one).

**Rules it implies:**

- Color marks state only: the selected row, a matched word, the primary action,
  the destructive one. Agent marks keep their brand colors; nothing else in the
  list is tinted.
- A result always says what matched: **Name**, **You** or the agent's name. A
  highlighted word with no label does not answer the question.
- The search box keeps the keyboard. Rows are chosen with `aria-activedescendant`,
  so typing never needs a click back into the box.
- The end of the conversation shows first, pinned to the bottom of the pane: it
  is what tells you whether this is the session you meant.
- A Claude, Codex or Grok row in a + menu opens the picker for that agent first,
  because seeing past sessions when opening a worker is the point. **New session**
  is the default: Enter starts one, so it costs one key, and a session is only
  resumed on purpose. A chord bound to "New ... worker pane" never shows it.
- The picker is the one place for past sessions. The rail's Sessions tab is gone:
  a small history button beside the Workspaces and Agents switch opens the picker
  on the current workspace, and that opening does not change the remembered
  scope. A session row has nowhere else to live in the rail, so naming stays here.
- A session running in a pane offers **Go to its tab**, never a second resume.
- A name lives outside the index and outside the transcripts. The index is a
  cache and the transcripts belong to the CLIs, so neither may be its only home.

## Cora chat (2026-11)

**Chosen:** B, "T3 in Studio colours". The chat takes T3 Code's shape and keeps
Studio's warm tokens, so it follows every theme. Etienne picked B from four
variants on one made-up conversation, each in dark and light with a replay of
a message going out and a reply streaming back (A straight T3 in its own greys,
B T3 in Studio colours, C compact at split-pane size, D T3 with every step left
open on a thin trail).

**References:** T3 Code's `TimelineUserMessageRow`, `TimelineAssistantRows`,
`WorkLog`, `TimelineWorkGroupRows`, the fold rules in `MessagesTimeline.logic`,
and its published desktop screenshot.

**Credit:** the design and the fold rules come from T3 Code
(github.com/pingdotgg/t3code, MIT, by Theo / Ping Labs). The code is Codara's
own; the header of `turn-fold.ts` names the source too.

**Rules**

- The reply has no bubble and no name. The user's message is a `--panel-2`
  bubble, 16px radius, no border, at most 80% wide.
- Reply text is 14px at 1.625 line height.
- A finished turn folds behind "Worked for 42s" and opens with one click. The
  fold hides tool calls and the narration between them, never the answer, an
  error or a failed tool call.
- Only a completed turn folds. A failed or stopped turn stays open, every slice
  of it: that is when the steps matter. A turn still running does not fold
  either, even the part before a question it asked.
- Find opens whatever it lands in, a fold or a long message. An opened fold
  stays open when the list scrolls it away and back.
- A user message past 600 characters or 8 lines collapses to 176px with a fade
  behind "Show full message".
- Tool rows are one 24px line with a plain mark per kind of tool. Running and
  failed calls keep the status icon.
- Colour means state. The only other colour is the workspace accent, on send,
  stop and the working dot.
- An error row is a soft 8% `--danger` tint with no border, so it reads as part
  of the conversation.
- Send and stop are one 32px round button in the same place. Starters are pills
  showing a title, with the description in the tooltip.
- A code block in the chat is one bordered surface with its bar always showing.

**Where it differs from T3 on purpose:** the composer stays docked at the bottom
of a new chat, because centring it would make it jump on the first send. It
keeps Studio's own control order. Worker rows stay separate timeline items. The
composer uses `--panel`, so in the light themes it stays warm rather than near
white.

## Automations (2026-11)

**Chosen:** variant A, inbox and run history, from four variants built with the
real tokens and sample content (A inbox, B the day on a timeline, C cards and
templates, D a When, do, then builder). Etienne picked A for the page and D's
builder for the New automation screen, which comes in a later change. The rail
has shelves in the order Needs you, Failed, Running, Scheduled, Paused. The
page opens on one plain sentence, then the last result, the bar of recent runs
with the month so far, the runs, how it runs, and the details.

**Why:** the old page answered "how is this wired?" when the reader asked "did
it work, and what did it do?". A row said `cron 0 2 * * 1-5 · once` and `armed`;
the page led with the flow, and the outcome sat in a card that spoke in passes
and iterations. A failed automation looked like any other.

**References:** the Agents tab's inbox in this repo (shelves, rows with no box,
a status word at the end of the row, the word giving way to an action on hover)
and GitHub Actions' row of recent results for the bar of ticks.

**Rules:**

- Colour is for state only: danger for needs you and failed, info for running.
  A run that went fine is a neutral tick, not a green one, so a failure stands
  out in a row of them. Tone text mixes in ink to read at 4.5:1 on every theme.
- Plain words on this page: run, not pass or iteration. Paused and Turn on, not
  armed. A schedule is a phrase ("Every weekday at 02:00"); the raw expression
  stays in Details, and a cron shape the phrase cannot read shows the expression
  rather than a guess.
- In the sentence, only the model, the folder and money are strong: they are
  what a reader checks first.
- A switched-off automation sits on Paused even if its last run failed: it has
  been looked at. A question outranks the switch and stays on Needs you.
- Month totals come from the kept history, which holds the last 50 runs. When
  that cannot cover the whole month the numbers carry a `+` and a tooltip that
  says so. Never show a floor as if it were the total.
- Spending limits sit with the other caps in the Loop panel, with one line under
  them saying the worst case for a month in euros. That line is danger only when
  nothing bounds the spend, so it stays quiet once a limit is set. An automation
  held back by a limit sits on Needs you, because it stopped doing its job and
  will not say so again.
- The forecast says "about" and says limits are checked between runs. Never show a
  ceiling firmer than the engine enforces.
- New automation opens on a sentence (When, Do, Stop, Then) with what will happen
  beside it, from variant D. It only ever makes one worker, so it maps one way, and
  anything else is the flow editor's: "Open in flow editor" carries the sentence
  over. Edit always opens the flow editor. Every choice is a plain native select,
  so a keyboard and a screen reader work without new widgets.
- The sentence starts with a 2 euro budget filled in, and no monthly cap. Clearing the
  budget is one keystroke, and the cost line turns red when nothing bounds the spend.
- Money is euros first with the dollars in small, muted print beside it
  ("≈€1.72 $2.00"), picked by Etienne. Spend and caps stay stored in USD; a cap is
  typed in euros, stored at the day's rate, and the dollars sit under the field.
  The rate is the ECB daily reference rate (src/main/fx-rate.ts: one request a
  day, cached in Studio's home, then the last cached rate, then a built-in
  constant), and the tooltip on the dollars names it. "≈" shows on amounts that are
  converted, except in a line that already says "about" or "est.".
- Delete sits at the bottom of Details, well away from Run now.
- "Fix with Cora" fills a new chat's message box and sends nothing. The user
  reads it first.
- Narrow window: the rail gives up width first (264px), then the run rows drop
  their stop badge. The dot and the summary still carry the result.
- Pull request triggers read as a sentence too ("When CI fails on a pull request
  into main") and use the existing check and field controls. Trouble reaching
  GitHub, or a pull request at its daily limit, is a "not started" row in Runs,
  not a new surface.
- An automation on its own branch says so in the sentence. The result card points
  to the draft pull request when there is one, and otherwise says in one line
  where the work is. The switch is in the Loop panel, off by default.

## Notification sounds (2026-11)

**Chosen:** one chime per state. Needs you and done stay as they were; failed
is new (two soft notes falling a fifth, as loud as done), so a failure no
longer sounds like a question or a success. Every failure kind plays failed
(`notifySoundKind`, enforced at publish). Native notifications are always
silent, so the Sound setting is the only switch for sound.
