# Instructions for AI agents

Conventions that keep changes landable in this codebase. They mirror how the
existing code is written; when in doubt, read neighboring files and match them.

## Style

- Match the surrounding code: naming, idiom, and comment density of the file
  you are editing.
- Comments state constraints the code cannot express (why something must
  happen in this order, what invariant a guard protects). Never narrate what
  the next line does, and never write comments addressed to a reviewer.
- No em dashes anywhere: code, comments, docs, or commit messages.

## Verification before committing

- `npm run typecheck:node` and `npm run typecheck:web` must both pass.
- Run the `scripts/test-*.cjs` suites relevant to what you touched (for
  example `node scripts/test-step-lifecycle.cjs` and
  `node scripts/test-loom-steps.cjs` for orchestration changes,
  `node scripts/test-step-live-stream.cjs` for live pass streaming).
  `npm run test:all` runs everything.

## Commits

- Conventional prefix, imperative subject: `feat(scope): ...`,
  `fix(scope): ...`, `docs: ...`. The body explains why, not what.
- Never commit secrets. `.env.releases` is untracked and must stay that way;
  do not read its values into tracked files or logs.

## Releases

- A push to `main` IS a release: the "Release Codara Studio" automation
  builds, signs, and publishes from a pristine worktree of the pushed commit.
- Commits whose subject starts with `release:` are the version-bump records
  the pipeline itself creates; the automation skips them, which is what
  prevents release loops. Do not use that prefix for ordinary work.
- `npm run release:mac|win|all` are the manual entry points
  (`scripts/release.cjs`); they never build from the live working tree.

## Where things live

- Orchestration (automations, looms, steps, workers, triggers, the release
  loop driver) is under `src/main/orchestration/`; steps-only pass streaming
  spans `loom-steps.ts`, `loom-resolve.ts`, `run-store.ts`, and
  `automation-loop.ts`.
- Shared types and catalogs are in `src/shared/`; the renderer reads them via
  `@shared/*`.
- The hub UI for automations is `src/renderer/src/components/automations/`.
