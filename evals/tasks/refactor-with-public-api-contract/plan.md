# Rename `loadSettings` to `getAppSettings` across the main process

`src/main/storage.ts` exposes a lazy-cached settings reader as
`loadSettings()`. The name has bothered me on review for two reasons:

1. The function does NOT actually load on every call — it returns the
   in-memory cache after the first read. `load*` reads to a reviewer
   like a side-effecting I/O call every time, which it isn't.
2. The companion writer is `saveSettings()`, but `save` is the natural
   pair of `read`/`get`, not `load`. The asymmetry made me misread the
   call sites three times this week. A reader called `getAppSettings()`
   pairs cleanly with the existing `saveSettings()` and conveys
   "give me the current settings" without implying I/O.

Rename `loadSettings` to `getAppSettings` everywhere it appears in
`src/main/`. The function signature, return type, and behavior are
identical — this is a pure name change.

## Invariants

1. **The old name `loadSettings` is gone from `src/main/`.** No
   leftover imports, no dead re-exports, no comments-with-leftover
   reference. The function is renamed at its declaration in
   `storage.ts` and at every call site.

2. **The new name `getAppSettings` is exported from `storage.ts`** with
   the same signature: `(): Promise<AppSettings>`.

3. **Every caller in `src/main/` is updated.** Both the import line
   and the invocation. There are at least two caller files outside
   `storage.ts`. Find them all (a grep of `src/main/` for the old name
   is the obvious starting point) and update them consistently.

4. **`npm run typecheck` is green.** A missed call site or a typo in
   the new name will fail typecheck — that's the canary.

5. **A short `CHANGELOG-eval.md` documents the rename.** Single-file
   changelog at the repo root, not under `src/`. Two lines minimum:
   the old name, the new name, and a one-line rationale (paraphrase
   the "why" from this plan).

## Constraints

- Do not touch `src/renderer/`, `src/preload/`, or `src/shared/`. The
  rename is main-process-internal; the IPC surface is unchanged.
- Do not rename the companion writer `saveSettings`. The reader/writer
  asymmetry resolves with this single rename.
- Do not introduce a deprecation alias (no `export const loadSettings = getAppSettings`).
  This is a backwards-incompatible rename within the main process; we
  want zero references to the old name when you're done.
- Keep the cache, normalization, and override paths
  (`applyInMemorySettingsOverride`, `readSettingsFromDisk`,
  `normalizeSettings`) untouched. They're not part of the rename.

## Deliverables

- `src/main/storage.ts` — declaration renamed.
- Every `src/main/` caller updated (find them via grep; expect at least
  two files outside `storage.ts`).
- `CHANGELOG-eval.md` at the repo root documenting the rename.
- `npm run typecheck` passes.

When you're done, summarize which files you changed and how many call
sites you updated.
