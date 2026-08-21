import { promises as fs } from "node:fs";
import { join } from "node:path";
import { safeStorage } from "electron";
import { writeFileAtomic } from "../fs-atomic";
import { codaraHome } from "../codara-home";

// Opt-in secret storage for SSH passwords / key passphrases, encrypted with
// Electron safeStorage (DPAPI on Windows — OS-user-scoped, never plaintext
// on disk). Keys are logical, e.g. "password:vps1" / "passphrase:vps1".
// Everything fails soft: if encryption is unavailable, secrets simply are
// not remembered and the auth prompt reappears next time.

const SECRETS_FILE = "spark-remote-secrets.json";

function secretsPath(): string {
  return join(codaraHome(), SECRETS_FILE);
}

async function readAll(): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(secretsPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Record<string, string>;
  } catch {
    return {};
  }
}

export async function getSecret(key: string): Promise<string | null> {
  if (!safeStorage.isEncryptionAvailable()) return null;
  const all = await readAll();
  const b64 = all[key];
  if (!b64) return null;
  try {
    return safeStorage.decryptString(Buffer.from(b64, "base64"));
  } catch {
    return null;
  }
}

export async function setSecret(key: string, value: string): Promise<boolean> {
  if (!safeStorage.isEncryptionAvailable()) return false;
  try {
    const all = await readAll();
    all[key] = safeStorage.encryptString(value).toString("base64");
    await writeFileAtomic(secretsPath(), JSON.stringify(all, null, 2));
    return true;
  } catch {
    return false;
  }
}

export async function deleteSecret(key: string): Promise<void> {
  const all = await readAll();
  if (!(key in all)) return;
  delete all[key];
  try {
    await writeFileAtomic(secretsPath(), JSON.stringify(all, null, 2));
  } catch {
    /* best-effort */
  }
}
