"use strict";

const readline = require("node:readline/promises");

const { rpc } = require("../lib/rpc.cjs");
const { c, fail } = require("../lib/ui.cjs");

const PROVIDER_ALIASES = new Map([
  ["anthropic", "anthropic"],
  ["claude", "anthropic"],
  ["claude-code", "anthropic"],
  ["openai-codex", "openai-codex"],
  ["openai", "openai-codex"],
  ["chatgpt", "openai-codex"],
  ["codex", "openai-codex"],
  ["xai", "xai"],
  ["grok", "xai"],
]);

const RUNTIME_ALIASES = new Map([
  ["claude", "claude"],
  ["claude-code", "claude"],
  ["codex", "codex"],
  ["openai", "codex"],
  ["grok", "grok"],
  ["xai", "grok"],
]);

const PROVIDER_ORDER = ["anthropic", "openai-codex", "xai"];
const RUNTIME_ORDER = ["claude", "codex", "grok"];

function normalizeProvider(value) {
  const provider = PROVIDER_ALIASES.get(String(value ?? "").trim().toLowerCase());
  if (!provider) fail("provider must be anthropic (claude), openai-codex (codex), or xai (grok)");
  return provider;
}

function normalizeRuntime(value) {
  const runtime = RUNTIME_ALIASES.get(String(value ?? "").trim().toLowerCase());
  if (!runtime) fail("runtime must be claude, codex, or grok");
  return runtime;
}

function statusText(status) {
  if (status === "configured" || status === "connected") return c.green("connected");
  if (status === "sign_in_required") return c.yellow("sign-in required");
  return c.red(status || "unavailable");
}

function accountMarker(account) {
  return account.isDefault ? c.cyan("← default") : "";
}

function formatSubscriptionAccounts(accounts, providerFilter) {
  const lines = [];
  for (const provider of PROVIDER_ORDER) {
    if (providerFilter && provider !== providerFilter) continue;
    const group = accounts.filter((account) => account.provider === provider);
    lines.push(`${c.bold(provider)} (${group.length} account${group.length === 1 ? "" : "s"}):`);
    if (group.length === 0) {
      lines.push(`  ${c.dim("none")}`);
      continue;
    }
    group.forEach((account, index) => {
      const usage = Number.isFinite(account.remainingPercent)
        ? c.dim(`${Math.round(account.remainingPercent)}% left`)
        : "";
      lines.push(
        `  ${c.dim(`#${index + 1}`)}  ${c.bold(account.label)}  ${statusText(account.status)}  ${usage} ${accountMarker(account)}`.trimEnd(),
      );
      lines.push(`      ${c.dim(account.id)}`);
    });
  }
  return lines.join("\n");
}

function formatNativeAccounts(runtimes, runtimeFilter) {
  const byRuntime = new Map(runtimes.map((group) => [group.runtime, group]));
  const lines = [];
  for (const runtime of RUNTIME_ORDER) {
    if (runtimeFilter && runtime !== runtimeFilter) continue;
    const group = byRuntime.get(runtime);
    const profiles = group?.profiles ?? [];
    lines.push(`${c.bold(runtime)} (${profiles.length} account${profiles.length === 1 ? "" : "s"}):`);
    if (profiles.length === 0) {
      lines.push(`  ${c.dim("none")}`);
      continue;
    }
    profiles.forEach((profile, index) => {
      const badges = [
        profile.managed ? "" : c.dim("personal"),
        profile.inUse ? c.yellow("in use") : "",
        accountMarker(profile),
      ].filter(Boolean).join("  ");
      lines.push(
        `  ${c.dim(`#${index + 1}`)}  ${c.bold(profile.label)}  ${statusText(profile.status)}  ${badges}`.trimEnd(),
      );
      lines.push(`      ${c.dim(profile.id)}`);
    });
  }
  return lines.join("\n");
}

