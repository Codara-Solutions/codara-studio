import { chmod, mkdir, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "../fs-atomic";

const SAFE_FILE_STEM = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export function privateWorkerConstitutionPromptPath(input: {
  directory: string;
  fileStem: string;
}): string {
  if (
    !input.directory.trim() ||
    input.fileStem.length > 200 ||
    !SAFE_FILE_STEM.test(input.fileStem)
  ) {
    throw new Error("Worker constitution prompt path is invalid");
  }
  return join(input.directory, `${input.fileStem}.md`);
}

/** Write one exact, owner-only process prerequisite. */
export async function writePrivateWorkerConstitutionPrompt(input: {
  block?: string;
  directory: string;
  fileStem: string;
}): Promise<string | null> {
  if (!input.block) return null;
  const path = privateWorkerConstitutionPromptPath(input);
  await mkdir(input.directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(input.directory, 0o700);
  await writeFileAtomic(path, input.block, { mode: 0o600 });
  if (process.platform !== "win32") await chmod(path, 0o600);
  return path;
}

/** Remove the exact process file and its directory only when now empty. */
export async function cleanupPrivateWorkerConstitutionPrompt(
  path: string | null | undefined,
): Promise<void> {
  if (!path) return;
  await rm(path, { force: true }).catch(() => undefined);
  await rmdir(dirname(path)).catch(() => undefined);
}
