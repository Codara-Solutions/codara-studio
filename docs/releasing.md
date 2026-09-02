# Releasing

There are two pipelines. The GitHub Actions one is canonical.

## CI release (every push to `main`)

`.github/workflows/release.yml`:

1. `test` job: `npm ci`, `typecheck:node`, `typecheck:web`, `typecheck:e2e`,
   `npm run build`, Playwright Chromium install, `npm run test:all`. A red test
   means no release.
2. `release` job: refuses to run without the signing and bucket secrets;
   `scripts/ci-version.cjs` computes the next version from the highest
   `vX.Y.Z` tag and the commits since it (a `!` or `BREAKING CHANGE` bumps
   the major, a `Release: minor` line in any commit body bumps the minor,
   anything else, `feat:` included, bumps the patch), and writes it into
   `package.json` inside the runner only. Every merge to `main` ships, so
   the minor is reserved for releases you decide to call a milestone. A HEAD
   whose subject starts with `release:` is skipped.
3. `npm run package:mac` signs and notarizes with the Developer ID
   certificate, `scripts/publish-release.cjs mac` uploads the DMG, ZIP, and
   `latest-mac.yml` to the release bucket. `npm run package:win` cross-builds
   the NSIS installer (unsigned) and publishes it with `latest.yml`.
4. The workflow pushes the `vX.Y.Z` tag. Running apps hear the SSE push from
   `studio.codarasolutions.com` and self-update through electron-updater.

The tracked `package.json` version is not bumped; tags are the source of
truth. `Settings, About` in a dev build therefore shows the tracked value.

Secrets used: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, `RELEASES_BUCKET`,
`RELEASES_S3_ENDPOINT`, `RELEASES_S3_REGION`, `RELEASES_S3_ACCESS_KEY_ID`,
`RELEASES_S3_SECRET_ACCESS_KEY`.

## Manual release (`npm run release:mac|win|all`)

`scripts/release.cjs` builds from a pristine `git worktree` at HEAD, bumps
the version there with `npm version` from the commits since the last
`release: vX.Y.Z` commit, signs and notarizes when `.env.releases` carries the
Apple credentials, uploads, and cherry-picks the `release: vX.Y.Z` bump commit
back onto your branch. `RELEASE_BUMP=major|minor|patch` overrides the bump.

Caveat: this pipeline counts from the last `release:` commit and the tracked
`package.json`, while CI counts from tags. After CI has released, run the
manual pipeline only after setting `package.json` to the latest tag, or you
will publish a version below the one users already have.

## Verifying a release

Installers and the update feed are served from
`https://studio.codarasolutions.com/releases/`. `latest.yml` and
`latest-mac.yml` carry a base64 SHA-512 per file; see `SECURITY.md` for how to
compare it.
