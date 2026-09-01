# Contributing to Codara Studio

Thanks for wanting to make Codara Studio better. A few ground rules keep the
project healthy and your work easy to land.

## How changes land

- Fork the repository and open a pull request against `main`. Branch
  protection requires one approving review.
- One logical change per PR. A fix and a refactor are two PRs.
- Pull requests run the `CI` workflow (typechecks, a build, and the full unit
  registry on macOS). Please keep it green.
- Pushes to `main` trigger the automated release pipeline, so nothing should
  reach `main` outside a reviewed merge.

## Before you submit

- Use Node 22 or newer (see `.nvmrc`). `npm install` builds native modules,
  so you need a C++ toolchain; the Claude Code hook script needs Python 3.8+.
- Run `npm run typecheck` (node, web, and e2e projects must all pass).
- Run the unit suites relevant to what you touched with `npm test -- <regex>`,
  for example `npm test -- loom-steps` for automation step changes or
  `npm test -- terminal-agent-notify` for the terminal notifier. `npm test`
  runs everything. `npm run test:e2e` runs the Playwright specs against a
  fresh build.
- Match the commit style you see in `git log`: a conventional prefix
  (`feat(scope):`, `fix(scope):`, `docs:`), imperative mood, and a body that
  explains why. The subject decides the release bump, so a feature is `feat:`
  and a breaking change carries `!`. Do not add em dashes in new code or prose.
- A gitleaks pre-commit hook runs on `git commit`; install gitleaks
  (`brew install gitleaks` or `winget install Gitleaks.Gitleaks`).

## Dependency policy

The agent runtime (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`,
`pi-web-search`, `@modelcontextprotocol/sdk`) and Electron are pinned to
exact versions on purpose. Bump them in a dedicated PR that runs the Pi
suites (`npm test -- pi-`) and the OAuth branding check.

## Licensing of contributions

By opening a pull request you agree that your contribution is licensed under
the repository's [LICENSE](./LICENSE) (MIT) and may be distributed under it.
