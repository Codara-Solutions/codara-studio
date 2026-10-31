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
// logs the other holder out (see claude-login-keeper.ts). This process
// therefore never spends a shared Claude token, and spends a shared ChatGPT
// token only while Studio runs, because Studio's credential mirror then
// carries the new token to the Codex CLI.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
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
const LOGIN_NAMES = { anthropic: "claude", "openai-codex": "chatgpt", xai: "grok" };
const PROVIDER_NAMES = { anthropic: "Claude", "openai-codex": "ChatGPT", xai: "Grok" };
const STUDIO_PROBE_TIMEOUT_MS = 500;

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

/** A models.json `apiKey` for this provider, the path custom endpoints take. */
export function hasConfiguredKey(provider, env = process.env) {
  return Boolean(readJson(join(coraHome(env), "models.json"))?.providers?.[provider]?.apiKey);
}

/**
 * Pi's CredentialStore, split by provider so one session can use a Claude and
 * a ChatGPT account that live in different files. Each file keeps its own Pi
 * lock. Removal only ever touches Cora's own file: a Studio account is
 * removed from Studio.
 */
export function routedCredentialStore(AuthStorage, ownFile, routes) {
  const own = AuthStorage.create(ownFile);
  const stores = new Map();
  const storeFor = (provider) => {
    const account = routes.get(provider);
    if (!account) return own;
    if (!stores.has(provider)) stores.set(provider, AuthStorage.create(account.authFile));
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
  const cli = provider === "anthropic" ? "Claude Code" : "the Codex CLI";
  return new Error(
    `The ${name} login "${account.label}" has expired and is shared with ${cli}, so Cora will not ` +
      `refresh it while Codara Studio is closed: that could sign ${cli} out. ` +
      `Open Studio and retry, or run: cora login ${loginName(provider)} (a separate Cora sign-in).`,
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
 * same request its own Cora sessions make, and a shared login never refreshes
 * here. ChatGPT keeps Pi's refresh while Studio runs, because Studio's mirror
 * then carries the new token to the Codex CLI.
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
    } else if (account.shared && !running) {
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
      const note = account.shared ? ", shared with its CLI; needs Studio open to refresh" : "";
      console.log(`${name} Codara Studio account "${account.label}"${note}`);
    } else console.log(`${name} not signed in (cora login ${loginName(provider)})`);
  }
}
