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
const picker = read("src/renderer/src/components/WorkerSessionPicker.tsx");
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
// Sign-in, switch and sign-out are account actions now. Main keeps refusing
// the retired channels for any caller; preload no longer offers them.
for (const channel of [
  "native-cli-accounts:create",
  "native-cli-accounts:set-default",
  "native-cli-accounts:prepare-login",
  "native-cli-accounts:cancel-login",
  "native-cli-accounts:logout",
]) {
  assert.ok(
    ipc.includes(`"${channel}"`),
    `${channel} must still be answered (refused) in main`,
  );
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
// through the account card writes both halves, so a login token reaching
// pty.spawn is refused and main never resolves an executable for it.
assert.match(
  ipc,
  /if \(args\?\.nativeCliLoginToken !== undefined\) \{\s*throw new NativeCliAccountError\("NATIVE_CLI_ACCOUNT_UNIFIED"\)/,
);
assert.doesNotMatch(ipc, /launchPreparedLogin|spawnPreparedNativeCliLogin|spawnExactExecutable\(\{/);
assert.doesNotMatch(
  preloadAccountApi,
  /launchPreparedLogin|spawnExactExecutable|spec\.(?:executable|args|env)/,
);
// The set-default, delete, create and login channels dispatch through the
// unified services (or refuse) for every runtime.
assert.match(ipc, /const provider = providerForRuntime\(input\.runtime\);\s*const accounts = unifiedAccountsFor\(provider\);/);
assert.match(ipc, /await accounts\.useAccount\(row\.id\)/);
assert.match(ipc, /unifiedAccountsFor\(provider\)\.deleteTerminalOnlyProfile\(/);
assert.match(ipc, /"native-cli-accounts:create",[\s\S]*?nativeCliAccounts\.assertNotUnified\(/);
assert.match(ipc, /"native-cli-accounts:prepare-login",[\s\S]*?nativeCliAccounts\.assertNotUnified\(/);
assert.match(ipc, /"native-cli-accounts:logout",[\s\S]*?nativeCliAccounts\.assertNotUnified\(/);

// Exact means exact: pty-manager copies the selected environment instead of
// process.env, and every Studio/env enrichment is inside the non-exact branch.
assert.match(
  pty,
  /const environmentSource = opts\.exactEnvironment \?\? process\.env/,
);
assert.match(pty, /if \(opts\.exactEnvironment === undefined\) \{/);
assert.match(pty, /exactEnvironment:\s*\{ \.\.\.opts\.env \}/);
assert.match(pty, /requireFreshSession:\s*true/);
assert.match(
  pty,
  /if \(opts\.requireFreshSession\) \{\s*throw new Error/,
);

// Tokens are one-shot in both main (service test exercises consumption) and
// renderer remounts, and they are stripped from every persisted/cold layout.
assert.match(session, /nativeCliLoginTokenFiredSessions/);
assert.match(
  session,
  /nativeCliLoginTokenFiredSessions\.add\(sessionId\)/,
);
assert.match(tabs, /delete node\.nativeCliLoginToken/);
assert.match(
  tabs,
  /nativeCliLoginToken:\s*_nativeCliLoginToken/,
);
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
assert.match(picker, /const \[selectedIndex, setSelectedIndex\] = useState\(-1\)/);
assert.match(picker, /historyKeyboardArmedRef\.current = true/);
assert.match(
  picker,
  /if \(!historyKeyboardArmedRef\.current \|\| !session\) \{\s*void launchNew\(\)/,
);
for (const [id, label, handler] of [
  ["worker.newGrok", "New Grok worker pane", "handleNewWorkerPane(GROK_LAUNCH_COMMAND)"],
  ["worker.grokSessions", "Open Grok worker sessions…", 'openShortcutWorkerSessions("grok")'],
]) {
  assert.match(shortcutCommands, new RegExp(`\\| "${id}"`));
  assert.match(shortcutCommands, new RegExp(`id: "${id}"[\\s\\S]*?label: "${label}"`));
  assert.ok(app.includes(`"${id}": () => ${handler}`), `${id} must have an App handler`);
}
assert.match(
  app,
  /const launchWorkerInNewTerminalTab = useCallback\([\s\S]*?tabs\.newTerminalTab\(cwd, launchCommand/,
  "the tab-strip worker launcher must always create a terminal tab",
);
assert.match(
  app,
  /const openTabBarWorkerSessions = useCallback\([\s\S]*?launchWorkerInNewTerminalTab\(command, \{ cwd, session \}\)/,
  "tab-strip session resumes must use the new-tab launcher too",
);
for (const runtime of ["claude", "codex", "grok"]) {
  assert.ok(
    app.includes(`() => openTabBarWorkerSessions("${runtime}")`),
    `the tab-strip ${runtime} row must use tab scope`,
  );
}
assert.match(
  terminalStack,
  /onOpenWorkerSessions: \(runtime\)[\s\S]*?splitRef\.current\(\s*tabId,\s*target\.paneId,\s*target\.direction,\s*command,\s*session/,
  "the terminal-toolbar worker launcher must split inside its own tab",
);

// ---------------------------------------------------------------------------
// Settings presents one merged Accounts section with one card model for
// every provider: an account is one sign-in with two halves paired in the
// main process, and the words come from a per-provider descriptor.
assert.match(settings, /title="Accounts"/);
assert.match(settings, /Every account is one sign-in for both Cora and its terminal tool/);
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
assert.match(settings, /void makeDefault\(card\.provider, card\.coraProfileId, closeSessions\)/);
assert.match(settings, /reconnectAccount\(card\.provider, card\.coraProfileId, card\.label\)/);
assert.match(settings, /nativeCliAccounts\.rename\(\{\s*runtime: runtimeForSubscription\(card\.provider\),/);
assert.match(settings, /nativeCliAccounts\.delete\(\{\s*runtime: runtimeForSubscription\(card\.provider\),/);
assert.doesNotMatch(
  settings,
  /nativeCliAccounts\.(?:setDefault|prepareLogin|cancelLogin|create|logout)\(|spark:open-native-cli/,
  "no switch or sign-in may go through the native CLI account store",
);
assert.doesNotMatch(card, /nativeCliAccounts|spark:open-native-cli/);
// Card keys are ids main assigned, so pairing never remounts a card.
assert.match(settings, /key: `\$\{provider\}:\$\{profile\.id\}`/);
assert.match(settings, /key: `\$\{provider\}:cli:\$\{profile\.id\}`/);
assert.match(settings, /key: `\$\{provider\}:account-one`/);
// Account 1 keeps the Cora row's label for every provider (renameable
// there); the Codara-side label preference is gone with the two-facet card.
assert.match(settings, /label: personal\.label \|\| "Account 1"/);
assert.doesNotMatch(settings, /nativeCliAccountLabels/);
assert.doesNotMatch(shared, /nativeCliAccountLabels/);
assert.doesNotMatch(read("src/main/preferences-store.ts"), /nativeCliAccountLabels/);
// Nothing in the renderer pairs on identity any more; main owns the link.
assert.doesNotMatch(settings, /Identity pairing|cliByFingerprint|cliByEmail|pairHint|pairedCliIds|unmatchedSignedInCli/);
assert.match(settings, /function accountCardShowsUsage/);
assert.match(settings, /accountCardShowsUsage\(usage\)/);
// The switch refusal (Codex only) travels the same way as the delete one.
assert.match(settings, /refusedWithSessions\(profileId, "use", err\)/);
assert.match(settings, /refusedWithSessions\(profileId, "delete", err\)/);
assert.match(card, /switchCloseSessionsCount/);
assert.match(card, /`Close \$\{sessions\(switchCount\)\} and switch`/);
const descriptors = read("src/renderer/src/lib/account-provider-descriptors.ts");
assert.match(descriptors, /codex: \{ cliLabel: "Codex", loginHint: "codex login", switchClosesSessions: true \}/);
assert.equal((descriptors.match(/switchClosesSessions: true/g) ?? []).length, 1);

// The fingerprint is a one-way digest of the account id, computed in main with
// the same scheme on both sides. The id itself never crosses IPC.
const identity = read("src/main/orchestration/native-cli-account-identity.ts");
const piStore = read("src/main/orchestration/pi-account-auth-store.ts");
assert.match(identity, /createHash\("sha256"\)\.update\(accountId\)\.digest\("hex"\)/);
assert.match(piStore, /createHash\("sha256"\)\.update\(accountId\)\.digest\("hex"\)/);
assert.match(identity, /tokens\.account_id/);
assert.match(identity, /jwtEmailClaim\(tokens\.id_token\)/);
assert.match(identity, /account\.emailAddress/);
assert.match(identity, /Buffer\.from\(payload, "base64url"\)/);
assert.doesNotMatch(identity, /createVerify|jwt\.verify|crypto\.verify/);
assert.match(identity, /account\.accountUuid/);
assert.match(identity, /oauthAccount/);
assert.match(identity, /accountUuid\.trim\(\)\.toLowerCase\(\)/);
assert.match(identity, /join\(configDirEnv \?\? homeDir, "\.claude\.json"\)/);
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
assert.match(settingsView, /`Sign in once in your browser\. Cora and \$\{selectedView\.descriptor\.cliLabel\} both use it\.`/);

// The main process owns the Codex shutdown boundary, and only Codex has
// one: Codara PTYs get a graceful close first, external codex processes are
// then quiesced, and the service does not move the live slot until that
// callback resolves. Claude and Grok switches close nothing; each service
// closes only the panes of the account being deleted.
assert.match(ipc, /codexAccounts\.setSessionShutdown\(closeEveryCodexSession\)/);
assert.match(ipc, /pty\.disposeNativeCliRuntimeGraceful\("codex"\)/);
assert.match(ipc, /shutdownExternalNativeCliProcesses\("codex"\)/);
assert.doesNotMatch(ipc, /grokAccounts\.setSessionShutdown|anthropicAccounts\.setSessionShutdown/);
assert.match(ipc, /anthropicAccounts\.setTerminalSessions\(\{[\s\S]*?pty\.disposeNativeClaudeProfileSessions\(profileId\)/);
assert.match(ipc, /grokAccounts\.setTerminalSessions\(\{[\s\S]*?pty\.disposeNativeGrokProfileSessions\(profileId\)/);
assert.match(ipc, /unifiedAccountsFor\(provider\)\.useAccount\(profileId, \{\s*closeSessions: input\?\.closeSessions === true/);
assert.match(ipc, /unifiedAccountsFor\(target\.provider\)\.deleteAccount\(profileId, \{/);
const nativeAccounts = read("src/main/orchestration/native-cli-accounts.ts");
assert.match(nativeAccounts, /NATIVE_CLI_ACCOUNT_UNIFIED/);
assert.doesNotMatch(nativeAccounts, /sessionShutdown|prepareLogin|execFile/);
const socket = read("src/main/agent-socket.ts");
assert.match(socket, /unifiedAccountsFor\(provider\)\.useAccount\(profileId, \{\s*closeSessions: params\.closeSessions === true/);
assert.match(socket, /unifiedAccountsFor\(current\.provider\)\.deleteAccount\(profileId, \{/);
assert.doesNotMatch(socket, /openNativeCliAccountLogin|nativeCliAccounts\.(?:create|setDefault|logout|delete|prepareLogin)\(/);

console.log(
  "PASS native CLI account IPC is sanitized, login tokens are refused in main, every provider switches and deletes through the unified account services, and one card model serves all three providers",
);
