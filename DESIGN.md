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
