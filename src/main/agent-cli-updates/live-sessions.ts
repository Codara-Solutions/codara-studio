// How many sessions of an agent CLI run on this machine, in Codara or not.
// An update must never swap a tool under a running session, so anything that
// runs the tool counts, and a process list that cannot be read is "unknown".

import type { UpdatableAgentCliToolId } from "@shared/agent-cli-updates";

import type { CensusProcess } from "../agent-hibernation-census";

/**
 * Sessions among `processes`: processes that run the tool, without the
 * helpers a session starts as its own children (Codex's code-mode host, a
 * re-exec of the same CLI), so one session counts once.
 */
export function countToolSessions(
  processes: readonly CensusProcess[],
  runsTool: (command: string) => boolean,
  selfPid: number,
): number {
  const tool = new Set(processes.filter((entry) => entry.pid !== selfPid && runsTool(entry.command)).map((entry) => entry.pid));
  const parents = new Map(processes.map((entry) => [entry.pid, entry.parentPid]));
  let count = 0;
  for (const pid of tool) {
    if (!tool.has(parents.get(pid) ?? -1)) count += 1;
  }
  return count;
}

export async function liveToolSessions(tool: UpdatableAgentCliToolId): Promise<number | null> {
  const census = await import("../agent-hibernation-census");
  const processes = await census.listCensusProcesses().catch(() => null);
  if (!processes) return null;
  return countToolSessions(processes, (command) => census.commandRunsAgent(command, tool), process.pid);
}
