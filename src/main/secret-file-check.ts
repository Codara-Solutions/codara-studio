// Is this editor file a secret on disk? By its own name, the name of any link
// on the way to it (notes.txt -> .env -> config.txt) or its real name. A
// secret file's text never goes to inline completion, a preview or a share
// link. Electron-free so the unit suite can drive it.

import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isRemotePath } from "@shared/remote";
import { isCredentialHomePath, isSecretFilePath } from "@shared/secret-files";

// More links than this in one chain and the file counts as a secret: every
// hop must be looked at, and the kernel gives up near here too (ELOOP).
export const MAX_LINK_HOPS = 32;

function lastSeparator(target: string): number {
  const slash = target.lastIndexOf("/");
  return process.platform === "win32" ? Math.max(slash, target.lastIndexOf("\\")) : slash;
}

function inCredentialStore(file: string, home: string): boolean {
  if (!home || !path.isAbsolute(file)) return false;
  const rel = path.relative(home, file).split(path.sep).join("/");
  return rel !== "" && !rel.startsWith("../") && isCredentialHomePath(rel);
}

async function isSecretName(file: string): Promise<boolean> {
  if (isSecretFilePath(file)) return true;
  const home = os.homedir();
  if (inCredentialStore(file, home)) return true;
  // A linked home: the real path of a file does not start with the spelling
  // os.homedir() gives.
  const realHome = await fsp.realpath(home).catch(() => home);
  return realHome !== home && inCredentialStore(file, realHome);
}

export async function isSecretFileOnDisk(file: unknown): Promise<boolean> {
  if (typeof file !== "string" || file.length === 0 || isRemotePath(file)) return false;
  if (await isSecretName(file)) return true;
  try {
    await fsp.lstat(file);
  } catch (error) {
    // Nothing on disk yet (a new file): only its name can be a secret.
    // Anything else (no permission, a broken folder) counts as a secret.
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
  try {
    let current = file;
    for (let hop = 0; ; hop += 1) {
      if (!(await fsp.lstat(current)).isSymbolicLink()) break;
      if (hop >= MAX_LINK_HOPS) return true;
      const target = await fsp.readlink(current);
      // The folders of a link's target are resolved the way the kernel does,
      // links first and ".." after: path.resolve would cancel "d/.." without
      // looking at d, and land on another file than the one that is read.
      const cut = lastSeparator(target);
      const folder = cut >= 0 ? target.slice(0, cut + 1) : "";
      const name = target.slice(cut + 1);
      const base = path.isAbsolute(target) ? folder : `${await fsp.realpath(path.dirname(current))}${path.sep}${folder}`;
      const realFolder = await fsp.realpath(base);
      if (name === "" || name === "." || name === "..") break;
      current = path.join(realFolder, name);
      if (await isSecretName(current)) return true;
    }
    return await isSecretName(await fsp.realpath(file));
  } catch {
    // A link loop, a broken link or an unreadable one: no way to tell what
    // would be read, so it gets no completion, preview or share.
    return true;
  }
}
