// Files that hold credentials: .env files, private keys and the login files
// of common tools. Codara opens them like any text file, but no editor feature
// may send their text off the computer (inline AI completion sends the text
// around the cursor to a model).

const SECRET_NAMES = new Set([
  ".envrc",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".pgpass",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  // Login files of agent CLIs and cloud tools; none has a telling extension.
  ".credentials.json",
  "credentials.json",
  "credentials",
  "auth.json",
]);

const SECRET_EXTENSIONS = new Set(["env", "pem", "key", "p12", "pfx"]);

// Paths below the home folder that hold private keys and passwords, whatever
// their files are called (~/.aws/config, ~/.kube/config).
export const CREDENTIAL_HOME_PATHS = [
  ".ssh",
  ".gnupg",
  ".password-store",
  ".aws",
  ".azure",
  ".docker",
  ".kube",
  ".config/gcloud",
  ".config/gh",
  ".netrc",
  ".git-credentials",
  ".pgpass",
] as const;

/** `rel` is a path below the home folder with POSIX separators. */
export function isCredentialHomePath(rel: string): boolean {
  return CREDENTIAL_HOME_PATHS.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`));
}

export function isSecretFilePath(path: string): boolean {
  const name = (path.split(/[\\/]/).pop() ?? "").toLowerCase();
  if (!name) return false;
  // .env, .env.local, .env.production
  if (name === ".env" || name.startsWith(".env.")) return true;
  if (SECRET_NAMES.has(name)) return true;
  const dot = name.lastIndexOf(".");
  // secrets.env, server.pem, tls.key
  return dot > 0 && SECRET_EXTENSIONS.has(name.slice(dot + 1));
}
