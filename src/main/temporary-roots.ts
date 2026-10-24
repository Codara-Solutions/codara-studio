import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

/** The folders whose contents can vanish under a process: the OS temp dirs. */
export function temporaryRoots(): string[] {
  const roots = [tmpdir(), process.env.TMPDIR, process.env.TMP, process.env.TEMP];
  if (process.platform !== "win32") {
    // macOS per-user temp lives under /var/folders and is reaped by the OS.
    roots.push("/tmp", "/var/tmp", "/var/folders");
  }
  return roots.filter((value): value is string => typeof value === "string" && value.trim() !== "");
}

// Resolve symlinks as far as the path exists, then re-append the missing
// tail. On macOS /var and /tmp are symlinks into /private while os.tmpdir()
// keeps the /var form, so the same folder reaches us spelled both ways.
function realpathBestEffortSync(target: string): string {
  const absolute = resolve(target);
  try {
    return realpathSync(absolute);
  } catch {
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    return join(realpathBestEffortSync(parent), basename(absolute));
  }
}

/** True when `target` is inside one of the temporaryRoots(), however either is spelled. */
export function isInsideTemporaryRoot(target: string): boolean {
  const real = realpathBestEffortSync(target);
  const fold = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
  return temporaryRoots().some((root) => {
    const rel = relative(fold(realpathBestEffortSync(root)), fold(real));
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  });
}
