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
