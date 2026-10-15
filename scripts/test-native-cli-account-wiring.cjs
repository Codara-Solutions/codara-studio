#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (relativePath) =>
  fs.readFileSync(path.join(ROOT, relativePath), "utf8");

const shared = read("src/shared/types.ts");
const ipc = read("src/main/ipc.ts");
const pty = read("src/main/pty-manager.ts");
const preload = read("src/preload/index.ts");
const settings = read("src/renderer/src/components/SettingsDialog.tsx");
const settingsView = read("src/renderer/src/components/AccountCards.tsx");
const card = read("src/renderer/src/components/AccountCard.tsx");
const app = read("src/renderer/src/App.tsx");
const tabs = read("src/renderer/src/tabs/useTabs.ts");
const tabBar = read("src/renderer/src/tabs/TabBar.tsx");
const shortcutCommands = read("src/renderer/src/shortcuts/commands.ts");
const terminalStack = read("src/renderer/src/tabs/TerminalStack.tsx");
const session = read(
  "src/renderer/src/components/Terminal/useTerminalSession.ts",
);

// The surviving native channels serve the halves no account row names yet:
// inspect lists them, rename and delete act on a terminal-only half.
for (const channel of [
  "native-cli-accounts:inspect",
  "native-cli-accounts:rename",
  "native-cli-accounts:delete",
]) {
  assert.ok(
    ipc.includes(`"${channel}"`),
    `${channel} must be registered in main`,
  );
  assert.ok(
    preload.includes(`ipcRenderer.invoke("${channel}"`),
    `${channel} must be exposed by preload`,
  );
}
// Sign-in, switch and sign-out are account actions now: neither main nor
// preload carries the retired channels.
for (const channel of [
  "native-cli-accounts:create",
  "native-cli-accounts:set-default",
  "native-cli-accounts:prepare-login",
  "native-cli-accounts:cancel-login",
  "native-cli-accounts:logout",
]) {
  assert.equal(ipc.includes(`"${channel}"`), false, `${channel} must not be registered in main`);
  assert.equal(
    preload.includes(`ipcRenderer.invoke("${channel}"`),
    false,
    `${channel} must not be exposed by preload`,
  );
}
assert.doesNotMatch(preload, /native-cli-accounts:login-error/);

const dtoStart = shared.indexOf("export type NativeCliAccountRuntime");
const dtoEnd = shared.indexOf("export interface PiCatalogModel", dtoStart);
assert.ok(dtoStart >= 0 && dtoEnd > dtoStart, "sanitized native account DTOs");
const dtoSource = shared.slice(dtoStart, dtoEnd);
for (const forbidden of [
  "configDir",
  "homeDir",
  "authFile",
  "accessToken",
  "refreshToken",
  "credential",
  "executable",
  "args:",
  "env:",
  "stdout",
  "stderr",
]) {
  assert.equal(
    dtoSource.includes(forbidden),
    false,
    `${forbidden} must not cross the shared native-account contract`,
  );
}

const preloadStart = preload.indexOf("nativeCliAccounts: {");
const preloadEnd = preload.indexOf("\n  piSubscriptions:", preloadStart);
assert.ok(preloadStart >= 0 && preloadEnd > preloadStart);
const preloadAccountApi = preload.slice(preloadStart, preloadEnd);
for (const forbidden of [
  "configDir",
  "homeDir",
  "authFile",
  "executable",
  "argv",
  "stdout",
  "stderr",
  "processOutput",
  "expectedAccountFingerprint",
  "expectedEmail",
  "removeProfileOnMismatch",
  "removeProfileOnFailure",
  "activateOnSuccess",
]) {
  assert.equal(
    preloadAccountApi.includes(forbidden),
    false,
    `${forbidden} must not appear in the preload account API`,
  );
}

