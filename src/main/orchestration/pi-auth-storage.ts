import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The pinned Pi runtime's own auth.json store. Every Codara write to a Pi
 * credential file goes through it rather than through a plain file write:
 * Pi serializes writers with a proper-lockfile lock beside the file, and a
 * Codara write that bypassed the lock could clobber a token a running Pi
 * session had just rotated. Codara only ever holds OAuth records here.
 */
export interface PiOAuthCredential {
  type: "oauth";
  access: string;
  refresh: string;
  /** Expiry as Pi stores it: the raw expiry minus Pi's own safety padding. */
  expires: number;
  [key: string]: unknown;
}

export interface PiAuthStorageInstance {
  read(provider: string): Promise<unknown>;
  modify(
    provider: string,
    fn: (current: unknown) => Promise<PiOAuthCredential | undefined>,
  ): Promise<unknown>;
  delete(provider: string): Promise<void>;
}

export interface PiAuthStorageModule {
  create(path: string): PiAuthStorageInstance;
}

export type PiAuthStorageLoader = () => Promise<PiAuthStorageModule>;

let cached: Promise<PiAuthStorageModule> | null = null;

export async function loadPiAuthStorage(): Promise<PiAuthStorageModule> {
  cached ??= (async () => {
    const { resolveCodaraPiRuntime } = await import("./pi-runtime-electron");
    const runtime = await resolveCodaraPiRuntime();
    const modulePath = join(runtime.packageRoot, "dist", "core", "auth-storage.js");
    const loaded = (await import(/* @vite-ignore */ pathToFileURL(modulePath).href)) as {
      AuthStorage?: PiAuthStorageModule;
    };
    if (!loaded.AuthStorage?.create) throw new Error("Pinned Pi auth storage is unavailable");
    return loaded.AuthStorage;
  })().catch((error) => {
    // A failed load (Pi not installed yet) must not poison later attempts.
    cached = null;
    throw error;
  });
  return cached;
}
