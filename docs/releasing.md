# Releasing

There are two pipelines. The GitHub Actions one is canonical.

## CI release (nightly, or on demand)

`.github/workflows/release.yml` runs at 03:00 UTC every day and whenever you
run `gh workflow run Release`. Each run ships everything merged to `main`
since the last `vX.Y.Z` tag as one release; a run with nothing new is skipped
by the version step. Branch protection requires the CI `test` check on an
up-to-date branch, so the last PR merged before a run was tested on the exact
tree that ships. The workflow:

1. `prepare` computes the next version with `scripts/ci-version.cjs`. A `!`
   or `BREAKING CHANGE` bumps the major, a `Release: minor` line bumps the
   minor, and anything else, including `feat:`, bumps the patch. No commits
   since the highest tag, or a HEAD beginning with `release: v`, skips the run.
   Only the canonical repository's `main` branch can release.
2. `test` runs `npm ci`, `npm run typecheck`, `npm run build`, Playwright
   Chromium install, and `npm run test:all`. A red test means no release.
3. `build` writes the version into its local `package.json`, signs and
   notarizes macOS, and cross-builds the unsigned Windows NSIS installer.
   Both platforms must finish before `release-bundle.cjs` validates the
   feeds and saves the binaries, feeds, and a manifest containing their
   SHA-512 checksums, source commit, version, and original run ID. The
   immutable `release-bundle` Actions artifact is retained for 90 days.
4. `tag` verifies the saved artifact and creates `vX.Y.Z` using a dedicated
   GitHub App. An existing tag must point to the exact built commit. A
   rejection stops publication. A newer tag also blocks an older release.
5. `publish` rechecks the tag, uploads all binaries without overwriting
   existing objects, then promotes the two feeds. Existing binaries must
   have matching stored checksums and sizes. Feed updates use ETag conditions
   and refuse a rollback or different contents under the same version.
   Running apps receive the release notification after both feeds succeed.

Tags reserve version numbers; a tag alone does not prove publication finished.
The two feed updates are separate storage operations, so a failure between
them can briefly leave platforms on different versions. Recovery completes
the remaining operations using the original bytes.

### Recovering a failed release

Use **Re-run failed jobs** when the build succeeded. To recover in a new run:

```sh
gh workflow run Release --ref main -f resume_run_id=ORIGINAL_RUN_ID
```

The source must be a `main` Release run in this repository with an unexpired
`release-bundle` artifact. Recovery verifies the artifact's origin and every
file checksum, and skips rebuilding. It does not recalculate the version.
Never delete or move a release tag to retry, and never rebuild an already
tagged version. Once a newer release exists, recovery of the old one stops.

**Re-run all jobs** is rejected for a normal release because it could replace
the original build. If no bundle was saved, start a new Release run. A normal
nightly run does not automatically recover a tagged but unpublished version;
use the original run ID. If its artifact expired or was deleted, release a
new commit with a new version instead of reconstructing the old artifacts.

### GitHub App setup

An organization owner can run `node scripts/setup-release-app.cjs` and open
the printed local URL in a signed-in browser. The preconfigured registration
creates a private organization-owned App with Contents and Workflows write.
Install it with **Only select repositories**, selecting `codara-studio` only.
The helper stores its private key directly through GitHub CLI stdin and never
writes the key to disk. Keep the helper running until registration completes.

The `release-tag` environment must allow only the `main` branch and contain:

- Variable `RELEASE_APP_ID`: the dedicated App's ID.
- Secret `RELEASE_APP_PRIVATE_KEY`: its PEM private key.

The helper creates this environment and branch policy if absent; it refuses
to weaken existing protection. For manual setup, configure the same values
in repository settings. Missing App configuration fails explicitly. There is
no PAT, deploy key, or `GITHUB_TOKEN` fallback. The tagging job requests a
repository-scoped installation token, which is revoked when the job ends.
Build and publication jobs never receive the App private key or token.

The tracked `package.json` version is not bumped; tags are the source of
truth. `Settings, About` under `npm run dev` shows the nearest reachable
release tag, commits since that tag, and the commit hash, for example
`v1.6.7-dev.0+g806bfd1`. Without release tags it falls back to the tracked
package version with a `-dev` suffix. Packaged builds show the release version
written into `package.json` by the release pipeline.

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

The manual pipeline does not participate in Actions concurrency or the saved
bundle protocol. Do not run it concurrently with CI or use it to retry a CI
release. Prefer the recovery command above for publication failures.

## Verifying a release

Installers and the update feed are served from
`https://studio.codarasolutions.com/releases/`. `latest.yml` and
`latest-mac.yml` carry a base64 SHA-512 per file; see `SECURITY.md` for how to
compare it.

### Immediate update notification

After publishing both feeds, `publish-release-bundle.cjs` asks GitHub Actions
for an OIDC token and notifies the website's `/hooks/releases` endpoint.
The publish job has `id-token: write`; the website accepts only its
main-branch workflow and immutable repository ID. Tokens are never logged.
Manual releases and temporary notification failures use the website's existing
60-second feed poll. Desktop clients reconnect stalled event streams, replay
missed events where available, and reconcile with the release feed after gaps.