function resolveAccount(accounts, reference, noun = "account") {
  const ref = String(reference ?? "").trim();
  if (!ref) fail(`${noun} number, label, or id is required`);
  const numbered = /^#?(\d+)$/.exec(ref);
  if (numbered) {
    const selected = accounts[Number(numbered[1]) - 1];
    if (selected) return selected;
    fail(`${noun} number is out of range: ${ref}`);
  }
  const exactId = accounts.find((account) => account.id === ref);
  if (exactId) return exactId;
  const exactLabel = accounts.filter(
    (account) => String(account.label).toLowerCase() === ref.toLowerCase(),
  );
  if (exactLabel.length === 1) return exactLabel[0];
  const prefix = accounts.filter((account) => String(account.id).startsWith(ref));
  if (prefix.length === 1) return prefix[0];
  if (exactLabel.length > 1 || prefix.length > 1) {
    fail(`${noun} reference is ambiguous: ${ref}`);
  }
  fail(`${noun} not found: ${ref}`);
}

async function subscriptionAccounts(flags, provider) {
  const result = await rpc(flags, "accounts.list", {});
  return (result.accounts ?? []).filter((account) => !provider || account.provider === provider);
}

async function nativeAccounts(flags, runtime) {
  const result = await rpc(flags, "nativeAccounts.list", runtime ? { runtime } : {});
  const profiles = (result.runtimes ?? []).flatMap((group) => group.profiles ?? []);
  return { result, profiles };
}

async function ask(message) {
  if (!process.stdin.isTTY) fail(`${message} (interactive terminal required)`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(message);
  } finally {
    rl.close();
  }
}

async function confirmRemoval(message, flags) {
  if (flags.yes) return;
  const answer = (await ask(`${message} Type "yes" to continue: `)).trim().toLowerCase();
  if (answer !== "yes") fail("cancelled");
}

function printAuthEvent(event, flags) {
  if (flags.json) {
    console.log(JSON.stringify(event));
    return;
  }
  if (event.type === "started" || event.type === "progress") {
    console.log(`${c.cyan("›")} ${event.message}`);
  } else if (event.type === "auth_url") {
    console.log(`${c.cyan("↗")} ${event.instructions || "Finish signing in in your browser."}`);
    console.log(c.dim(event.url));
  } else if (event.type === "device_code") {
    console.log(`${c.cyan("↗")} Open ${event.verificationUri}`);
    console.log(`  code: ${c.bold(event.userCode)}`);
  } else if (event.type === "completed") {
    console.log(`${c.green("✓")} ${event.message}`);
  } else if (event.type === "failed" || event.type === "cancelled") {
    console.log(`${event.type === "failed" ? c.red("×") : c.yellow("•")} ${event.message}`);
  }
}

async function answerAuthPrompt(event, flags) {
  const prompt = event.prompt;
  let value;
  if (prompt.type === "select") {
    if (!process.stdin.isTTY) fail("provider requested an interactive choice");
    console.log(prompt.message);
    prompt.options.forEach((option, index) => {
      console.log(`  ${index + 1}. ${option.label}${option.description ? c.dim(` — ${option.description}`) : ""}`);
    });
    const answer = (await ask("Choose: ")).trim();
    const selected = prompt.options[Number(answer) - 1] ?? prompt.options.find((option) => option.id === answer);
    if (!selected) fail("invalid sign-in choice");
    value = selected.id;
  } else {
    value = await ask(`${prompt.message}${prompt.placeholder ? c.dim(` (${prompt.placeholder})`) : ""}: `);
  }
  await rpc(flags, "accounts.login.respond", {
    sessionId: event.sessionId,
    promptId: event.promptId,
    value,
  });
}

