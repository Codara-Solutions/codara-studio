# Whiteboards and Cora's review

Every Cora chat has a whiteboard: an infinite canvas of cards and connections
that you and Cora both edit. You can also open a standalone whiteboard with
`Mod+Shift+W` and save it as a `.coraboard` file. This page explains what the
"Draft" and "Cora reviewed" labels mean, how Cora builds project maps with
evidence from the code, and what its review does and does not prove.

## Draft or reviewed

The whiteboard's header shows one of two labels:

- **Draft · needs review**: the current revision has not been reviewed.
  Every edit, yours or Cora's, starts a new draft.
- **Cora reviewed**: Cora inspected this exact revision and recorded a
  review. Hover the label to read the review's summary and any limitations
  Cora noted.

**Review & improve** in the header asks Cora, in the chat, to review the
current board, including your manual edits: check its claims against the
code, look at the rendered result, fix problems, and review the final
revision without overwriting your choices.

## Project maps

When you ask for a map of a project, Cora reads the code before drawing:
entry points, module boundaries, imports and calls, storage, external
interfaces, and one path through the system from end to end.

- File and symbol cards, and the connections between them, can carry
  **sources**: repository-relative `path:line` references. They show on the
  cards and in image exports.
- A connection marked as **inferred** is a hypothesis, drawn with a dashed
  line.
- For a large map with independent areas, Cora may send two or three
  read-only researchers, on economical models at low effort, to read
  separate areas, then connects the areas itself. Small maps are read
  directly. This uses your normal worker models and accounts; nothing extra
  is required.

## How the review works

Cora's workflow for any board it writes:

1. Read the code and write a draft.
2. Render the board to an image (`codara_whiteboard_inspect`) and look at it.
   This works even when the board is not on screen and never moves your view
   or selection. Large boards are inspected again in close-ups.
3. Fix what is wrong, optionally re-laying the board out
   (`codara_whiteboard_arrange`, which moves cards and so is only used on new
   drafts or when you ask).
4. Record the review (`codara_whiteboard_review`).

A review is refused while the board has blocking problems: cards that
overlap, titles or text that are cut off, or an inspection that did not cover
every card readably. Broken or missing source references, isolated cards and
unlabeled branches are warnings; Cora must list any it leaves unresolved as
limitations. If the board changes while Cora is inspecting or reviewing it,
the review is rejected and has to be redone on the new revision.

If Cora finishes a request without reviewing the board it drew, it gets up to
two follow-up turns to do so. If the review still cannot be completed, the
board stays labeled as a draft and Cora says why. A new request from you
clears that follow-up.

What a review is not: checking that a referenced file and line exist does not
prove the claim the card makes. The review is Cora's own assessment, after
reading the code and the rendered images, not a machine proof that the map is
complete or correct.

## Saving and sharing

Reviews survive app restarts. A `.coraboard` file keeps each card's source
evidence, but importing one always starts as a draft, since a review of one
workspace's sources says nothing about another's.

## For contributors

- The canvas is [React Flow](https://github.com/xyflow/xyflow). Layout uses
  [Dagre](https://github.com/dagrejs/dagre), and inspection captures images
  with `html-to-image` 1.11.11, following
  [React Flow's download-image example](https://reactflow.dev/examples/misc/download-image).
  All three are MIT-licensed, and capture is local: the board is never
  uploaded anywhere.
- The review rules for Cora live in `resources/pi-cora/whiteboard-review-policy.ts`;
  the tool contracts are in `resources/codara-studio-mcp/server.js` (see
  [mcp-tools.md](./mcp-tools.md#whiteboard-and-board)).
- `npm test -- 'whiteboard|codara-studio-mcp|pi-cora-extension'` covers
  layout, source references, revision and coverage checks, image transport and
  the follow-up limit. `tests/e2e/whiteboard-review.spec.ts` drives the real
  app through capture, correction, review, reload and manual-edit
  invalidation with a fixed fixture and no paid model. These tests prove the
  mechanics, not a model's understanding of an arbitrary project.
