import { promises as fs } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { CoraWhiteboard } from "@shared/types";
import type { WhiteboardIssue } from "@shared/whiteboard-quality";

interface Inspection {
  revision: number;
  issues: WhiteboardIssue[];
  inspectedAt: number;
  boardUpdatedAt: string;
  nodeIds: string[];
}
const inspections = new Map<string, Inspection>();

export function rememberWhiteboardInspection(runId: string, board: CoraWhiteboard, issues: WhiteboardIssue[], nodeIds: string[]): void {
  const prior = inspections.get(runId);
  const sameRevision = prior?.revision === (board.revision ?? 0) && prior.boardUpdatedAt === board.updatedAt;
  inspections.delete(runId);
  inspections.set(runId, {
    revision: board.revision ?? 0, issues, inspectedAt: Date.now(), boardUpdatedAt: board.updatedAt,
    nodeIds: [...new Set([...(sameRevision ? prior.nodeIds : []), ...nodeIds])],
  });
  if (inspections.size > 100) inspections.delete(inspections.keys().next().value!);
}

export function requireWhiteboardInspection(runId: string, board: CoraWhiteboard): WhiteboardIssue[] {
  const inspection = inspections.get(runId);
  if (!inspection || inspection.revision !== (board.revision ?? 0) || inspection.boardUpdatedAt !== board.updatedAt || Date.now() - inspection.inspectedAt > 10 * 60_000) {
    throw new Error("Inspect the current whiteboard revision before marking it reviewed.");
  }
  const errors = inspection.issues.filter((issue) => issue.severity === "error");
  if (errors.length) throw new Error(`Fix the whiteboard issues and inspect again: ${errors.slice(0, 5).map((issue) => issue.message).join(" ")}`);
  const missing = board.nodes.filter((node) => node.kind !== "group" && !inspection.nodeIds.includes(node.id));
  if (missing.length) throw new Error(`Inspect readable detail crops for these cards before review: ${missing.map((node) => node.id).join(", ")}`);
  return inspection.issues;
}

export async function whiteboardSourceIssues(board: CoraWhiteboard, cwd: string | undefined): Promise<WhiteboardIssue[]> {
  const claims = [...board.nodes, ...board.edges].filter((item) => item.sources?.length);
  if (!claims.length) return [];
  if (!cwd || cwd.startsWith("ssh://")) return [{ code: "sources-unavailable", severity: "warning", ids: [], message: "Local source references could not be checked for this workspace. Verify them with workspace tools." }];
  const issues: WhiteboardIssue[] = [];
  const root = await fs.realpath(cwd).catch(() => resolve(cwd));
  const checked = new Map<string, Promise<boolean>>();
  const check = (source: string) => {
    let result = checked.get(source);
    if (!result) {
      result = (async () => {
        const match = /^(.*?)(?::([1-9]\d*))?$/.exec(source);
        if (!match || isAbsolute(match[1])) return false;
        const file = await fs.realpath(resolve(root, match[1]));
        const path = relative(root, file);
        if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) return false;
        const stat = await fs.stat(file);
        if (!stat.isFile()) return false;
        if (!match[2]) return true;
        if (stat.size > 2 * 1024 * 1024) return false;
        return Number(match[2]) <= (await fs.readFile(file, "utf8")).split("\n").length;
      })().catch(() => false);
      checked.set(source, result);
    }
    return result;
  };
  for (const item of claims) {
    for (const source of item.sources ?? []) {
      if (!await check(source)) issues.push({ code: "invalid-source", severity: "warning", ids: [item.id], message: `Source ${source} could not be resolved to a file and line in this workspace.` });
    }
  }
  return issues;
}
