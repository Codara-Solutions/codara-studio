// SSH key metadata shared between main and renderer. Key discovery itself
// (reading ~/.ssh, running ssh-keygen) happens only in the main process.

export interface SshKeyInfo {
  /** Private-key filename inside the ssh dir, e.g. "id_ed25519". */
  name: string;
  privateKeyPath: string;
  publicKeyPath: string | null;
  /** Full one-line contents of the .pub file, trimmed. Null when no .pub. */
  publicKey: string | null;
  /** Key algorithm parsed from the .pub line, e.g. "ssh-ed25519". */
  type: string | null;
  /** "SHA256:…" via `ssh-keygen -lf`; null when unavailable. */
  fingerprint: string | null;
  comment: string | null;
  hasPrivateKey: boolean;
}

export interface SshKeyImportResult {
  key: SshKeyInfo;
  /** Set when the private key imported fine but the .pub could not be derived. */
  warning?: string;
}

export function isValidKeyName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && !name.includes("..") && !name.endsWith(".pub");
}
