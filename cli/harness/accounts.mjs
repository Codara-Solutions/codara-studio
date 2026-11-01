// Which login each provider uses, and who may refresh it.
//
// Two sources, in this order:
//   1. ~/.cora/auth.json: a `cora login` sign-in. Its grant belongs to Cora
//      alone, so Pi refreshes it under Pi's own file lock.
//   2. Codara Studio's Active account, read from Studio's store without
//      copying it. Credentials stay in Studio's file, so Pi's lock on that
//      file is the one every Studio process takes.
//
// A Studio account with a `cliProfileId` shares its OAuth grant with Claude
// Code or Codex. Those providers rotate refresh tokens, so a second refresher
// logs the other holder out (see claude-login-keeper.ts). This process therefore
// never spends a shared token. Studio renews a shared Claude login on request;
// nothing can do that for ChatGPT, because Pi's lock does not hold the Codex CLI
// back, so a shared ChatGPT login is only used until it expires.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";

const require = createRequire(import.meta.url);

export const PROVIDER_ALIASES = {
  claude: "anthropic",
  anthropic: "anthropic",
  chatgpt: "openai-codex",
  codex: "openai-codex",
  "openai-codex": "openai-codex",
  grok: "xai",
  xai: "xai",
};
const CLI_NAMES = { anthropic: "Claude Code", "openai-codex": "the Codex CLI", xai: "the Grok CLI" };
const LOGIN_NAMES = { anthropic: "claude", "openai-codex": "chatgpt", xai: "grok" };
const PROVIDER_NAMES = { anthropic: "Claude", "openai-codex": "ChatGPT", xai: "Grok" };
const STUDIO_PROBE_TIMEOUT_MS = 500;
const LOGIN_MARGIN_MS = 60_000;

export function loginName(provider) {
  return LOGIN_NAMES[provider] ?? provider;
}

export function coraHome(env = process.env) {
  return env.CORA_HOME?.trim() || join(homedir(), ".cora");
}

