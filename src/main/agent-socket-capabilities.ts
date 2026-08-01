import { createHash, randomBytes } from "node:crypto";

export type AgentSocketCapabilityAudience =
  | "untrusted-pi-manager"
  | "untrusted-pi-worker";

export interface AgentSocketCapabilityClaim {
  id: string;
  audience: AgentSocketCapabilityAudience;
  runId: string;
  attemptId?: string;
  allowedMethods: readonly string[];
  expiresAt: number;
}

export interface MintedAgentSocketCapability {
  id: string;
  expiresAt: number;
  environment: {
    SPARK_AGENT_SOCKET: string;
    SPARK_AGENT_TOKEN: string;
    SPARK_AGENT_CAPABILITY: "scoped";
  };
}

interface StoredClaim extends Omit<AgentSocketCapabilityClaim, "allowedMethods"> {
  allowedMethods: Set<string>;
  tokenHash: string;
}

const MAX_ACTIVE_CAPABILITIES = 1_024;
const MANAGER_LEASE_MS = 48 * 60 * 60 * 1_000;
const WORKER_LEASE_MS = 6 * 60 * 60 * 1_000;

// This is the complete server surface available to an imported-PR manager.
// The socket stamps its runId, so none of these verbs can be redirected to a
// trusted sibling run. Workers receive a deny-all claim: they use native
// contained file tools and must never regain Studio authority through a stale
// bridge or hand-crafted loopback request.
export const UNTRUSTED_PI_MANAGER_METHODS = Object.freeze([
  "orchestrator.spawn_workers",
  "orchestrator.ask_user",
  "orchestrator.complete",
  "orchestrator.request_next_iteration",
  "orchestrator.get_worker_status",
  "orchestrator.wait_for_workers",
  "orchestrator.message_workers",
  "orchestrator.check_messages",
  "orchestrator.name_chat",
] as const);

let endpoint: string | null = null;
const claimsByTokenHash = new Map<string, StoredClaim>();
const tokenHashById = new Map<string, string>();

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function validIdentity(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 200 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  );
}

function sweepExpired(now = Date.now()): void {
  for (const [hash, claim] of claimsByTokenHash) {
    if (claim.expiresAt > now) continue;
    claimsByTokenHash.delete(hash);
    tokenHashById.delete(claim.id);
  }
}

export function setAgentSocketCapabilityEndpoint(value: string | null): void {
  endpoint = value;
  if (value === null) {
    claimsByTokenHash.clear();
    tokenHashById.clear();
  }
}

export function mintAgentSocketCapability(input: {
  audience: AgentSocketCapabilityAudience;
  runId: string;
  attemptId?: string;
  now?: number;
}): MintedAgentSocketCapability {
  if (!endpoint) {
    throw new Error("Codara agent socket is not ready");
  }
  if (!validIdentity(input.runId)) {
    throw new Error("Agent socket capability requires a valid run identity");
  }
  if (
    input.attemptId !== undefined &&
    !validIdentity(input.attemptId)
  ) {
    throw new Error("Agent socket capability requires a valid attempt identity");
  }
  if (
    input.audience === "untrusted-pi-manager" &&
    input.attemptId !== undefined
  ) {
    throw new Error("An untrusted Pi manager capability cannot own a worker attempt");
  }
  if (
    input.audience === "untrusted-pi-worker" &&
    input.attemptId === undefined
  ) {
    throw new Error("An untrusted Pi worker capability requires an attempt identity");
  }

  const now = input.now ?? Date.now();
  sweepExpired(now);
  if (claimsByTokenHash.size >= MAX_ACTIVE_CAPABILITIES) {
    throw new Error("Too many active agent socket capabilities");
  }

  const token = randomBytes(32).toString("hex");
  const hash = tokenHash(token);
  const id = randomBytes(16).toString("hex");
  const allowedMethods =
    input.audience === "untrusted-pi-manager"
      ? new Set<string>(UNTRUSTED_PI_MANAGER_METHODS)
      : new Set<string>();
  const leaseMs =
    input.audience === "untrusted-pi-manager"
      ? MANAGER_LEASE_MS
      : WORKER_LEASE_MS;
  const claim: StoredClaim = {
    id,
    audience: input.audience,
    runId: input.runId,
    ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    allowedMethods,
    expiresAt: now + leaseMs,
    tokenHash: hash,
  };
  claimsByTokenHash.set(hash, claim);
  tokenHashById.set(id, hash);
  return {
    id,
    expiresAt: claim.expiresAt,
    environment: {
      SPARK_AGENT_SOCKET: endpoint,
      SPARK_AGENT_TOKEN: token,
      SPARK_AGENT_CAPABILITY: "scoped",
    },
  };
}

export function isAgentSocketCapabilityActive(
  id: string | undefined,
  now = Date.now(),
): boolean {
  if (!id) return false;
  const hash = tokenHashById.get(id);
  if (!hash) return false;
  const claim = claimsByTokenHash.get(hash);
  if (!claim) {
    tokenHashById.delete(id);
    return false;
  }
  if (claim.expiresAt <= now) {
    tokenHashById.delete(id);
    claimsByTokenHash.delete(hash);
    return false;
  }
  return true;
}

export function authorizeAgentSocketCapability(
  token: string,
  now = Date.now(),
): AgentSocketCapabilityClaim | null {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const hash = tokenHash(token);
  const claim = claimsByTokenHash.get(hash);
  if (!claim) return null;
  if (claim.expiresAt <= now) {
    claimsByTokenHash.delete(hash);
    tokenHashById.delete(claim.id);
    return null;
  }
  return {
    id: claim.id,
    audience: claim.audience,
    runId: claim.runId,
    ...(claim.attemptId ? { attemptId: claim.attemptId } : {}),
    allowedMethods: [...claim.allowedMethods],
    expiresAt: claim.expiresAt,
  };
}

export function revokeAgentSocketCapability(id: string | undefined): void {
  if (!id) return;
  const hash = tokenHashById.get(id);
  if (!hash) return;
  tokenHashById.delete(id);
  claimsByTokenHash.delete(hash);
}

export function resetAgentSocketCapabilitiesForTests(): void {
  endpoint = null;
  claimsByTokenHash.clear();
  tokenHashById.clear();
}
