import { parseRemotePath } from "@shared/remote";
import { getConnection } from "./connections";

// Detect whether an agent CLI is installed on a remote host, so the UI can
// tell the user before they launch a "Worker — Claude/Codex" terminal there.
// Uses the host's own login shell resolution (`command -v` in a login shell)
// so PATH additions from ~/.profile / ~/.bashrc / nvm are honored, exactly
// as they would be when the CLI is typed into a real terminal on the host.

export interface RemoteAgentAvailability {
  hostId: string;
  claude: boolean;
  codex: boolean;
}

async function hasBinary(hostId: string, bin: string): Promise<boolean> {
  try {
    const conn = await getConnection(hostId);
    // Login shell so PATH matches an interactive session.
    const res = await conn.exec(`bash -lc ${quote(`command -v ${bin}`)}`, { timeoutMs: 8000 });
    return res.code === 0 && res.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

function quote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export async function detectRemoteAgents(hostIdOrPath: string): Promise<RemoteAgentAvailability> {
  const hostId = hostIdOrPath.startsWith("ssh://")
    ? parseRemotePath(hostIdOrPath)?.hostId ?? hostIdOrPath
    : hostIdOrPath;
  const [claude, codex] = await Promise.all([hasBinary(hostId, "claude"), hasBinary(hostId, "codex")]);
  return { hostId, claude, codex };
}