export function studioHome(env = process.env) {
  return (
    env.CODARA_HOME_DIR?.trim() ||
    env.SPARK_HOME_DIR?.trim() ||
    env.SPARK_USER_DATA_DIR?.trim() ||
    join(homedir(), ".codarastudio")
  );
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function hasOAuth(authFile, provider) {
  const record = readJson(authFile)?.[provider];
  return record?.type === "oauth" && typeof record.access === "string" && record.access.length > 0;
}

/** Studio's Active account per provider: its default, else its first connected one. */
export function studioAccounts(home) {
  const root = join(home, "pi-agent");
  const registry = readJson(join(root, "account-profiles.json"));
  const accounts = new Map();
  if (!Array.isArray(registry?.profiles)) return accounts;
  const candidates = [...registry.profiles].sort(
    (a, b) =>
      Number(registry.defaults?.[b.provider] === b.id) - Number(registry.defaults?.[a.provider] === a.id),
  );
  for (const profile of candidates) {
    if (accounts.has(profile.provider)) continue;
    const authFile = join(root, "accounts", profile.id, "auth.json");
    if (!hasOAuth(authFile, profile.provider)) continue;
    accounts.set(profile.provider, {
      profileId: profile.id,
      label: profile.label,
      shared: Boolean(profile.cliProfileId),
      authFile,
    });
  }
  return accounts;
}

/** Providers served by Studio's store; everything else stays in ~/.cora/auth.json. */
export function credentialRoutes(env = process.env) {
  const ownFile = join(coraHome(env), "auth.json");
  const routes = new Map();
  for (const [provider, account] of studioAccounts(studioHome(env))) {
    if (!hasOAuth(ownFile, provider)) routes.set(provider, account);
  }
  return routes;
}

export function hasLogin(provider, routes, env = process.env) {
  return routes.has(provider) || Boolean(readJson(join(coraHome(env), "auth.json"))?.[provider]);
}

/** The stored login for a provider, if it can be used without refreshing it. */
export function unexpiredLogin(provider, routes, env = process.env) {
  const file = routes.get(provider)?.authFile ?? join(coraHome(env), "auth.json");
  const record = readJson(file)?.[provider];
  const usable = record?.type === "oauth" && record.access && record.expires > Date.now() + LOGIN_MARGIN_MS;
  return usable ? record : null;
}

/** A models.json `apiKey` for this provider, the path custom endpoints take. */
export function hasConfiguredKey(provider, env = process.env) {
  return Boolean(readJson(join(coraHome(env), "models.json"))?.providers?.[provider]?.apiKey);
}

function writeFileAtomically(path, text) {
  const target = realpathSync(path);
  const folder = dirname(target);
  const temporary = join(folder, `.${basename(target)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    const file = openSync(temporary, "wx", 0o600);
    try {
      writeSync(file, text);
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  // Windows cannot open a folder for syncing, and a rename is durable there.
  if (process.platform === "win32") return;
  const directory = openSync(folder, "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

/**
 * Pi's file store with the same lock, but a kill during a write leaves the old
 * file: Pi truncates in place, and the file can be Studio's only copy of a login.
 * Pi's own write stays reachable only for creating an empty file.
 */
function atomicFileBackend(FileAuthStorageBackend) {
  return class AtomicFileBackend extends FileAuthStorageBackend {
    withLock(update) {
      return super.withLock((current) => {
        const { result, next } = update(current);
        if (next !== undefined) writeFileAtomically(this.authPath, next);
        return { result };
      });
    }

    async withLockAsync(update, options) {
      options?.signal?.throwIfAborted();
      this.ensureParentDir();
      this.ensureFileExists();
      let lost = null;
      const release = await this.acquireLockAsync(options?.signal, (error) => {
        lost = error ?? new Error("Auth storage lock was compromised");
      });
      const stillHeld = () => {
        if (lost) throw lost;
        options?.signal?.throwIfAborted();
      };
      try {
        stillHeld();
        const { result, next } = await update(readFileSync(this.authPath, "utf8"));
        stillHeld();
        if (next !== undefined) writeFileAtomically(this.authPath, next);
        return result;
      } finally {
        await Promise.resolve(release()).catch(() => undefined);
      }
    }
  };
}

/**
 * Pi's CredentialStore, split by provider so one session can use a Claude and
 * a ChatGPT account that live in different files. Each file keeps its own Pi
 * lock. Removal only ever touches Cora's own file: a Studio account is
 * removed from Studio.
 */
export function routedCredentialStore(AuthStorage, FileAuthStorageBackend, ownFile, routes) {
  const Backend = atomicFileBackend(FileAuthStorageBackend);
  const create = (file) => {
    // With its path, AuthStorage skips taking the lock when the file has not changed.
    const backend = new Backend(file);
    return new AuthStorage(backend, backend.authPath);
  };
  const own = create(ownFile);
  const stores = new Map();
  const storeFor = (provider) => {
    const account = routes.get(provider);
    if (!account) return own;
    if (!stores.has(provider)) stores.set(provider, create(account.authFile));
    return stores.get(provider);
  };
  return {
    read: (provider, options) => storeFor(provider).read(provider, options),
    modify: (provider, update, options) => storeFor(provider).modify(provider, update, options),
    delete: (provider, options) => own.delete(provider, options),
    async list(options) {
      const entries = new Map();
      for (const store of [own, ...routes.keys()].map((entry) =>
        typeof entry === "string" ? storeFor(entry) : entry,
      )) {
        for (const entry of await store.list(options)) {
          if (entry.providerId === undefined || !entries.has(entry.providerId)) {
            entries.set(entry.providerId, entry);
          }
        }
      }
      return [...entries.values()];
    },
  };
}

function studioRpc(home, method, params, timeoutMs) {
  const { rpcRaw } = require("../lib/rpc.cjs");
  return rpcRaw({ home }, method, params, { timeoutMs });
}

export async function studioIsRunning(home) {
  try {
    await studioRpc(home, "app.info", {}, STUDIO_PROBE_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
}

function sharedLoginExpired(provider, account) {
  const name = PROVIDER_NAMES[provider] ?? provider;
  const cli = CLI_NAMES[provider] ?? "its CLI";
  const renewal =
    provider === "anthropic"
      ? "Open Codara Studio and retry"
      : `Use ${cli} or Codara Studio until it signs itself back in, then retry`;
  return new Error(
    `The ${name} login "${account.label}" has expired and is shared with ${cli}, so Cora will not ` +
      `refresh it: that could sign ${cli} out. ` +
      `${renewal}, or run: cora login ${loginName(provider)} (a separate Cora sign-in).`,
  );
}

function renewThroughStudio(account, home) {
  return async (method, params, timeoutMs) => {
    if (account.shared && !(await studioIsRunning(home))) throw sharedLoginExpired("anthropic", account);
    const response = await studioRpc(home, method, params, timeoutMs);
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
}

/**
 * Who may refresh each Studio account, set on the runtime before anything can
 * read a credential. Claude goes through Studio whenever Studio can answer, the
 * same request its own Cora sessions make. No other shared login refreshes here:
 * Studio has no such request, and refreshing beside a running CLI can log it out.
 */
export async function applyRefreshRules(runtime, routes, home) {
  if (routes.size === 0) return;
  const { registerCodaraAnthropicRenewal } = await import("../../resources/pi-cora/anthropic-refresh.ts");
  const running = await studioIsRunning(home);
  for (const [provider, account] of routes) {
    if (provider === "anthropic" && (account.shared || running)) {
      registerCodaraAnthropicRenewal(runtime, {
        accountProfileId: account.profileId,
        request: renewThroughStudio(account, home),
      });
    } else if (account.shared) {
      runtime.registerProvider(provider, {
        oauth: {
          name: `${PROVIDER_NAMES[provider] ?? provider} (Codara Studio account)`,
          async login() {
            throw new Error(`"${account.label}" is managed by Codara Studio. Quit and run: cora login ${loginName(provider)}`);
          },
          async refreshToken() {
            throw sharedLoginExpired(provider, account);
          },
          getApiKey: (credentials) => credentials.access,
        },
      });
    }
  }
}

function openBrowser(url) {
  if (process.env.CORA_NO_BROWSER) return;
  const [command, args] =
    process.platform === "win32"
      ? ["cmd.exe", ["/c", "start", "", url.replaceAll("&", "^&")]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true })
    .on("error", () => undefined)
    .unref();
}

function terminalInteraction() {
  const write = (text) => process.stderr.write(`${text}\n`);
  return {
    async prompt(prompt) {
      if (prompt.type === "select") {
        const browser = prompt.options?.find((option) => option.id === "browser");
        if (browser) return browser.id;
        prompt.options?.forEach((option, index) => write(`  ${index + 1}. ${option.label}`));
      }
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        const answer = (await rl.question(`${prompt.message} `, { signal: prompt.signal })).trim();
        return prompt.type === "select" ? (prompt.options?.[Number(answer) - 1]?.id ?? answer) : answer;
      } finally {
        rl.close();
      }
    },
    notify(event) {
      if (event.type === "auth_url" && event.url) {
        write(`Open this page to sign in:\n\n  ${event.url}\n`);
        if (event.instructions) write(event.instructions);
        openBrowser(event.url);
      } else if (event.type === "device_code" && event.userCode) {
        write(`Enter ${event.userCode} at ${event.verificationUri}`);
        openBrowser(event.verificationUri);
      } else if (event.message?.trim()) {
        write(event.message.trim());
      }
    },
  };
}

export async function login(ModelRuntime, rawProvider, env = process.env) {
  const provider = PROVIDER_ALIASES[rawProvider];
  if (!provider) throw Object.assign(new Error(`unknown provider: ${rawProvider}`), { usage: true });
  const home = coraHome(env);
  const runtime = await ModelRuntime.create({
    authPath: join(home, "auth.json"),
    modelsPath: join(home, "models.json"),
  });
  await runtime.login(provider, "oauth", terminalInteraction());
  console.log(`Signed in to ${PROVIDER_NAMES[provider]}. This sign-in belongs to Cora alone.`);
}

export async function logout(ModelRuntime, rawProvider, env = process.env) {
  const provider = PROVIDER_ALIASES[rawProvider];
  if (!provider) throw Object.assign(new Error(`usage: cora logout <claude|chatgpt>`), { usage: true });
  const home = coraHome(env);
  const ownFile = join(home, "auth.json");
  if (!existsSync(ownFile) || !readJson(ownFile)?.[provider]) {
    const account = studioAccounts(studioHome(env)).get(provider);
    console.log(
      account
        ? `Cora has no sign-in of its own for ${PROVIDER_NAMES[provider]}. "${account.label}" is managed by Codara Studio.`
        : `Not signed in to ${PROVIDER_NAMES[provider]}.`,
    );
    return;
  }
  const runtime = await ModelRuntime.create({ authPath: ownFile, modelsPath: join(home, "models.json") });
  await runtime.logout(provider);
  console.log(`Signed out of ${PROVIDER_NAMES[provider]}.`);
}

export function printLogins(env = process.env) {
  const own = readJson(join(coraHome(env), "auth.json")) ?? {};
  const routes = credentialRoutes(env);
  for (const provider of ["anthropic", "openai-codex"]) {
    const name = PROVIDER_NAMES[provider].padEnd(8);
    const account = routes.get(provider);
    if (own[provider]) console.log(`${name} Cora sign-in`);
    else if (account) {
      const note = account.shared ? ", shared with its CLI, which refreshes it" : "";
      console.log(`${name} Codara Studio account "${account.label}"${note}`);
    } else console.log(`${name} not signed in (cora login ${loginName(provider)})`);
  }
}
