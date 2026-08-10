# Source Control panel UX fixes — design

Date: 2026-08-10
Status: approved by Etienne (conversation)

Four small changes to the Source Control sidebar panel, approved conversationally:

1. **GitHub count badge** (`GitHubSection.tsx` header): hide the badge when the
   count is 0 (the body copy already says "No open issues or pull requests");
   drop the `padStart(2, "0")` so nonzero counts render unpadded ("3", not "03").

2. **Silent + event-driven GitHub refresh** (replaces the ~30s visible-poll in
   `GitHubWorkQueue.tsx` and the busy-signal plumbing in `GitHubSection.tsx`):
   - Background refreshes never raise the spinner; the spinner shows only for
     the initial load and user-initiated refreshes (refresh button, explicit
     actions).
   - Replace the fixed 30s interval with event-driven triggers: window focus,
     `gitVersion` changes (already feeds `refreshKey`), and after own
     PR/queue actions — plus a slow fallback poll (~5 min) that still runs only
     while the section is on-screen and the document is visible (keep the
     existing IntersectionObserver gating). Use conditional requests (ETag) in
     the main-process GitHub layer if it is cheap to add; otherwise the 5-min
     cadence alone is acceptable.

3. **History scroll restore + return highlight** (`GitPanel.tsx`,
   `CommitHistory.tsx`): the panel body's scroll container gets a ref; opening a
   commit detail saves `scrollTop`, closing restores it after render, and the
   commit row the user was last viewing flashes with a brief grey highlight
   (~1s fade, `var(--hover)`-style background) so the eye re-anchors instantly.

4. **Prev/next commit navigation** (`CommitDetail.tsx` + `GitPanel.tsx`): a
   small footer bar in the detail pane with ← (newer) / → (older) buttons,
   disabled at the ends, stepping through the same `log.rows` list (rows with
   truthy `hash` only). The detail pane already reloads cleanly on hash change.
   Returning to the list highlights the commit the user ended on.

Out of scope: webhooks/push-based GitHub updates (needs server infra);
virtualizing the history list.
