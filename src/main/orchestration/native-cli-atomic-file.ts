import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * The one way Codara writes a credential file for any native CLI: a 0600
 * temporary in the target's own directory (created with `wx` so a name
 * collision cannot open an existing file), renamed over the destination. A
 * destination that is a symlink, not a regular file, or readable by group or
 * other users is refused before any temporary exists, so a planted link can
 * never make Codara write a token somewhere else.
 *
 * Reads mirror the same checks: a slot is "none" when absent, "unreadable"
 * when its shape or permissions cannot be trusted or its bytes do not parse,
 * and a value only when everything checked out. Callers treat unreadable as
 * "do nothing", never as "signed out".
 */

/** Credential files are a few kilobytes; anything larger is not one. */
export const NATIVE_CLI_CREDENTIAL_FILE_MAX_BYTES = 16 * 1024 * 1024;

export type PrivateFileRead<T> =
  | { kind: "none" }
  | { kind: "unreadable"; reason: "unsafe" | "invalid" | "io" }
  | { kind: "value"; value: T };

async function lstatOrNull(path: string): Promise<import("node:fs").Stats | null> {
  return fs.lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

/**
 * True when a regular, owner-only file exists at `path`; false when nothing
 * does; throws when something untrustworthy sits there.
 */
export async function assertPrivateRegularFile(
  path: string,
  maxBytes = NATIVE_CLI_CREDENTIAL_FILE_MAX_BYTES,
): Promise<boolean> {
  const stats = await lstatOrNull(path);
  if (!stats) return false;
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error("Native CLI credential is not a regular file");
  }
  if (stats.size > maxBytes) {
    throw new Error("Native CLI credential is unexpectedly large");
  }
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    throw new Error("Native CLI credential permissions are not private");
  }
  return true;
}

/** Read and parse a private JSON file without ever surfacing its bytes. */
export async function readPrivateJsonFile(
  path: string,
  maxBytes = NATIVE_CLI_CREDENTIAL_FILE_MAX_BYTES,
): Promise<PrivateFileRead<unknown>> {
  let exists: boolean;
  try {
    exists = await assertPrivateRegularFile(path, maxBytes);
  } catch {
    return { kind: "unreadable", reason: "unsafe" };
  }
  if (!exists) return { kind: "none" };
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "none" };
    return { kind: "unreadable", reason: "io" };
  }
  try {
    // JSON.parse quotes the text it choked on; the bytes stay out of any error.
    return { kind: "value", value: JSON.parse(raw.replace(/^\uFEFF/, "")) as unknown };
  } catch {
    return { kind: "unreadable", reason: "invalid" };
  }
}

export interface AtomicWritePrivateFileOptions {
  /** Refuse to replace a destination that fails the private-file checks. */
  maxBytes?: number;
}

export async function atomicWritePrivateFile(
  destination: string,
  contents: string | Buffer,
  options: AtomicWritePrivateFileOptions = {},
): Promise<void> {
  const directory = dirname(destination);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await fs.chmod(directory, 0o700);
  // Throws on a symlink, a non-file or a world-readable file before any
  // temporary file exists.
  await assertPrivateRegularFile(destination, options.maxBytes);
  const temporary = join(
    directory,
    `.${basename(destination)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    await fs.writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
    if (process.platform !== "win32") await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, destination);
    if (process.platform !== "win32") await fs.chmod(destination, 0o600);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Remove a private file; a symlink or an unsafe file is left alone and reported. */
export async function removePrivateFile(path: string): Promise<boolean> {
  if (!(await assertPrivateRegularFile(path))) return false;
  await fs.unlink(path);
  return true;
}

/** Byte copy through the same temporary-and-rename path, keeping 0600. */
export async function atomicCopyPrivateFile(source: string, destination: string): Promise<void> {
  if (!(await assertPrivateRegularFile(source))) {
    throw new Error("Native CLI credential to copy is missing");
  }
  await atomicWritePrivateFile(destination, await fs.readFile(source));
}
