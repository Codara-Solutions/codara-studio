# Contributing to Codara Studio

Thanks for wanting to make Codara Studio better. This page gets you from a
fresh clone to a merged pull request. The rules here apply to people and AI
coding agents alike. Agents also follow [AGENTS.md](./AGENTS.md).

## 1. Set up

You need:

- **Node 22 or newer.** `.nvmrc` pins the version CI uses.
- **A C++ toolchain.** `npm install` builds the native modules
  (`node-pty`, `sodium-native`) for Electron.
- **Python 3.8 or newer.** The Claude Code hook script needs it.
- **gitleaks.** The pre-commit hook refuses to commit without it:
  `brew install gitleaks`, `winget install Gitleaks.Gitleaks`, or a binary
  from [its releases](https://github.com/gitleaks/gitleaks/releases) on Linux.

Then:

```sh
npm install     # also installs the git hooks and patches the bundled Pi sign-in page
npm run dev     # starts the app with hot reload
```

CI runs only on macOS. The app also packages for Windows and Linux
(`npm run package:win`, `npm run package:linux`), but CI does not test
them.

**Your real data.** A dev build uses the same `~/.codarastudio` as an
installed Codara Studio. It also writes the same hooks and MCP entries into
the Claude Code, Codex and Grok config files
([on-your-machine.md](./docs/on-your-machine.md) lists them). To keep a dev
instance apart, give it its own home: see "A separate dev instance" in the
[codebase tour](./docs/codebase-tour.md#5-run-test-debug).

## 2. Find your way around

Read these first, in this order:

1. [docs/codebase-tour.md](./docs/codebase-tour.md): where things are, the
   main flows traced through real files, and a "where do I start" table.
2. [docs/architecture.md](./docs/architecture.md): how the parts fit and why.
3. [docs/glossary.md](./docs/glossary.md): what run, step, worker, loom and
   account mean in this code.
4. [scripts/README.md](./scripts/README.md): how the tests work and which
   suites cover what.

## 3. Make the change

- **Branch from `main`.** Keep one logical change per pull request: a fix
  and a refactor are two pull requests.
- **Match the code around you**: naming, idiom, how dense the comments are.
  Comments explain constraints the code cannot show (why this order, what a
  guard protects). They do not narrate the next line.
- **No em dashes** in new code, comments, docs or commit messages. Older
  files still contain some. Leave those alone unless you are rewriting that
  line anyway.
- **Keep the legacy names** that other programs depend on: the `SPARK_*`
  environment variables and the `spark-*.json` files. Renaming one needs an
  alias and a migration.
- **Add or update a test.** Unit suites are plain Node scripts in `scripts/`
  that `npm test` finds by name. [scripts/README.md](./scripts/README.md)
  explains how to write one. A flow that needs the real app goes in a
  Playwright spec in `tests/e2e/`.

## 4. Check it

Before you push:

```sh
npm run typecheck           # node, web and e2e projects; CI runs all three
npm test -- <regex>         # the suites for the area you touched
```

For example, `npm test -- loom-steps` covers automation steps and
`npm test -- terminal-agent-notify` covers the terminal notifier. `npm test`
with no filter runs everything and takes a while. If your change is visible
in the app, try it in `npm run dev`. `npm run test:e2e` builds the app and
runs the Playwright specs.

Suites that need real subscriptions or the network are the `smoke:*`
scripts. They are not part of `npm test` and you do not need them for a
normal change.

## 5. Commit

- Use a conventional prefix and an imperative subject:
  `feat(scope): ...`, `fix(scope): ...`, `docs: ...`, `refactor(scope): ...`,
  `test(scope): ...`. The body explains why, not what.
- The subjects decide the release version: a breaking change carries `!`
  or a `BREAKING CHANGE:` footer and bumps the major; a `Release: minor`
  trailer marks a milestone; everything else bumps the patch. Still use
  `feat:` for features and `fix:` for fixes: `CHANGELOG.md` is built from
  those subjects.
- Do not start a subject with `release:`. That prefix is reserved for the
  version-bump commits the manual release script creates.
- Never commit secrets. `.env.releases` is untracked and must stay that way.
  See "Secrets" below.

### Secrets

gitleaks scans twice, with the same `.gitleaks.toml`: the pre-commit hook
scans what you stage, and the `Gitleaks` workflow scans every commit a pull
request adds. Tests often need values that look like real keys. Make them
obviously fake so neither scan stops you:

- Put them in a fixture path: `tests/`, `fixtures/`, `__mocks__/`, or a unit
  suite directly in `scripts/` (`scripts/test-*.cjs`, `scripts/test-*.mjs`).
- Anywhere else, put `FAKE_` (capitals) on the same line, in the value or the
  name: `const FAKE_GITHUB_TOKEN = "ghp_..."` or `"sk-ant-api03-FAKE_0123..."`.
- Placeholders such as `YOUR_API_KEY`, `CHANGE_ME` or `<token>` are allowed
  everywhere.

If the scan flags a real secret, take it out of the history (not just the
latest commit) and rotate it. Do not widen the allowlist to make a finding go
away; the workflow reads the config from the base branch, so a pull request
cannot allowlist its own finding anyway.

## 6. Open a pull request

- Open it against `main` and fill in the template: what changed and why,
  how you tested it, anything the reviewer should know. Add screenshots for
  UI changes.
- CI (`.github/workflows/ci.yml`) runs the three typechecks, a build and
  every unit suite on macOS. Keep it green.
- Keep it small. `PR hygiene` (`scripts/check-pr-hygiene.cjs`) counts the
  added and deleted lines, leaving out lockfiles and `docs/`: above 800 it
  warns, above 2,000 it fails unless the pull request has the `large-pr`
  label. Split big work behind a flag instead where you can.
- Branch from the branch you merge into. `PR hygiene` also fails when your
  branch carries pull requests that are already merged (squash commits
  ending in `(#123)`), and prints the `git rebase --onto` that removes them.
- A maintainer must approve the pull request before it merges.
  `.github/CODEOWNERS` requests the reviewers automatically.
- You do not release anything yourself. A nightly workflow ships everything
  merged into `main` since the last release, which is why nothing should
  reach `main` without review. [docs/releasing.md](./docs/releasing.md)
  describes the pipeline.

Found a security problem? Do not open an issue. Follow
[SECURITY.md](./SECURITY.md).

## Dependency policy

The agent runtime (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`,
`pi-web-search`, `@modelcontextprotocol/sdk`) and Electron are pinned to
exact versions on purpose. Bump them in a dedicated pull request that runs
the Pi suites (`npm test -- pi-`) and the OAuth branding check
(`npm test -- pi-oauth-branding`).

## Licensing of contributions

By opening a pull request you agree that your contribution is licensed under
the repository's [LICENSE](./LICENSE) (MIT) and may be distributed under it.
