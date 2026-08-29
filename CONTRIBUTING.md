# Contributing to Codara Studio

Thanks for wanting to make Codara Studio better. A few ground rules keep the
project healthy and your work easy to land.

## How changes land

- Fork the repository and open a pull request. There are no direct pushes;
  branch protection requires review once the repository is public.
- One logical change per PR. A fix and a refactor are two PRs.
- Maintainers land PRs by squash-merge. Pushes to `main` trigger the
  automated release pipeline, so nothing reaches `main` outside a reviewed
  merge.

## Before you submit

- Run `npm run typecheck` (node, web, and e2e projects must all pass).
- Run the `npm run test:*` suites relevant to what you touched, for example
  `npm run test:loom-steps` for automation step changes or
  `npm run test:step-live-stream` for live pass streaming. `npm run test:all`
  runs everything.
- Match the commit style you see in `git log`: a conventional prefix
  (`feat(scope):`, `fix(scope):`, `docs:`), imperative mood, and a body that
  explains why. Do not use em dashes anywhere, in code or prose.

## Licensing of contributions

By opening a pull request you agree that your contribution is licensed under
the repository's [LICENSE](./LICENSE) (PolyForm Shield 1.0.0) and may be
distributed under it.
