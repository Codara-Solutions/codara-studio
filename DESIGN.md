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
