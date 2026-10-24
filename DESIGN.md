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
  "Always allow “<workspace>” to close tabs here" is a full-width secondary
  button under them, so the riskier, lasting choice is never the default and
  its long label never crowds the row.
- An expired card says nothing changed and stays a few seconds with Dismiss,
  as the cross-workspace card does.
