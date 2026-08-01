import { createHash } from "node:crypto";
import type { RemoteCoraRunSummary } from "./rpc";

export const CORA_HISTORY_DELTA_VERSION = 1 as const;
const MAX_REVISIONS_PER_WORKSPACE = 2;
const MAX_WORKSPACES = 24;
const MAX_RETAINED_BYTES = 4 * 1024 * 1024;

export type CoraHistoryWireResult =
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
        version: typeof CORA_HISTORY_DELTA_VERSION;
        baseRevision: string;
        upserts: RemoteCoraRunSummary[];
        order: string[];
      };
      revision: string;
    };

interface RetainedProjection {
  revision: string;
  runs: RemoteCoraRunSummary[];
  bytes: number;
}

interface WorkspaceHistory {
  projections: RetainedProjection[];
}

/**
 * Small process-local optimization cache. Authoritative history is always
 * supplied by the caller; retained projections are used only to encode a
 * smaller equivalent response.
 */
export class CoraHistoryDeltaCache {
  private readonly workspaces = new Map<string, WorkspaceHistory>();
  private retainedBytes = 0;

  project(input: {
    workspaceId: string;
    runs: RemoteCoraRunSummary[];
    ifRevision?: string;
    deltaVersion?: number;
  }): CoraHistoryWireResult {
    const current = freezeProjection(input.runs);
    const revision = historyProjectionRevision(current.runs);
    if (input.ifRevision === revision) {
      this.retain(input.workspaceId, { ...current, revision });
      return { notModified: true, revision };
    }

    const base =
      input.deltaVersion === CORA_HISTORY_DELTA_VERSION && input.ifRevision
        ? this.find(input.workspaceId, input.ifRevision)
        : undefined;
    const full: CoraHistoryWireResult = { runs: current.runs, revision };
    let result: CoraHistoryWireResult = full;
    if (base) {
      const delta = buildDelta(base, current.runs, revision);
      if (
        delta &&
        Buffer.byteLength(JSON.stringify(delta), "utf8") <
          Buffer.byteLength(JSON.stringify(full), "utf8")
      ) {
        result = delta;
      }
    }
    this.retain(input.workspaceId, { ...current, revision });
    return result;
  }

  retainedBytesForTest(): number {
    return this.retainedBytes;
  }

  workspaceCountForTest(): number {
    return this.workspaces.size;
  }

  private find(
    workspaceId: string,
    revision: string,
  ): RetainedProjection | undefined {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) return undefined;
    this.touch(workspaceId, workspace);
    return workspace.projections.find(
      (projection) => projection.revision === revision,
    );
  }

  private retain(
    workspaceId: string,
    projection: RetainedProjection,
  ): void {
    if (projection.bytes > MAX_RETAINED_BYTES) return;
    let workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      workspace = { projections: [] };
      this.workspaces.set(workspaceId, workspace);
    }
    const existing = workspace.projections.findIndex(
      (candidate) => candidate.revision === projection.revision,
    );
    if (existing >= 0) {
      this.touch(workspaceId, workspace);
      return;
    }
    workspace.projections.push(projection);
    this.retainedBytes += projection.bytes;
    while (workspace.projections.length > MAX_REVISIONS_PER_WORKSPACE) {
      const removed = workspace.projections.shift();
      if (removed) this.retainedBytes -= removed.bytes;
    }
    this.touch(workspaceId, workspace);
    this.evict();
  }

  private touch(workspaceId: string, workspace: WorkspaceHistory): void {
    this.workspaces.delete(workspaceId);
    this.workspaces.set(workspaceId, workspace);
  }

  private evict(): void {
    while (
      this.workspaces.size > MAX_WORKSPACES ||
      this.retainedBytes > MAX_RETAINED_BYTES
    ) {
      const oldest = this.workspaces.entries().next().value as
        | [string, WorkspaceHistory]
        | undefined;
      if (!oldest) break;
      this.workspaces.delete(oldest[0]);
      for (const projection of oldest[1].projections) {
        this.retainedBytes -= projection.bytes;
      }
    }
  }
}

function freezeProjection(runs: RemoteCoraRunSummary[]): {
  runs: RemoteCoraRunSummary[];
  bytes: number;
} {
  // The service gives this cache a fresh bounded DTO projection. Clone it so
  // later service/test mutation cannot rewrite a retained revision in place.
  const serialized = JSON.stringify(runs);
  return {
    runs: JSON.parse(serialized) as RemoteCoraRunSummary[],
    bytes: Buffer.byteLength(serialized, "utf8"),
  };
}

function buildDelta(
  base: RetainedProjection,
  current: RemoteCoraRunSummary[],
  revision: string,
): CoraHistoryWireResult | null {
  const baseById = uniqueById(base.runs);
  const currentById = uniqueById(current);
  if (!baseById || !currentById) return null;
  const upserts: RemoteCoraRunSummary[] = [];
  for (const summary of current) {
    const previous = baseById.get(summary.id);
    if (!previous || JSON.stringify(previous) !== JSON.stringify(summary)) {
      upserts.push(summary);
    }
  }
  return {
    historyDelta: {
      version: CORA_HISTORY_DELTA_VERSION,
      baseRevision: base.revision,
      upserts,
      order: current.map((summary) => summary.id),
    },
    revision,
  };
}

function uniqueById(
  runs: RemoteCoraRunSummary[],
): Map<string, RemoteCoraRunSummary> | null {
  const result = new Map<string, RemoteCoraRunSummary>();
  for (const run of runs) {
    if (!run.id || result.has(run.id)) return null;
    result.set(run.id, run);
  }
  return result;
}

function historyProjectionRevision(runs: RemoteCoraRunSummary[]): string {
  return createHash("sha256")
    .update(JSON.stringify(runs))
    .digest("base64url");
}

export const coraHistoryDeltaCache = new CoraHistoryDeltaCache();
