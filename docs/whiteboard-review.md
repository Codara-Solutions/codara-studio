# Cora whiteboard review

A board write creates a draft. Cora's workflow is to investigate the code,
create a readable draft, inspect the rendered result, correct problems, and
record a review of that exact revision. The header distinguishes a draft from
**Cora reviewed**, with the review summary and limitations available on hover.
**Review & improve** prepares a chat request to run that workflow on the current
board, including manual edits.

## Project maps

The manager prompt asks Cora to inspect entry points, module boundaries,
imports and calls, storage, external interfaces, and an end-to-end path. File
and symbol cards can carry `sources` containing repository-relative `path:line`
references. Connections can carry the same evidence. `confidence: "inferred"`
marks a hypothesis and renders its edge dashed; source references also appear
on cards and in image exports.

For a large map with independent areas, Cora may use 2-3 bounded leaf
researchers, on economical enabled models at low effort. They inspect distinct
areas and write their own notes, without editing source code. The manager
reconciles the cross-module relationships. Small maps and modes without workers
use direct reading. This uses the existing worker scheduler and model allowlist;
there is no additional provider account or mandatory worker cost.

## Tools and review contract

- `codara_whiteboard_get` returns the board, revision, and structural issues.
- `codara_whiteboard_update` preserves the existing replace/merge/clear API.
  Every content edit, including a human edit, invalidates the prior review.
- `codara_whiteboard_arrange` runs Dagre on module interiors and then the graph
  between modules. It retains geometric group membership and semantic content.
  It changes positions, so use it for a new draft or requested layout changes.
- `codara_whiteboard_inspect` renders an isolated instance of the real React
  Flow canvas and returns a PNG image content block with diagnostics and the
  inspected revision. It works while the chat's board is hidden. It does not
  move the user's viewport, select cards, or change the board.
- `codara_whiteboard_review` records the manager's assessment. It requires a
  recent inspection of the current revision, no blocking layout/text issues,
  and readable capture coverage of every card. Large overviews return
  `detailNeeded`; use `nodeIds` to inspect close-ups. Unresolved warnings require
  recorded limitations. Revision checks reject edits during capture/review.

A source check establishes that a referenced file and line exist within the
workspace, not that they prove the claim. Invalid or unavailable references,
isolated cards, missing evidence, and incomplete branch labels are warnings.
Overlaps and clipped titles/bodies block review. Semantic correctness still
requires Cora to read the code and the returned images. A review is explicitly
Cora's assessment, not a machine proof that the map is exhaustive or correct.

The Pi manager extension tracks draft writes. Completion rejections are also
capped at two so failed verification cannot trap a run in a tool retry loop. If it ends without reviewing the
board, it can schedule up to two follow-ups for that user request. Aborted or
failed agent turns do not restart themselves. Persistent capture/verification
failures leave the board labeled as a draft, with instructions to disclose the
limitation. A new user request clears the pending follow-up state.

Review metadata survives run reloads. Portable `.coraboard` files preserve
source evidence; importing a file starts a draft rather than inheriting a review
of another workspace's sources. Saving an untitled board keeps its tab identity
and selection instead of relying on separate open/close state updates.

## Open-source foundation

The editor already uses [React Flow](https://github.com/xyflow/xyflow), which
fits structured code maps and editable node/edge data. Replacing the canvas
would not establish that the relationships are correct. This change adds
[Dagre](https://github.com/dagrejs/dagre) for directed layout and uses
[React Flow's image-capture approach](https://reactflow.dev/examples/misc/download-image)
with `html-to-image` 1.11.11. All three libraries are MIT-licensed. Image
inspection is local to Studio and does not upload the board to a canvas service.

## Verification

`npm test -- 'whiteboard|codara-studio-mcp|pi-cora-extension'` exercises layout,
group separation, cycles, source references, revision/coverage checks, image
transport, and the actual manager extension's bounded continuation wiring.

The Electron tests in `tests/e2e/whiteboard-review.spec.ts` exercise the live
socket, store, renderer, image capture, correction, review, reload, manual-edit
invalidation, clipping detection, and detail crops. They use a controlled source
fixture and no paid model. They establish the tool and enforcement mechanics;
they do not measure a model's architectural understanding on arbitrary projects.
