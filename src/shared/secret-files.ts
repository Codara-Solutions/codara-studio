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
]);

const SECRET_EXTENSIONS = new Set(["env", "pem", "key", "p12", "pfx"]);

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
