# Fix the OpenRouter "structured output unsupported" classifier

The orchestration manager talks to OpenRouter for plan/step/review JSON
turns. When the chosen model can't honor a `response_format: json_schema`
request — different OpenRouter providers refuse it for different reasons
— the manager is supposed to detect the refusal as "structured output
unsupported" and silently fall back to a smaller model that does support
it. The detection lives in
`src/main/orchestration/openrouter-error-classifier.ts` (re-exported from
`openrouter-manager.ts` so the rest of the codebase keeps importing it
from the manager module).

We've been seeing reports that with certain Mistral and Qwen variants the
manager doesn't fall back — instead it retries the same `response_format`
request 2-3 times, eats the wall-clock budget, and the run stops with a
generic OpenRouter error. The provider-side error in those cases looks
like:

> `Provider returned: "model 'qwen-2.5-coder' does not support json_schema parameters in chat completions; pass response_format type=text or omit it"`

That string contains `json_schema` and `not support` — both should be
strong enough signals for the classifier to recognize the refusal —
but the classifier is missing the case. Compare to the messages we
already handle (the `no endpoints found ... requested parameters` and the
`response_format ... not support` flavors): the third common shape is
slipping through.

## Invariants

1. **The classifier covers all three OpenRouter refusal shapes.** At
   minimum, an error string that contains both `json_schema` and a
   "not support" / "doesn't support" / "unsupported" hint must be
   classified as a structured-output-unsupported refusal — even when
   the leading `response_format` keyword is absent.

2. **A regression test pins this.** Before the fix lands, a test must
   exist that asserts the missing-case input is detected — and that
   test must FAIL on a clean checkout of HEAD. After the fix lands,
   the same test must PASS. Both halves matter: a green test alone
   does not prove the fix; the test must independently catch the
   regression so we don't lose this case again.

3. **The fix is local.** This is a one-function bug in the classifier.
   Do not refactor the call sites, do not move the function, do not
   re-shape the OpenRouter request flow. Restore the missing case and
   leave everything else alone.

4. **Existing public gates stay green.** `npm run typecheck` must pass;
   the regression test must pass when run with the project's test
   harness.

## How to run the regression test

This repo doesn't have jest or vitest installed. Use Node's built-in
test runner with native TypeScript stripping (Node 22+):

```
node --test --experimental-strip-types tests/openrouter-error-classifier.test.ts
```

Use `node:test` and `node:assert/strict` for the test (both built-in).
Import the function under test from
`../src/main/orchestration/openrouter-error-classifier.ts` with the
explicit `.ts` extension — Node's strip-types loader does not probe
TypeScript extensions automatically. Importing from the classifier file
directly (rather than from `openrouter-manager.ts`) keeps the test free
of unrelated transitive imports.

A minimal example skeleton:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isStructuredOutputUnsupportedError } from "../src/main/orchestration/openrouter-error-classifier.ts";

test("classifies json_schema not-support refusal", () => {
  const msg = "Provider returned: model 'qwen-2.5-coder' does not support json_schema parameters in chat completions";
  assert.equal(isStructuredOutputUnsupportedError(msg), true);
});
```

You should add at least one test that targets the regressed case (the
`json_schema` + `not support` combination above) AND keep coverage on the
two cases the function already handles, so future regressions of the
*other* branches are caught too.

## Constraints

- Place the test file at `tests/openrouter-error-classifier.test.ts`
  exactly. The public gate runs against that path.
- The fix belongs in `src/main/orchestration/openrouter-error-classifier.ts`.
  Don't move the function back into `openrouter-manager.ts` and don't
  invent new files for it.
- Stay inside `src/main/orchestration/` and `tests/`.
- Do not add test runner dependencies (`jest`, `vitest`, `ts-node`,
  `tsx`, etc.) to `package.json`. The Node 22 built-in is sufficient.
- Do not skip tests (`.skip`, `.only`, `.todo`, `xit`, `xdescribe`, etc.).
- Do not modify any other source file.

## Deliverables

- Restored case in the classifier function such that the missing
  refusal shape is detected.
- `tests/openrouter-error-classifier.test.ts` with at least:
  - one assertion that catches the regressed case (json_schema +
    not-support without `response_format`).
  - at least one assertion per existing case (so the test pins the
    full classifier surface).

When you're done, summarize the one-line change you made to the
classifier and the test cases you added.
