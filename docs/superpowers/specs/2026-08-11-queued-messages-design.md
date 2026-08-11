# Queued mid-turn messages + chat language rule

Date: 2026-08-11. Approved by Etienne in Claude Code session.

## Problem

1. A user message sent while Cora's manager turn is in flight could be delivered
   **into** the live turn ("STEERING") via the parked `wait_for_workers` seam.
   The user expects the message to wait, visibly queued, until the turn ends.
2. Cora replied in Spanish to an English message: the workspace master
   `CLAUDE.md` says "Idioma: español por defecto" and nothing in Cora's system
   prompt scopes that to deliverables.

## Decisions (user-approved)

- **Always queue.** No mid-turn delivery path remains. Messages typed during a
  live turn stay `deliveryState: "queued"` and are drained by the existing
  steering-followup scheduler / next-turn start after the current turn settles.
- **Unqueue returns text to the composer.** Each queued row gets Unqueue and
  Edit actions; both cancel the queued message and prefill the composer with its
  text. Cancelled-by-unqueue messages disappear from the timeline.
- **Language rule: match the user's message.** Chat replies match the language
  of the user's latest message; language preferences in workspace/project
  context files apply to generated artifacts and deliverables, not chat replies.

## Design

### Main process

- Delete the parked-wait registry in `run-store.ts` (`enterManagerWaitPark`,
  `exitManagerWaitPark`, `runHasParkedManagerWait`, `wakeParkedManagerWaits`,
  `parkedWaitCallIsLive`, `sleepForParkedManagerWait`,
  `claimQueuedInputForParkedManagerWait`, the `parkedManagerWaits` map and
  `ParkedManagerWaitToken`), plus its call sites in `addRunMessage`.
- `agent-socket.ts` wait handler reverts to a plain poll: no park, no claim, no
  `user_message` early return, no `user_messages` field in the wait response.
- Remove `SparkCall.parkedInWaitForWorkers` from `shared/types.ts` (stale
  persisted flags on old runs are ignored harmlessly).
- New export `cancelQueuedMessage({ runId, messageId })`: sets
  `deliveryState: "cancelled"` **only if** the message is still
  `queued && !backendTurnId` at commit time (the race guard against a
  concurrent turn start claiming it); returns the message text. Throws a
  clear error when the message was already delivered. Exposed over IPC as
  `orchestration:cancelQueuedMessage`.
- Everything else (queue persistence, `queuedManagerInputMessages`,
  `scheduleQueuedSteeringFollowup`, settlement acknowledge, requeue-on-failure,
  undo/checkpoints) is unchanged.

### Renderer

- `ChatComposer`: drop `steeringDeliversNow`; while a turn is active the hint
  reads queue language ("Enter to queue · delivered when Cora finishes this
  turn"), send button label "Queue". Worker-activity tail says "· messages
  queue".
- `ChatConversation`: queued user rows show a "Queued" chip (steering wording
  removed) plus Unqueue and Edit actions. Both call `cancelQueuedMessage` and
  dispatch `spark:prefill-composer` with the returned text (Edit focuses the
  composer; Unqueue is the same operation, kept as two affordances for intent).
  If the store reports the message was already claimed, surface a small error
  and do nothing (the message is being delivered). Delivered messages render as
  plain user messages (no steering styling).

### Prompts

- Add to `resources/pi-cora/prompt.ts` shared presentation rules and mirror
  into `src/main/orchestration/prompt-profile.ts`,
  `resources/orchestration/manager-profile.json`, and the four
  `resources/orchestration/{cc,codex}-{auto,execute}-prompt.md` files:
  reply in the language of the user's latest chat message; language
  preferences from CLAUDE.md/context files govern deliverables, not chat.
  Wording must pass `scripts/test-prompt-punctuation.cjs`.

### Tests

- Replace `scripts/test-mid-turn-steering.cjs` with
  `scripts/test-queued-messages.cjs`: a live turn never claims queued input
  mid-turn; the followup scheduler drains after settlement; the next turn's
  prompt renders the message exactly once; `cancelQueuedMessage` cancels a
  queued message and refuses a claimed one (race guard).
- Update the `package.json` script entry.
- e2e: adjust specs that assert steering chips/labels.
