import { tmpdir } from "node:os";

/** The folders whose contents can vanish under a process: the OS temp dirs. */
export function temporaryRoots(): string[] {
  const roots = [tmpdir(), process.env.TMPDIR, process.env.TMP, process.env.TEMP];
  if (process.platform !== "win32") {
    // macOS per-user temp lives under /var/folders and is reaped by the OS.
    roots.push("/tmp", "/var/tmp", "/var/folders");
  }
  return roots.filter((value): value is string => typeof value === "string" && value.trim() !== "");
}
