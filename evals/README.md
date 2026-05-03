# Spark Agent — Eval Harness

A model/CLI-agnostic harness that scores any agent (Spark Agent, Claude Code,
Codex CLI, raw OpenRouter, Aider, Cline, …) against the same hard,
professional-grade software tasks. The point of this harness is to produce
a real, comparable number for "did the agent one-shot it?" — not for cost
or speed.

## Layout

```
evals/
  README.md                 — this file
  run-pilot.cjs             — orchestrate one task + one adapter end-to-end
  lib/
    runner.js               — Runner adapter contract + small helpers
    openrouter.js           — auth + chat-completion client (re-uses Spark settings)
    judge-panel.js          — 3-judge OpenRouter panel + aggregation
    seed-repo.js            — fresh working tree at recorded seed commit
    gate-runner.js          — runs public + hidden gates
    record-result.js        — emits normalized eval-result.json
  adapters/
    claude_best_single.js   — strongest single-agent Claude Code run
    spark_full.js           — Spark Agent full orchestration
  configs/
    *.json                  — variant configs (the pipeline pin per run)
  lib/
    variant-config.js       — config loader, Spark-settings verifier, routing extractor
  rubrics/
    professional-grade-code.json
  suites/
    frontier-one-shot.json
  tasks/
    safe-worker-command-construction/
      plan.md               — the user's plan (the prompt)
      seed.json             — pinned commit SHA
      task.json             — paths, gates, blind-list metadata
      public-gates.json     — visible gates (the agent is told about these)
      hidden-gates/         — adversarial fixtures (kept secret)
  results/
    *.json                  — eval-result.json files emitted by run-pilot
  scripts/
    eval-scorecard.cjs      — pretty-print the results dir
    repin-seed.cjs          — re-pin a task's seed to current main HEAD
```

## Running the pilot

```
node evals/run-pilot.cjs --adapter <id> --task <id>
```

Examples:

```
node evals/run-pilot.cjs --adapter claude_best_single --task safe-worker-command-construction
node evals/run-pilot.cjs --adapter spark_full           --task safe-worker-command-construction
```

Useful flags:

- `--config <path>` — pick a variant config (defaults to a per-adapter
  convention; see "Variant configs" below).
- `--skip-config-check` — skip the live-Spark vs config consistency check
  (only meaningful with `spark_full`).
- `--budget 1800` — override the wall-clock budget (seconds).
- `--no-judge` — skip the OpenRouter judge panel (no API key needed).
- `--keep` — keep the temp seed repo on exit, for debugging.

## Variant configs

Spark dynamically picks coder runtime/model per subtask — that routing is
part of Spark's intelligence, and we don't try to hold it constant between
baseline and Spark. Instead, each variant's pipeline is **pinned and
recorded** so two runs of the same variant are reproducible.

Each variant config lives at `evals/configs/<id>.json`. The pilot resolves
a config in this order:

1. `--config <path>` (absolute, or relative to `evals/`).
2. Per-adapter default in `lib/variant-config.js`. Currently:
   - `claude_best_single` → `configs/claude_best_single-opus47-max.json`
   - `spark_full` → `configs/spark_full-grok43.json`
