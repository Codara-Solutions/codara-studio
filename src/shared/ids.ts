// Shared opaque-id generator.
//
// Several modules in main and renderer used to keep their own near-identical
// `uid`/`makeId` helper, each producing `${prefix}-${base36 time}-${random}`.
// They are consolidated here so there is a single definition. The ids are
// purely runtime-opaque (workspace ids, tab ids, run/event ids, project-item
// ids) — only the `prefix` carries meaning, the rest just needs to be unique
// enough to avoid collisions within a session.
//
// `src/shared/` is consumed by both the main and renderer bundles, so this
// must stay dependency-free and isomorphic (no node/electron/DOM globals).

/**
 * Build an opaque, reasonably-unique id of the form
 * `${prefix}-${timestamp36}-${random}`.
 *
 * The timestamp keeps generated ids roughly sortable by creation time; the
 * random suffix guards against collisions when several ids are minted inside
 * the same millisecond.
 */
export function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