async function runSubscriptionLogin(flags, input) {
  const started = await rpc(flags, "accounts.login.start", input);
  let interrupted = false;
  const onInterrupt = () => { interrupted = true; };
  process.once("SIGINT", onInterrupt);
  try {
    while (true) {
      if (interrupted) {
        await rpc(flags, "accounts.login.cancel", { sessionId: started.sessionId });
        fail("sign-in cancelled");
      }
      const batch = await rpc(flags, "accounts.login.poll", { sessionId: started.sessionId });
      for (const event of batch.events ?? []) {
        const withSession = { ...event, sessionId: started.sessionId };
        if (event.type === "prompt") await answerAuthPrompt(withSession, flags);
        else printAuthEvent(event, flags);
        if (event.type === "failed") fail(event.message);
        if (event.type === "cancelled") fail("sign-in cancelled");
      }
      if (batch.done) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } finally {
    process.removeListener("SIGINT", onInterrupt);
  }
}

async function listAll(flags, providerFilter) {
  const [subscriptions, native] = await Promise.all([
    rpc(flags, "accounts.list", {}),
    rpc(flags, "nativeAccounts.list", {}),
  ]);
  if (flags.json) {
    console.log(JSON.stringify({ subscriptions: subscriptions.accounts ?? [], native: native.runtimes ?? [] }, null, 2));
    return;
  }
  console.log(c.bold("Cora subscription accounts"));
  console.log(formatSubscriptionAccounts(subscriptions.accounts ?? [], providerFilter));
  if (!providerFilter) {
    console.log(`\n${c.bold("Native CLI accounts")}`);
    console.log(formatNativeAccounts(native.runtimes ?? []));
  }
}

async function subscriptionAuth(args, flags) {
  const action = args[0] ?? "list";
  if (action === "list") {
    const provider = args[1] ? normalizeProvider(args[1]) : null;
    return listAll(flags, provider);
  }
  if (action === "add") {
    const provider = normalizeProvider(args[1]);
    const label = flags.label || args.slice(2).join(" ").trim() || undefined;
    return runSubscriptionLogin(flags, {
      provider,
      ...(label ? { label } : {}),
      ...(flags.default ? { makeDefault: true } : {}),
    });
  }
  if (action === "login" || action === "reconnect") {
    const provider = normalizeProvider(args[1]);
    const account = resolveAccount(await subscriptionAccounts(flags, provider), args[2]);
    return runSubscriptionLogin(flags, {
      provider,
      profileId: account.id,
      ...(flags.default ? { makeDefault: true } : {}),
    });
  }
  if (action === "use") {
    const provider = normalizeProvider(args[1]);
    const account = resolveAccount(await subscriptionAccounts(flags, provider), args[2]);
    const result = await rpc(flags, "accounts.use", { provider, profileId: account.id });
    if (flags.json) return console.log(JSON.stringify(result, null, 2));
    console.log(`${c.green("✓")} ${c.bold(account.label)} is now the default for new Cora chats`);
    return;
  }
  if (action === "rename") {
    const provider = normalizeProvider(args[1]);
    const account = resolveAccount(await subscriptionAccounts(flags, provider), args[2]);
    const label = flags.label || args.slice(3).join(" ").trim();
    if (!label) fail("usage: cora auth rename <provider> <#|label|id> <new-label>");
    const result = await rpc(flags, "accounts.rename", { profileId: account.id, label });
    if (flags.json) return console.log(JSON.stringify(result, null, 2));
    console.log(`${c.green("✓")} renamed ${c.bold(account.label)} to ${c.bold(label)}`);
    return;
  }
  if (action === "remove" || action === "delete") {
    const provider = normalizeProvider(args[1]);
    const account = resolveAccount(await subscriptionAccounts(flags, provider), args[2]);
    await confirmRemoval(`Remove Cora account "${account.label}"?`, flags);
    const result = await rpc(flags, "accounts.remove", { profileId: account.id });
    if (flags.json) return console.log(JSON.stringify(result, null, 2));
    console.log(`${c.green("✓")} removed ${c.bold(account.label)}`);
    return;
  }
  fail("usage: cora auth list | add | login | use | rename | remove | cli …");
}

async function nativeAuth(args, flags) {
  const action = args[0] ?? "list";
  if (action === "list") {
    const runtime = args[1] ? normalizeRuntime(args[1]) : null;
    const result = await rpc(flags, "nativeAccounts.list", runtime ? { runtime } : {});
    if (flags.json) return console.log(JSON.stringify(result, null, 2));
    console.log(c.bold("Native CLI accounts"));
    console.log(formatNativeAccounts(result.runtimes ?? [], runtime));
    return;
  }
  if (action === "add") {
    const runtime = normalizeRuntime(args[1]);
    const label = flags.label || args.slice(2).join(" ").trim();
    if (!label) fail("usage: cora auth cli add <claude|codex|grok> <label>");
    const result = await rpc(flags, "nativeAccounts.add", { runtime, label });
    if (flags.json) return console.log(JSON.stringify(result, null, 2));
    console.log(`${c.green("✓")} opened ${c.bold(label)} sign-in in a new Studio terminal`);
    console.log(c.dim("It becomes the default after sign-in succeeds."));
    return;
  }
  const runtime = normalizeRuntime(args[1]);
  const { profiles } = await nativeAccounts(flags, runtime);
  const account = resolveAccount(profiles, args[2], `${runtime} account`);
  if (action === "login" || action === "reconnect") {
    const result = await rpc(flags, "nativeAccounts.login", {
      runtime,
      profileId: account.id,
      ...(flags.default ? { makeDefault: true } : {}),
    });
    if (flags.json) return console.log(JSON.stringify(result, null, 2));
    console.log(`${c.green("✓")} opened ${c.bold(account.label)} sign-in in a new Studio terminal`);
    return;
  }
  if (action === "use") {
    const result = await rpc(flags, "nativeAccounts.use", { runtime, profileId: account.id });
    if (flags.json) return console.log(JSON.stringify(result, null, 2));
    console.log(`${c.green("✓")} ${c.bold(account.label)} is now the default ${runtime} CLI account`);
    if (result.closedSessionCount) {
      console.log(c.dim(`closed ${result.closedSessionCount} existing ${runtime} session${result.closedSessionCount === 1 ? "" : "s"}`));
    }
    return;
  }
  if (action === "rename") {
    const label = flags.label || args.slice(3).join(" ").trim();
    if (!label) fail("usage: cora auth cli rename <runtime> <#|label|id> <new-label>");
    const result = await rpc(flags, "nativeAccounts.rename", { runtime, profileId: account.id, label });
    if (flags.json) return console.log(JSON.stringify(result, null, 2));
    console.log(`${c.green("✓")} renamed ${c.bold(account.label)} to ${c.bold(label)}`);
    return;
  }
  if (action === "logout") {
    await confirmRemoval(`Sign out "${account.label}"?`, flags);
    const result = await rpc(flags, "nativeAccounts.logout", { runtime, profileId: account.id });
    if (flags.json) return console.log(JSON.stringify(result, null, 2));
    console.log(`${c.green("✓")} signed out ${c.bold(account.label)}`);
    return;
  }
  if (action === "remove" || action === "delete") {
    await confirmRemoval(`Remove managed ${runtime} account "${account.label}"?`, flags);
    const result = await rpc(flags, "nativeAccounts.remove", { runtime, profileId: account.id });
    if (flags.json) return console.log(JSON.stringify(result, null, 2));
    console.log(`${c.green("✓")} removed ${c.bold(account.label)}`);
    return;
  }
  fail("usage: cora auth cli list | add | login | use | rename | logout | remove");
}

async function auth(args, flags) {
  if (args[0] === "cli") return nativeAuth(args.slice(1), flags);
  return subscriptionAuth(args, flags);
}

module.exports = {
  auth,
  formatNativeAccounts,
  formatSubscriptionAccounts,
  resolveAccount,
};
