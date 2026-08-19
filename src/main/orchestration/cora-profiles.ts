import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { codaraHome } from "../codara-home";
import { writeFileAtomic } from "../fs-atomic";
import type { CoraProfile, CoraProfileCreateInput } from "@shared/types";

export const DEFAULT_CORA_PROFILE_ID = "default";
const PROFILE_INSTRUCTIONS_MAX_CHARS = 4_000;

interface StoredProfile {
  id: string;
  name: string;
  description: string;
  createdAt: string;
}

interface ProfileRegistry {
  version: 1;
  defaultProfileId: string;
  profiles: StoredProfile[];
}

function memoryRoot(): string {
  return join(codaraHome(), "memory");
}

function registryPath(): string {
  return join(memoryRoot(), "profiles.json");
}

export function normalizeCoraProfileId(value: string | undefined | null): string {
  const raw = value?.trim().toLowerCase() || DEFAULT_CORA_PROFILE_ID;
  // Keep profile directories to one safe path segment. Dots are deliberately
  // excluded so names such as "../other" can never escape the profile root.
  const cleaned = raw.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 64) || DEFAULT_CORA_PROFILE_ID;
}

export function coraProfileRoot(profileId: string): string {
  const id = normalizeCoraProfileId(profileId);
  return id === DEFAULT_CORA_PROFILE_ID
    ? memoryRoot()
    : join(memoryRoot(), "profiles", id);
}

export function coraProfileIdentityPath(profileId: string): string {
  return join(coraProfileRoot(profileId), "PROFILE.md");
}

function fallbackRegistry(): ProfileRegistry {
  return { version: 1, defaultProfileId: DEFAULT_CORA_PROFILE_ID, profiles: [] };
}

function readRegistry(): ProfileRegistry {
  try {
    const raw = JSON.parse(readFileSync(registryPath(), "utf8")) as Partial<ProfileRegistry>;
    const seen = new Set<string>();
    const profiles: StoredProfile[] = [];
    for (const item of Array.isArray(raw.profiles) ? raw.profiles : []) {
      if (!item || typeof item !== "object") continue;
      const id = normalizeCoraProfileId(item.id);
      const name = typeof item.name === "string" ? item.name.trim().slice(0, 80) : "";
      if (!name || id === DEFAULT_CORA_PROFILE_ID || seen.has(id)) continue;
      seen.add(id);
      profiles.push({
        id,
        name,
        description:
          typeof item.description === "string" ? item.description.trim().slice(0, 300) : "",
        createdAt:
          typeof item.createdAt === "string" && Number.isFinite(Date.parse(item.createdAt))
            ? item.createdAt
            : new Date(0).toISOString(),
      });
    }
    const requestedDefault = normalizeCoraProfileId(raw.defaultProfileId);
    const defaultProfileId =
      requestedDefault === DEFAULT_CORA_PROFILE_ID || profiles.some((item) => item.id === requestedDefault)
        ? requestedDefault
        : DEFAULT_CORA_PROFILE_ID;
    return { version: 1, defaultProfileId, profiles };
  } catch {
    return fallbackRegistry();
  }
}

let registryMutationTail: Promise<void> = Promise.resolve();

function mutateRegistry<T>(
  mutation: (registry: ProfileRegistry) => Promise<T> | T,
): Promise<T> {
  // Serialize the whole read-modify-write transaction, not only the final
  // write. Two simultaneous profile creations must not lose one another.
  const operation = registryMutationTail.then(async () => {
    const registry = readRegistry();
    const result = await mutation(registry);
    await mkdir(memoryRoot(), { recursive: true });
    await writeFileAtomic(registryPath(), `${JSON.stringify(registry, null, 2)}\n`);
    return result;
  });
  registryMutationTail = operation.then(() => undefined, () => undefined);
  return operation;
}

function materializeProfile(item: StoredProfile, defaultProfileId: string): CoraProfile {
  return {
    ...item,
    isDefault: item.id === defaultProfileId,
    identityPath: coraProfileIdentityPath(item.id),
  };
}

export function listCoraProfiles(): CoraProfile[] {
  const registry = readRegistry();
  const builtIn: StoredProfile = {
    id: DEFAULT_CORA_PROFILE_ID,
    name: "Cora",
    description: "The standard Cora profile.",
    createdAt: new Date(0).toISOString(),
  };
  return [builtIn, ...registry.profiles].map((item) =>
    materializeProfile(item, registry.defaultProfileId),
  );
}

export function resolveCoraProfile(reference?: string | null): CoraProfile {
  const profiles = listCoraProfiles();
  if (!reference?.trim()) return profiles.find((profile) => profile.isDefault) ?? profiles[0];
  const needle = reference.trim().toLowerCase();
  const match = profiles.find(
    (profile) => profile.id === normalizeCoraProfileId(needle) || profile.name.toLowerCase() === needle,
  );
  if (!match) throw new Error(`Unknown Cora profile: ${reference}`);
  return match;
}

function profileTemplate(name: string, description: string, instructions: string): string {
  const body = instructions.trim() ||
    "Describe this profile's role, priorities, and communication style here. Keep project facts in workspace memory.";
  return `# ${name}\n\n${description ? `${description}\n\n` : ""}## Instructions\n\n${body}\n`;
}

export async function createCoraProfile(input: CoraProfileCreateInput): Promise<CoraProfile> {
  const name = input.name.trim().slice(0, 80);
  if (!name) throw new Error("Profile name is required.");
  const id = normalizeCoraProfileId(name);
  if (id === DEFAULT_CORA_PROFILE_ID) throw new Error('The profile id "default" is reserved.');
  const instructions = input.instructions?.trim().slice(0, PROFILE_INSTRUCTIONS_MAX_CHARS) ?? "";
  return mutateRegistry(async (registry) => {
    if (registry.profiles.some((profile) => profile.id === id || profile.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(`A Cora profile named ${name} already exists.`);
    }
    const profile: StoredProfile = {
      id,
      name,
      description: input.description?.trim().slice(0, 300) ?? "",
      createdAt: new Date().toISOString(),
    };
    await mkdir(coraProfileRoot(id), { recursive: true });
    await writeFileAtomic(
      coraProfileIdentityPath(id),
      profileTemplate(profile.name, profile.description, instructions),
    );
    registry.profiles.push(profile);
    return materializeProfile(profile, registry.defaultProfileId);
  });
}

export async function setDefaultCoraProfile(reference: string): Promise<CoraProfile> {
  return mutateRegistry((registry) => {
    const needle = reference.trim().toLowerCase();
    const stored = registry.profiles.find(
      (profile) => profile.id === normalizeCoraProfileId(needle) || profile.name.toLowerCase() === needle,
    );
    const profile = stored ?? (normalizeCoraProfileId(needle) === DEFAULT_CORA_PROFILE_ID
      ? {
          id: DEFAULT_CORA_PROFILE_ID,
          name: "Cora",
          description: "The standard Cora profile.",
          createdAt: new Date(0).toISOString(),
        }
      : null);
    if (!profile) throw new Error(`Unknown Cora profile: ${reference}`);
    registry.defaultProfileId = profile.id;
    return materializeProfile(profile, profile.id);
  });
}

export function formatCoraProfileForTurn(profileId: string): string | null {
  const profile = resolveCoraProfile(profileId);
  const path = profile.identityPath;
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, "utf8").trim().slice(0, PROFILE_INSTRUCTIONS_MAX_CHARS);
    if (!content) return null;
    return [
      `CORA PROFILE: ${profile.name} (user-editable file: ${path})`,
      content,
      "[END CORA PROFILE]",
    ].join("\n");
  } catch {
    return null;
  }
}
