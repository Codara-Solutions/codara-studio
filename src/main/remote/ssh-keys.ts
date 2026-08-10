import { promises as fs, type Dirent } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isValidKeyName, type SshKeyImportResult, type SshKeyInfo } from "@shared/ssh-keys";

// Local SSH key management for the SSH manager's Keys tab. Everything is
// confined to the ssh dir (default ~/.ssh); key names are validated filenames,
// never paths. ssh-keygen does the crypto so the resulting files are standard.

const run = promisify(execFile);

// Every ssh-keygen invocation gets a timeout: if a race makes it hit an
// existing file it prompts "Overwrite (y/n)?" on a stdin nobody answers, and
// without a timeout that promise would never settle.
const KEYGEN_TIMEOUT_MS = 30_000;

const WELL_KNOWN_PRIVATE = ["id_rsa", "id_ecdsa", "id_ed25519"];
const IGNORED = new Set(["config", "authorized_keys", "environment"]);

function sshDir(dir?: string): string {
  return dir ?? join(homedir(), ".ssh");
}

function assertValidName(name: string): void {
  if (!isValidKeyName(name)) throw new Error("Invalid key name.");
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function fingerprintOf(pubPath: string): Promise<string | null> {
  try {
    const { stdout } = await run("ssh-keygen", ["-lf", pubPath], { timeout: KEYGEN_TIMEOUT_MS });
    return stdout.trim().split(/\s+/)[1] ?? null;
  } catch {
    return null;
  }
}

async function readKeyInfo(dir: string, name: string): Promise<SshKeyInfo> {
  const privateKeyPath = join(dir, name);
  const pubPath = join(dir, `${name}.pub`);
  const hasPrivateKey = await exists(privateKeyPath);

  let publicKeyPath: string | null = null;
  let publicKey: string | null = null;
  let type: string | null = null;
  let comment: string | null = null;
  let fingerprint: string | null = null;
  try {
    publicKey = (await fs.readFile(pubPath, "utf8")).trim();
    publicKeyPath = pubPath;
    const [pubType, , ...commentParts] = publicKey.split(/\s+/);
    type = pubType ?? null;
    comment = commentParts.length > 0 ? commentParts.join(" ") : null;
    fingerprint = await fingerprintOf(pubPath);
  } catch {
    // No readable .pub — the private half alone still counts as a key.
  }

  return { name, privateKeyPath, publicKeyPath, publicKey, type, fingerprint, comment, hasPrivateKey };
}

export async function listKeys(dir?: string): Promise<SshKeyInfo[]> {
  const base = sshDir(dir);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const names = new Set<string>();
  for (const file of files) {
    if (file.startsWith("known_hosts") || IGNORED.has(file)) continue;
    if (!file.endsWith(".pub")) continue;
    // Derived names go through the same validation as user-supplied ones, so a
    // stray ".pub" or "..pub" file can't yield a phantom key whose private
    // path resolves to the ssh dir itself.
    const name = file.slice(0, -".pub".length);
    if (isValidKeyName(name)) names.add(name);
  }
  for (const wellKnown of WELL_KNOWN_PRIVATE) {
    if (!names.has(wellKnown) && files.has(wellKnown)) names.add(wellKnown);
  }

  const keys = await Promise.all([...names].map((name) => readKeyInfo(base, name)));
  return keys.sort((a, b) => a.name.localeCompare(b.name));
}

export async function generateKey(
  opts: { name: string; passphrase?: string; comment?: string },
  dir?: string,
): Promise<SshKeyInfo> {
  assertValidName(opts.name);
  const base = sshDir(dir);
  const privPath = join(base, opts.name);
  const pubPath = `${privPath}.pub`;
  if ((await exists(privPath)) || (await exists(pubPath))) {
    throw new Error(`${opts.name} already exists.`);
  }

  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  try {
    await run(
      "ssh-keygen",
      [
        "-t",
        "ed25519",
        "-f",
        privPath,
        "-N",
        opts.passphrase ?? "",
        "-C",
        opts.comment ?? `${userInfo().username}@codara-studio`,
      ],
      { timeout: KEYGEN_TIMEOUT_MS },
    );
  } catch (err) {
    // Never stringify the raw error: execFile's rejection message embeds the
    // full argv, which includes the passphrase after -N.
    const stderr = (err as { stderr?: string }).stderr;
    throw new Error(stderr?.trim() || "ssh-keygen failed.");
  }
  return readKeyInfo(base, opts.name);
}

export async function importKey(sourcePath: string, dir?: string): Promise<SshKeyImportResult> {
  const contents = await fs.readFile(sourcePath, "utf8");
  if (!contents.includes("PRIVATE KEY")) throw new Error("Not a private key file.");

  const name = basename(sourcePath);
  assertValidName(name);
  const base = sshDir(dir);
  const destPath = join(base, name);
  const destPubPath = `${destPath}.pub`;
  if ((await exists(destPath)) || (await exists(destPubPath))) {
    throw new Error(`${name} already exists.`);
  }

  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  await fs.copyFile(sourcePath, destPath);
  await fs.chmod(destPath, 0o600);

  let warning: string | undefined;
  if (await exists(`${sourcePath}.pub`)) {
    await fs.copyFile(`${sourcePath}.pub`, destPubPath);
    await fs.chmod(destPubPath, 0o644);
  } else {
    try {
      const { stdout } = await run("ssh-keygen", ["-y", "-P", "", "-f", destPath], {
        timeout: KEYGEN_TIMEOUT_MS,
      });
      await fs.writeFile(destPubPath, stdout, { mode: 0o644 });
    } catch {
      warning =
        "Imported, but the public key could not be derived (key may have a passphrase). Import the .pub file manually.";
    }
  }

  const key = await readKeyInfo(base, name);
  return warning ? { key, warning } : { key };
}

export async function deleteKey(name: string, dir?: string): Promise<void> {
  assertValidName(name);
  const base = sshDir(dir);
  const privPath = join(base, name);
  if (!(await exists(privPath))) throw new Error(`${name} does not exist.`);
  await fs.unlink(privPath);
  try {
    await fs.unlink(`${privPath}.pub`);
  } catch {
    // Best-effort: a key without a .pub half is fine to delete.
  }
}