// CLI sign-ins no longer run in a Studio terminal: one browser sign-in
// through the account card writes both halves, so no login token travels
// from a pane to pty.spawn and main never resolves an executable for one.
assert.doesNotMatch(ipc, /launchPreparedLogin|spawnPreparedNativeCliLogin|spawnExactExecutable\(\{/);
for (const [name, source] of [
  ["ipc.ts", ipc],
  ["preload", preload],
  ["useTerminalSession.ts", session],
  ["useTabs.ts", tabs],
  ["TerminalStack.tsx", terminalStack],
  ["App.tsx", app],
]) {
  assert.doesNotMatch(source, /nativeCliLoginToken/, `${name} must not carry a CLI login token`);
}
assert.doesNotMatch(
  preloadAccountApi,
  /launchPreparedLogin|spawnExactExecutable|spec\.(?:executable|args|env)/,
);
// The delete channel dispatches through the unified service for every
// runtime.
assert.match(ipc, /const provider = providerForRuntime\(input\.runtime\);\s*const \{ deleted \} = await unifiedAccountsFor\(provider\)\.deleteTerminalOnlyProfile\(/);

// pty-manager keeps no direct-executable seam for a sign-in: every PTY is
// built from process.env plus Studio's own variables.
assert.doesNotMatch(pty, /spawnExactExecutable|exactEnvironment|requireFreshSession/);

// Settings no longer opens a sign-in terminal or a fresh session after a
// switch: the one browser sign-in and the switch both live in main.
assert.doesNotMatch(app, /cancelLogin|spark:open-native-cli-login|spark:open-native-cli-account|onLoginError/);
assert.doesNotMatch(
  app,
  /title:\s*`\$\{titlePrefix\}\s*·/,
  "an account switch must keep the normal terminal tab title",
);
assert.match(tabBar, /workerRuntimes\.length > 1/);
assert.match(tabBar, /<SplitAgentsMark runtimes=\{workerRuntimes\}/);
for (const [id, label, handler] of [
  ["worker.newGrok", "New Grok worker pane", "handleNewWorkerPane(GROK_LAUNCH_COMMAND)"],
]) {
  assert.match(shortcutCommands, new RegExp(`\\| "${id}"`));
  assert.match(shortcutCommands, new RegExp(`id: "${id}"[\\s\\S]*?label: "${label}"`));
  assert.ok(app.includes(`"${id}": () => ${handler}`), `${id} must have an App handler`);
}
// No picker stands between a worker row or shortcut and a new session.
assert.ok(!fs.existsSync(path.join(ROOT, "src/renderer/src/components/WorkerSessionPicker.tsx")));
assert.doesNotMatch(shortcutCommands, /worker\.(claude|codex|grok)Sessions/);
assert.match(
  app,
  /const launchWorkerInNewTerminalTab = useCallback\([\s\S]*?tabs\.newTerminalTab\(cwd, launchCommand/,
  "the tab-strip worker launcher must always create a terminal tab",
);
assert.match(
  app,
  /const launchNewWorkerTab = useCallback\([\s\S]*?launchWorkerInNewTerminalTab\(command, cwd \? \{ cwd \} : undefined\)/,
  "the tab-strip worker rows start a new session in a new tab",
);
for (const [runtime, command] of [
  ["Claude", "CLAUDE_LAUNCH_COMMAND"],
  ["Codex", "CODEX_LAUNCH_COMMAND"],
  ["Grok", "GROK_LAUNCH_COMMAND"],
  ["Pi", "PI_LAUNCH_COMMAND"],
]) {
  assert.ok(
    app.includes(`() => launchNewWorkerTab(${command})`) && app.includes(`onNew${runtime}Worker={open${runtime}Worker}`),
    `the tab-strip ${runtime} row must start a new session in its own tab`,
  );
}
assert.match(
  terminalStack,
  /onPick=\{\(command\) => \{[\s\S]*?onSmartAdd\(command\)/,
  "the terminal-toolbar worker launcher must add a pane inside its own tab",
);

// ---------------------------------------------------------------------------
// Settings presents one merged Accounts page with one card model for
// every provider: an account is one sign-in with two halves paired in the
// main process, and the words come from a per-provider descriptor.
assert.match(settings, /<SettingsSection anchor="Accounts" plain>/);
assert.match(settings, /Every account is one sign-in for Cora and its terminal tool/);
assert.doesNotMatch(settings, /closes that tool's running sessions first/);
assert.match(settings, /<AccountCards providers=\{providerViews\}/);
assert.ok(
  settings.indexOf("<AccountsSettings />") >= 0,
  "the Agents tab must render the merged Accounts section",
);

// No provider speaks to the native CLI account store for a switch or a
// sign-in: Use goes through the Pi make-default channel, which switches Cora
// and the terminal half together in main, and Add/Reconnect are the Pi
// sign-in, which writes both halves. The only native calls left are rename
// and delete of a terminal-only half.
assert.match(settings, /return ACCOUNT_PROVIDER_DESCRIPTORS\.map\(\(descriptor\) => \{/);
assert.doesNotMatch(settings, /descriptor\.provider === "anthropic"/);
assert.match(settings, /void makeDefault\(card\.provider, card\.coraProfileId\)/);
assert.match(settings, /reconnectAccount\(card\.provider, card\.coraProfileId, card\.label\)/);
assert.match(settings, /nativeCliAccounts\.rename\(\{\s*runtime: runtimeForSubscription\(card\.provider\),/);
assert.match(settings, /nativeCliAccounts\.delete\(\{\s*runtime: runtimeForSubscription\(card\.provider\),/);
assert.doesNotMatch(
  settings,
  /nativeCliAccounts\.(?:setDefault|prepareLogin|cancelLogin|create|logout)\(|spark:open-native-cli/,
  "no switch or sign-in may go through the native CLI account store",
);
assert.doesNotMatch(card, /nativeCliAccounts|spark:open-native-cli/);
// Card keys start as ids main assigned and are kept while an account gains
// or loses a half, so pairing never remounts a card.
assert.match(settings, /key: `\$\{provider\}:\$\{profile\.id\}`/);
assert.match(settings, /key: `\$\{provider\}:cli:\$\{profile\.id\}`/);
assert.match(
  settings,
  /const cards = stableAccountCardKeys\(\[\.\.\.rows, \.\.\.terminalOnly\], cardKeysRef\.current\);/,
);
// No pseudo-card for the CLI's own login; the Codara-side label preference
// is gone with the two-facet card.
assert.doesNotMatch(settings, /account-one|"Account 1"/);
assert.doesNotMatch(settings, /nativeCliAccountLabels/);
assert.doesNotMatch(shared, /nativeCliAccountLabels/);
assert.doesNotMatch(read("src/main/preferences-store.ts"), /nativeCliAccountLabels/);
// Nothing in the renderer pairs on identity any more; main owns the link.
assert.doesNotMatch(settings, /Identity pairing|cliByFingerprint|cliByEmail|pairHint|pairedCliIds|unmatchedSignedInCli/);
assert.match(settings, /function accountCardShowsUsage/);
assert.match(settings, /accountCardShowsUsage\(usage\)/);
// No switch or delete is refused for running sessions any more, so nothing
// counts them or offers to close them.
assert.doesNotMatch(settings, /refusedWithSessions|closeSessions/);
assert.doesNotMatch(card, /switchCloseSessionsCount|and switch`/);
const descriptors = read("src/renderer/src/lib/account-provider-descriptors.ts");
assert.doesNotMatch(descriptors, /switchClosesSessions|closes running/);

// The fingerprint is a one-way digest of the account id, computed in main with
// the same scheme on both sides. The id itself never crosses IPC.
const identity = read("src/main/orchestration/native-cli-account-identity.ts");
const piStore = read("src/main/orchestration/pi-account-auth-store.ts");
assert.match(identity, /createHash\("sha256"\)\.update\(accountId\)\.digest\("hex"\)/);
assert.match(piStore, /createHash\("sha256"\)\.update\(accountId\)\.digest\("hex"\)/);
assert.match(identity, /tokens\.account_id/);
assert.match(identity, /jwtEmailClaim\(tokens\.id_token\)/);
assert.match(identity, /Buffer\.from\(payload, "base64url"\)/);
assert.doesNotMatch(identity, /createVerify|jwt\.verify|crypto\.verify/);
assert.match(identity, /accountUuid\.trim\(\)\.toLowerCase\(\)/);
assert.doesNotMatch(identity, /homedir\(\)/);
assert.match(identity, /https:\/\/auth\.x\.ai::/);
assert.match(identity, /typeof nested\.user_id === "string"/);
assert.match(identity, /normalizeAccountEmail\(nested\.email\)/);
assert.match(identity, /jwtSubjectClaim\(nested\.key\)/);
assert.match(identity, /function grokAuthSlots/);
assert.match(identity, /fs\.readFile\(path, "utf8"\)/);
assert.doesNotMatch(
  identity,
  /writeFile|appendFile|\bfs\.rename\b|\bfs\.rm\b|unlink|chmod|utimes|copyFile|\bfs\.open\(/,
);
assert.match(identity, /return undefined;/);
assert.match(identity, /\} catch \{/);
// Claude Code's side is the oauthAccount block beside its one-home login:
// only the uuid and the address are read, and the uuid is hashed the same way.
const liveLogin = read("src/main/orchestration/claude-cli-live-login.ts");
assert.match(liveLogin, /oauthAccount\?\.accountUuid/);
assert.match(liveLogin, /normalizeAccountEmail\(oauthAccount\?\.emailAddress\)/);
assert.match(liveLogin, /anthropicAccountFingerprint\(accountUuid\)/);

// Anthropic's account profile is read exactly once on the connect path, from
// the endpoint that answers the access token the login just produced. It is
// never read from a stored credential and never triggers a refresh.
const anthropicIdentity = read(
  "src/main/orchestration/anthropic-account-identity.ts",
);
const piAuthSource = read("src/main/orchestration/pi-subscription-auth.ts");
assert.match(
  anthropicIdentity,
  /"https:\/\/api\.anthropic\.com\/api\/oauth\/profile"/,
);
assert.match(anthropicIdentity, /Authorization: `Bearer \$\{accessToken\}`/);
assert.match(anthropicIdentity, /method: "GET"/);
assert.match(anthropicIdentity, /account\.uuid/);
assert.match(anthropicIdentity, /anthropicAccountFingerprint\(accountUuid\)/);
assert.doesNotMatch(anthropicIdentity, /grant_type|oauth\/token|\.refresh\b|AuthStorage/);
assert.match(anthropicIdentity, /return undefined;/);
assert.match(anthropicIdentity, /account\.email_address/);
assert.match(piAuthSource, /async function connectTimeIdentity/);
assert.match(piAuthSource, /readAnthropicAccountProfile\(credential\.access\)/);
assert.equal(
  piAuthSource.split("readAnthropicAccountProfile(").length - 1,
  1,
);
assert.match(piAuthSource, /const identity = await connectTimeIdentity\(/);
assert.match(piAuthSource, /accountEmail: identity\.email/);
const authStoreSource = read("src/main/orchestration/pi-account-auth-store.ts");
assert.match(authStoreSource, /recordIdentityFingerprint\(/);
const profilesSource = read("src/main/orchestration/pi-account-profiles.ts");
assert.match(profilesSource, /async recordIdentityFingerprint\(/);
assert.match(profilesSource, /async recordAccountEmail\(/);
assert.match(authStoreSource, /recordAccountEmail\(/);
assert.match(profilesSource, /if \(current\.identityFingerprint\) return cloneProfile\(current\);/);
assert.match(profilesSource, /if \(claimed\) return cloneProfile\(current\);/);

const nativeDtoSource = shared.slice(dtoStart, dtoEnd);
assert.match(nativeDtoSource, /accountFingerprint\?: string;/);
assert.match(nativeDtoSource, /email\?: string;/);
for (const rawIdentity of [
  "accountId",
  "account_id",
  "accountUuid",
  "emailAddress",
  "organizationUuid",
]) {
  assert.equal(
    nativeDtoSource.includes(rawIdentity),
    false,
    `${rawIdentity} must never cross IPC; only the fingerprint digest does`,
  );
}

// The phone gets neither identity value. Both remote projections copy an
// explicit field list, so nothing new on the local DTO can leak into them.
const nativeProjection = read(
  "src/main/remote-access/native-cli-account-projection.ts",
);
const subscriptionProjection = read(
  "src/main/remote-access/subscription-profile-projection.ts",
);
for (const projection of [nativeProjection, subscriptionProjection]) {
  assert.doesNotMatch(projection, /\bemail\b\s*[,:]/);
  assert.doesNotMatch(projection, /accountFingerprint/);
  assert.doesNotMatch(projection, /\.\.\.profile\b/);
}

// The one card and its picker carry none of the two-role machinery.
for (const source of [card, settingsView, settings, app]) {
  assert.doesNotMatch(
    source,
    /AccountRoleRow|cliSwitchArmed|Confirm & close|Remove from Cora|Usage limits show once this account is connected to Cora|cliSignInHint|onCliConnect|onCoraConnect|onCliUse|Connect to Cora|nativeCodexProfileId: profileId|nativeGrokProfileId: profileId/,
  );
}
assert.match(settingsView, /export function AccountAddPicker\(/);
assert.match(settingsView, /<AccountCard\s+key=\{card\.key\}\s+card=\{card\}\s+descriptor=\{descriptor\}/);
assert.match(settingsView, /`Sign in in your browser\. Codara keeps this account in its own folder and never touches \$\{selectedView\.descriptor\.systemHome\}\.`/);

// An account change never closes a terminal, Codara's or anyone else's: a
// switch replaces credentials, and a deleted account's home waits for its
// terminals to exit. The services only learn from the pty layer which lease
// owners are still alive.
assert.doesNotMatch(ipc, /setSessionShutdown|closeEveryCodexSession|shutdownExternalNativeCliProcesses|disposeNativeCliRuntimeGraceful/);
assert.doesNotMatch(ipc, /disposeNative(?:Claude|Codex|Grok)ProfileSessions/);
assert.match(ipc, /for \(const accounts of \[anthropicAccounts, codexAccounts, grokAccounts\]\) \{\s*accounts\.setTerminalSessions\(\{ liveOwnerIds: \(\) => pty\.liveSessionOwnerIds\(\) \}\);/);
assert.match(ipc, /unifiedAccountsFor\(provider\)\.useAccount\(profileId\);/);
assert.match(ipc, /unifiedAccountsFor\(provider\)\.useSystemLogin\(\);/);
assert.match(ipc, /unifiedAccountsFor\(target\.provider\)\.deleteAccount\(profileId, \{/);
const nativeAccounts = read("src/main/orchestration/native-cli-accounts.ts");
assert.match(nativeAccounts, /NATIVE_CLI_ACCOUNT_UNIFIED/);
assert.doesNotMatch(nativeAccounts, /sessionShutdown|prepareLogin|execFile/);
const socket = read("src/main/agent-socket.ts");
assert.match(socket, /unifiedAccountsFor\(provider\)\.useAccount\(profileId\);/);
assert.match(socket, /unifiedAccountsFor\(provider\)\.useSystemLogin\(\);/);
assert.doesNotMatch(socket, /closeSessions: params\.closeSessions/);
assert.match(socket, /unifiedAccountsFor\(current\.provider\)\.deleteAccount\(profileId, \{/);
assert.doesNotMatch(socket, /openNativeCliAccountLogin|nativeCliAccounts\.(?:create|setDefault|logout|delete|prepareLogin)\(/);

console.log(
  "PASS native CLI account IPC is sanitized, no CLI login token reaches a pane or main, every provider switches and deletes through the unified account services, and one card model serves all three providers",
);
