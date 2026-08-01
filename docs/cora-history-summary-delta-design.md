# Cora history summary delta protocol

Status: reviewed design for campaign contribution 076.

## Outcome

Warm `cora.history` reads should transfer only summaries that changed, while
the phone still reconstructs the exact same bounded, ordered conversation
history as a full response. The protocol is additive and capability-gated, so
an old phone or an old Studio continues to exchange full snapshots.

This is intentionally a history-summary protocol. Detailed run messages keep
using the separate `cora.get` message cursor.

## Current boundary

Studio currently:

- reads every run in the workspace;
- excludes automation-owned runs at the service boundary;
- selects at most 50 conversations in creation order;
- builds bounded summaries;
- hashes the complete JSON projection; and
- returns either the complete projection or `notModified`.

Mobile already stores an exact history revision and has an unused history
cursor field, but `cora.history` does not send or consume a delta. Any changed
title, status, worker count, recovery state, cost, model, last message, deletion,
or page-boundary change therefore retransmits the complete history.

The mobile SQLite history row is capped at 80 KiB while Studio currently spends
from a generic 384 KiB collection budget. A full history that Studio accepts can
therefore be rejected by the phone cache. The implementation must use the
shared history budget established by the byte-budget work rather than defining
another local constant.

## Versioned wire contract

The phone opts in:

```ts
interface CoraHistoryParams {
  workspaceId: string;
  ifRevision?: string;
  deltaVersion?: 1;
}
```

Studio may return one of:

```ts
type CoraHistoryResult =
  | {
      runs: RemoteCoraRunSummary[];
      revision: string;
    }
  | {
      notModified: true;
      revision: string;
    }
  | {
      historyDelta: {
        version: 1;
        baseRevision: string;
        upserts: RemoteCoraRunSummary[];
        order: string[];
      };
      revision: string;
    };
```

`order` is the complete ordered list of run IDs in the new bounded page. This
small canonical spine handles deletion, insertion, and a run crossing the
50-item or byte boundary without relying on timestamps or client sorting.
IDs absent from `order` leave the history page. They are not automatically
treated as deleted runs because an old run may merely have fallen outside the
bounded page.

`upserts` contains every current summary whose canonical JSON differs from the
base snapshot, plus every ID not present in that base. The server hashes the
fully materialized current projection exactly as it does today; a delta never
defines a different revision space.

Studio sends a delta only when all of these are true:

1. `deltaVersion === 1`;
2. `ifRevision` names a retained exact base projection for this workspace;
3. the base projection passed normal ownership and conversation filtering;
4. the generated delta is strictly smaller than the full response; and
5. the delta and full projection both satisfy their exact UTF-8 wire budgets.

Otherwise it sends the full snapshot. A matching current revision still uses
`notModified`, regardless of capability.

## Server retention

Keep a process-local LRU of exact bounded history projections:

- key by authoritative workspace ID and projection revision;
- retain at most two revisions per workspace;
- retain at most 24 workspaces globally;
- charge entries by exact UTF-8 JSON bytes and enforce a small global byte cap;
- replace immutable entries, never mutate them in place; and
- clear naturally on process restart.

No client controls an allocation key other than a workspace it already passed
through `requireLocalWorkspace`. Unknown, expired, malformed, or cross-workspace
revisions simply receive a full snapshot. The cache is an optimization, not
durable state and not an authority source.

The current projection is always built from the run store before comparing it
with a base. Retaining a snapshot must never make deleted or changed runs appear
current.

## Mobile application

Apply a delta only when:

- the request ticket is still the newest ticket for its
  computer/workspace scope;
- a cached history exists;
- its revision exactly equals `baseRevision`;
- every `order` ID is a bounded non-empty string and unique;
- every upsert has a unique ID, belongs to the selected workspace, and is not
  automation-owned; and
- every ID in `order` resolves from either a validated upsert or the exact base.

Materialize a fresh summary map from the exact base, apply upserts, then emit
only `order.map(id => map.get(id))`. Sanitize every upsert with the same
function used for full snapshots and detailed-run summary updates. Commit the
new list and revision atomically. A validation failure is `missing-base`: fence
that response, issue one unconditional full read, and never partially mutate
memory or SQLite.

The UI selection rule runs after the atomic materialization, exactly as for a
full history response. A removed selected ID selects the newest remaining
conversation unless the user is intentionally on the new-conversation screen.

Persisting the materialized row initially preserves the existing crash model.
A later normalized-summary table can avoid the remaining full SQLite row
rewrite; it is independent of this network protocol.

## Why not use timestamps as a cursor

`updatedAt` is not sufficient:

- joined automation/job metadata can change without the run timestamp;
- deletion has no row whose timestamp can be returned;
- the page is ordered by creation time, not update time;
- multiple commits can share a timestamp; and
- a byte-budget or 50-item boundary can change membership.

An opaque run-store event cursor would still need a materialized base to prove
the exact page. Revision-addressed snapshots make fallback and validation
explicit and keep the existing semantic revision.

## Required tests

1. unchanged base returns payload-free `notModified`;
2. one status/title/message/worker/cost/model/recovery change yields one upsert;
3. a new run yields one upsert and a new complete order spine;
4. deletion and 50-item boundary churn reconstruct the exact full projection;
5. joined metadata changes are included even when run `updatedAt` is unchanged;
6. unknown, evicted, post-restart, malformed, and cross-workspace bases fall
   back to full;
7. delta larger than full falls back to full;
8. UTF-8 response accounting includes JSON escaping and envelope bytes;
9. duplicate IDs, wrong-workspace upserts, automation rows, missing base IDs,
   stale tickets, and revision mismatch cause no partial client mutation;
10. one repair read is unconditional and cannot loop;
11. cache hydration followed by a server restart safely receives a full page;
12. old-phone and old-Studio combinations retain the current full-snapshot
    behavior; and
13. benchmark 1, 10, and 50-summary histories for unchanged, one-upsert, new-run,
    deletion, and complete churn, reporting exact request/response UTF-8 bytes.

## Expected data reduction

For a typical 50-row history, an unchanged poll remains only a revision
envelope. A single changing run transfers one summary plus roughly 50 IDs
instead of all 50 summaries. Exact savings depend on titles and last-message
escaping and must be reported by the benchmark, but the design makes the common
warm update proportional to one changed row rather than the whole page.
