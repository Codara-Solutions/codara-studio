# Instructions for AI agents

Conventions that keep changes landable in this codebase. They mirror how the
existing code is written; when in doubt, read neighboring files and match them.

## Style

- Match the surrounding code: naming, idiom, and comment density of the file
  you are editing.
- Comments state constraints the code cannot express (why something must
  happen in this order, what invariant a guard protects). Never narrate what
  the next line does, and never write comments addressed to a reviewer.
- Do not introduce em dashes in new code, comments, docs, or commit messages.
  Existing files still contain them; leave those alone unless you are already
  rewriting the line.

## Verification before committing

- `npm run typecheck` must pass (node, web, and e2e projects; CI runs all
  three).
- Run the unit suites relevant to what you touched with
  `npm test -- <regex>` (the registry globs `scripts/test-*.{cjs,mjs}`), for
  example `npm test -- step-lifecycle` or `npm test -- loom-steps` for
  orchestration changes and `npm test -- terminal-agent-notify` for the
  terminal notifier. `npm test` runs everything and takes a while.
- Tests that need a real subscription or network are the `smoke:*` scripts
  and are not part of the registry.

## Commits

- Conventional prefix, imperative subject: `feat(scope): ...`,
  `fix(scope): ...`, `docs: ...`, `refactor(scope): ...`. The body explains
  why, not what. The subject drives the release version bump, so a feature
  must be `feat:` and a breaking change must carry `!` or a
  `BREAKING CHANGE:` footer.
- Never commit secrets. `.env.releases` is untracked and must stay that way;
  do not read its values into tracked files or logs. A gitleaks pre-commit
  hook scans staged changes.

## Releases

- A push to `main` IS a release: the `Release` GitHub Actions workflow tests,
  builds, signs, and publishes the pushed commit and pushes a `vX.Y.Z` tag.
  Tags are the version source of truth; the tracked `package.json` version is
  not bumped by CI.
- Commits whose subject starts with `release:` are the version-bump records
  the manual `scripts/release.cjs` pipeline creates; both pipelines skip them,
  which is what prevents release loops. Do not use that prefix for ordinary
  work.
- `npm run release:mac|win|all` are the manual entry points; they never build
  from the live working tree. See `docs/releasing.md`.

## Where things live

- Electron main process: `src/main/`. Windows and boot in `index.ts`, IPC in
  `ipc.ts`, terminals in `pty-manager.ts`, the loopback JSON-RPC agent socket
  in `agent-socket.ts`, Claude hook ingestion in `hook-installer.ts` /
  `hook-watcher.ts`, terminal-agent notifications in
  `terminal-agent-notify.ts` and `notify/`, phone remote access in
  `remote-access/`, SSH workspaces in `remote/`.
- Orchestration (Cora runs, steps, workers, automations, looms, accounts) is
  under `src/main/orchestration/`. `run-store.ts` is the run state machine;
  steps-only pass streaming spans `loom-steps.ts`, `loom-resolve.ts`,
  `run-store.ts`, and `automation-loop.ts`; accounts span
  `unified-accounts.ts`, `credential-mirror.ts`, and the
  `*-cli-account-profiles.ts` files.
- Shared types and catalogs are in `src/shared/`; the renderer reads them via
  `@shared/*`. `agent-patterns.ts` holds the regexes that recognize agent CLIs
  in terminal output and is shared by main and renderer.
- The React UI is `src/renderer/src/`: `App.tsx` composes everything, tabs in
  `tabs/`, terminals in `components/Terminal/`, Cora chat in
  `components/chat/`, the automations hub in `components/automations/`, runs
  in `components/runs/`, the board and whiteboard in `components/board/` and
  `components/whiteboard/`, keybindings in `shortcuts/`.
- Shipped resources: the MCP server `resources/codara-studio-mcp/server.js`,
  the Claude hook `resources/claude-hooks/codara-hook.py`, the Pi extension
  that implements Cora in `resources/pi-cora/`, shell integration in
  `resources/shell-integration/`, orchestration prompts in
  `resources/orchestration/`.
- The `cora` CLI is `cli/`. Unit tests are `scripts/test-*.cjs`; Playwright
  specs are `tests/e2e/`.
- Environment variables that form the contract with child CLIs, hooks, and
  shells keep the legacy `SPARK_*` prefix (`SPARK_PANE_ID`, `SPARK_MCP_MODE`,
  `SPARK_HOME_DIR`, ...). Do not rename them without an alias and a migration.