3. None (only allowed for adapters like `noop` that don't need a pin).

### Cost model rationale (why four Spark variants, all share a worker pool)

Workers (Claude Code CLI + Codex CLI) bill against fixed-rate
subscriptions — once the seat is paid for, additional tokens are
essentially free. Spark's manager calls, on the other hand, go through
OpenRouter at pay-per-token. **The manager model is the only variable
Spark cost.** So the eval is interested in *which manager + always-max
worker pool best beats raw frontier-Claude alone*, not in normalizing
costs across providers.

Concretely: all four `spark_full-*` configs share the same worker pool
(`claude-opus-4-7` at effort `max` and `gpt-5.5` at effort `xhigh`).
Only the manager differs.

| Variant | variantId | Manager (OpenRouter) | Effort | Notes |
|---|---|---|---|---|
| spark_full-grok43.json **(default)** | `spark_full_grok43` | `x-ai/grok-4.3` | `max` | cheapest credible manager |
| spark_full-sonnet46.json | `spark_full_sonnet46` | `anthropic/claude-sonnet-4-6` | `max` | same family as worker |
| spark_full-gpt55.json | `spark_full_gpt55` | `openai/gpt-5.5` | `xhigh` | OpenAI frontier |
| spark_full-gemini25.json | `spark_full_gemini25` | `google/gemini-2.5-pro` | `high` | Gemini's top tier |

Plus the single baseline:

| Variant | variantId | Agent | Model | Effort |
|---|---|---|---|---|
| claude_best_single-opus47-max.json | `claude_best_single_opus47` | Claude Code CLI | `claude-opus-4-7` | `max` |

#### A note on `effort`

The provider-native effort enum varies. We do NOT normalize: each config
records the string the underlying provider accepts, and the harness passes
it through to OpenRouter (or the CLI flag) as-is.

- Anthropic via OpenRouter: `low | medium | high | max` (we pass `max`).
- OpenAI: `minimal | low | medium | high | xhigh` (we pass `xhigh`).
- Grok-4.3: documented as `low | medium | high`; we pass `max` and rely
  on OpenRouter to clamp/ignore if the model rejects it.
- Gemini 2.5 Pro: `low | medium | high` only — there is no `max`/`xhigh`,
  so we pass `high` (the literal top tier) rather than inventing one.

This means the eval-result records the actual provider string the run
used. If two records share a `variantId` but their `pipeline.config.effort`
strings differ, treat them as different variants.

### Schemas

Single-agent variant (e.g. `claude_best_single`):

```json
{
  "variantId": "claude_best_single_opus47",
  "agent": "claude_code",
  "model": "claude-opus-4-7",
  "effort": "max"
}
```

Spark variant (the default `spark_full-grok43.json`):

```json
{
  "variantId": "spark_full_grok43",
  "agent": "spark",
  "manager": {
    "model": "x-ai/grok-4.3",
    "effort": "max",
    "profilePath": "resources/orchestration/manager-profile.json"
  },
  "pool": [
    { "runtime": "claude_code", "model": "claude-opus-4-7", "effort": "max" },
    { "runtime": "codex",       "model": "gpt-5.5",         "effort": "xhigh" }
  ],
  "perRoleOverrides": {
    "visual_review": { "runtime": "openrouter", "model": "anthropic/claude-opus-4-7" }
  }
}
```

`manager.profileHash` is **computed at run time** by hashing the file at
`manager.profilePath` — never authored into the config. The pilot writes
the hash into each `eval-result.json` under
`pipeline.configResolved.profileHash` so the scorecard can detect when
two records nominally share a `variantId` but ran against different
manager profiles.

### Spark settings consistency check

Spark runs in MANUAL mode (operator drives the desktop UI), so the harness
does **not** mutate Spark's settings — it verifies them. At kickoff the
pilot:

1. Reads `~/.SparkAgent/spark-settings.json`.
2. Hashes the configured `manager.profilePath`.
3. Compares manager model + profile presence to the variant config.
4. Aborts with a list of mismatches and a `--skip-config-check` hint when
   any mismatch is found.

The pool list is recorded for transparency but not enforced (Spark's
runtime detection is the live source of truth for what's actually
runnable).

### Adding a new variant

1. Drop a new JSON file under `evals/configs/`.
2. Pick a unique `variantId` — the scorecard groups rows by it.
3. (Spark) Make sure the operator's live Spark settings + manager profile
   match before you run.
4. Run with `--config evals/configs/<your-file>.json`.
5. The result file's `pipeline.config` field will reflect the variant; the
   `pipeline.routing` field is filled in from `run.json` (Spark) or
   synthesized as a single entry (single-agent baselines).

### Required environment

| What | Where |
|---|---|
| OpenRouter API key | `SPARK_OPENROUTER_API_KEY` env, `OPENROUTER_API_KEY` env, or `~/.SparkAgent/spark-settings.json` (`openRouterApiKey`) |
| Claude Code CLI | `npm i -g @anthropic-ai/claude-code` then `claude` once to log in (only needed for `claude_best_single`) |

## Adapters

Each adapter implements the `Runner` contract documented in
`evals/lib/runner.js`:

```js
runner.run({ seedRepoPath, planFile, env, budgetSeconds, taskId, runId })
  -> Promise<RunnerResult>
```

The harness has zero knowledge of any specific agent — adding a new one is
a new file under `evals/adapters/` plus its name in the suite manifest.

### Adding a new adapter

1. Create `evals/adapters/<id>.js` with `module.exports = { createRunner }`.
2. `createRunner(opts)` returns `{ id, label, async run(input) }`.
3. `run(input)` must return a `RunnerResult` with the fields documented in
   `lib/runner.js`. Use `runnerLib.event(...)` for transcript entries and
   `runnerLib.captureDiff(...)` if you don't want to compute the diff
   yourself (you don't).
4. Add the adapter id to `evals/suites/frontier-one-shot.json`.
5. If your adapter needs a binary on PATH, fail with a clear `Error` from
   `run()` if it's missing — the pilot surfaces that to the user verbatim.

### Judging is blinded

The pilot strips variant labels from the diff before sending it to the
judge panel: each task's `task.json` has a `judgeBlindList` of strings
(`"spark"`, `"claude_best_single"`, etc.) that are replaced with `VARIANT`
before the model sees the diff. We also augment the list at runtime with
the adapter's `id` and `label`. Judges score on the merits of the code.

When comparing two diffs (a future feature for head-to-head runs), the
panel randomizes A/B order independently per judge.

## Tasks

A task is a directory under `evals/tasks/<id>/` with these files:

- `plan.md` — the user-facing plan (handed to the agent as its prompt).
  This is what the agent sees. Hidden gates MUST NOT leak into this file.
- `seed.json` — pinned commit SHA the harness resets to before each run.
- `task.json` — paths, gates, judge blind-list, budget.
- `public-gates.json` — array of commands the harness runs against the
  final repo. The agent is told about these in the plan.
- `hidden-gates/*.cjs` — adversarial fixtures, one per file. Each module
  exports `{ id, description, run({ finalRepoPath, taskDir }) }` returning
  `{ ok, message }`. These are kept secret from the agent.

### Adding a new task

1. Create `evals/tasks/<id>/` with the files above.
2. Pin the seed: `node evals/scripts/repin-seed.cjs <id>` records the
   current main HEAD into `seed.json`.
3. Reference the task in `evals/suites/frontier-one-shot.json`.
4. Hidden gates use `evals/tasks/<id>/hidden-gates/_lib.cjs` to find the
   agent's exports without knowing where the agent put them. They compile
   TS files with the project's own typescript install (no extra deps).

### Hidden gate authoring rules

- Adversarial mindset: ask "what's the obvious-but-wrong solution?" then
  write a fixture that catches it.
- Each gate runs against the final repo — load the agent's modified code
  and assert structured behaviour. Source-text greps are a fallback only.
- A gate must return within 60s.
- One gate per file, named `NN-short-handle.cjs` so they sort.
- Every fail message should be specific — quote what was expected and what
  was actually returned.

## Scoring

Each `eval-result.json` has a `headline.score` (0..5) blending:

- Judge panel mean (rubric weight 0.6 by default).
- Hidden-gate pass ratio scaled to 0..5 (gate weight 0.4).

`headline.passed` is a hard boolean: it's `true` only when public gates are
green AND hidden gates are all green AND the adapter exited `completed`.

The rubric (`rubrics/professional-grade-code.json`) is the prompt scaffold
for the judges. It scores 6 dimensions (correctness, robustness, polish,
tests, fit, deployability) with explicit anchors. Per-dimension disagreement
greater than 2 across judges is flagged in `flaggedDisagreements`.

## What's intentionally not here

- Codex adapter — out of scope for the eval slice.
- Headless Spark — the `spark_full` adapter currently asks the operator to
  drive the desktop UI manually, then watches `~/.SparkAgent/runs/` for
  terminal state. AUTO mode is wired but waits on Spark gaining a `--eval`
  CLI flag (next-step roadmap).
- Cost telemetry — we measure quality, not dollars.
