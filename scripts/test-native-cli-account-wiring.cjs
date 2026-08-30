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
const anthropicCard = read("src/renderer/src/components/AnthropicAccountCard.tsx");
const app = read("src/renderer/src/App.tsx");
const tabs = read("src/renderer/src/tabs/useTabs.ts");
const tabBar = read("src/renderer/src/tabs/TabBar.tsx");
const picker = read("src/renderer/src/components/WorkerSessionPicker.tsx");
const shortcutCommands = read("src/renderer/src/shortcuts/commands.ts");
const terminalStack = read("src/renderer/src/tabs/TerminalStack.tsx");
const session = read(
  "src/renderer/src/components/Terminal/useTerminalSession.ts",
);

for (const channel of [
  "native-cli-accounts:inspect",
  "native-cli-accounts:create",
  "native-cli-accounts:rename",
  "native-cli-accounts:set-default",
  "native-cli-accounts:prepare-login",
  "native-cli-accounts:cancel-login",
  "native-cli-accounts:logout",
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

// Main owns the launch specification for the Codex and Grok browser logins.
// Renderer pty.spawn can supply only the opaque token; the branch resolves
// executable/args/env inside main.
assert.match(ipc, /nativeCliAccounts\s*\.launchPreparedLogin\(launchToken/);
assert.match(ipc, /pty\.spawnExactExecutable\(\{/);
assert.match(ipc, /executable:\s*spec\.executable/);
assert.match(ipc, /args:\s*spec\.args/);
assert.match(ipc, /env:\s*spec\.env/);
assert.match(ipc, /const exit = await launched\.exit/);
assert.match(
  ipc,
  /if \(args\?\.nativeCliLoginToken !== undefined\) \{\s*return spawnPreparedNativeCliLogin/,
);
assert.doesNotMatch(
  preloadAccountApi,
  /launchPreparedLogin|spawnExactExecutable|spec\.(?:executable|args|env)/,
);

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
assert.match(app, /cancelLogin\(\{ launchToken \}\)/);
assert.match(app, /event\.preventDefault\(\)/);
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
// Settings presents one merged Accounts section. An Anthropic account is one
// sign-in with two halves paired in the main process; Codex and Grok keep a
// Cora sign-in and a terminal sign-in apart, and switching one of their
// terminal sign-ins still closes that tool's running sessions first.
assert.match(settings, /title="Accounts"/);
assert.match(settings, /A Claude account is one sign-in for both Cora and Claude Code/);
assert.match(settings, /closes that tool's running sessions first/);
assert.match(settings, /<AccountCards providers=\{providerViews\}/);
assert.ok(
  settings.indexOf("<AccountsSettings />") >= 0,
  "the Agents tab must render the merged Accounts section",
);

// The Anthropic branch never speaks to the native CLI account store for a
// switch or a sign-in: Use goes through the Pi make-default channel, which
// switches Cora and Claude Code together in main, and Add/Reconnect are the
// Pi browser sign-in, which writes both halves. The only Claude-runtime
// native calls left are rename and delete of a terminal-only half.
assert.match(settings, /if \(descriptor\.provider === "anthropic"\) \{/);
assert.match(settings, /void makeDefault\("anthropic", card\.coraProfileId\)/);
assert.match(settings, /reconnectAccount\("anthropic", card\.coraProfileId, card\.label\)/);
assert.match(settings, /nativeCliAccounts\.rename\(\{\s*runtime: "claude",/);
assert.match(settings, /nativeCliAccounts\.delete\(\{ runtime: "claude", profileId \}\)/);
assert.equal((settings.match(/runtime: "claude"/g) ?? []).length, 2);
const anthropicActions = settings.slice(
  settings.indexOf("    anthropic: {"),
  settings.indexOf("  const accountsReady ="),
);
assert.ok(anthropicActions.length > 0, "the Anthropic action block must exist");
assert.doesNotMatch(
  anthropicActions,
  /nativeCliAccounts\.(?:setDefault|prepareLogin|create|logout)|spark:open-native-cli/,
  "no Claude switch or sign-in may go through the native CLI account store",
);
assert.doesNotMatch(anthropicCard, /nativeCliAccounts|spark:open-native-cli/);
// Card keys are ids main assigned, so pairing never remounts a card.
assert.match(settings, /key: `anthropic:\$\{profile\.id\}`/);
assert.match(settings, /key: `anthropic:cli:\$\{profile\.id\}`/);
assert.match(settings, /key: "anthropic:account-one"/);
// Account 1 keeps the Cora row's label (renameable there); the Codara-side
// preference label is only for the Codex and Grok built-in sign-ins.
const anthropicBranch = settings.slice(
  settings.indexOf('if (descriptor.provider === "anthropic") {'),
  settings.indexOf("// Identity pairing:"),
);
assert.doesNotMatch(anthropicBranch, /nativeCliAccountLabels/);
assert.match(anthropicBranch, /label: personal\.label \|\| "Account 1"/);

// The Codex and Grok path is the two-facet card: a Cora connection and a CLI
// sign-in share one card only when the main process reports the same
// anonymous account fingerprint for both, with a same-provider email
// fallback where a fingerprint verdict is impossible. Unmatched entries keep
// their own card.
assert.match(settings, /Identity pairing/);
assert.match(settings, /cliByFingerprint/);
assert.match(settings, /profile\.accountFingerprint/);
assert.match(
  settings,
  /key: paired \? `cora:\$\{profile\.id\}\+cli:\$\{paired\.id\}` : `cora:\$\{profile\.id\}`/,
);
assert.match(settings, /\.\.\.\(paired \? \{ cli: cliFacet\(paired\) \} : \{\}\)/);
assert.match(settings, /filter\(\(profile\) => !pairedCliIds\.has\(profile\.id\)\)/);
assert.match(
  settings,
  /profile\.managed \|\| profile\.status === "connected"/,
  "an unsigned built-in CLI slot must not render as its own account card",
);
assert.match(settings, /unsigned built-in CLI slot is not an account/);
assert.match(settings, /key: `cli:\$\{profile\.id\}`/);
assert.match(settings, /Only a \*signed-in\* unmatched CLI can merge/);
assert.match(settings, /card\.cora && !card\.cli && unmatchedSignedInCli\.length > 0/);
assert.match(settings, /pairHint: `Reconnect to Cora if this is the same account/);
assert.match(settings, /card\.cli\?\.authState === "connected"/);
assert.match(settings, /function accountCardShowsUsage/);
assert.match(settings, /accountCardShowsUsage\(usage\)/);
assert.match(settings, /const cliByEmail = new Map<string, NativeCliAccountProfile>\(\);/);
assert.match(settings, /profile\.email\?\.trim\(\)\.toLowerCase\(\)/);
assert.match(settings, /const candidate = byFingerprint \?\? byEmail;/);
assert.match(
  settings,
  /!profile\.accountFingerprint \|\| !byEmailCandidate\.accountFingerprint/,
);
assert.match(settings, /an email never matches across providers/);
assert.match(settings, /const pairedByEmail = Boolean\(paired && !byFingerprint\);/);
assert.match(settings, /Same email address\. Reconnect to Cora to fully pair these sign-ins\./);
assert.match(settings, /const email = profile\.email \?\? paired\?\.email;/);
assert.match(settings, /\.\.\.\(email \? \{ email \} : \{\}\)/);

// The Codex and Grok built-in sign-in has no name field of its own, so its
// card name is a Codara-side preference (nativeCliAccountLabels, keyed
// runtime:profileId), then the store's "Existing … login" label, with
// "Personal" as last resort.
assert.match(settings, /\|\| profile\.label \|\| "Personal"/);
const prefsStore = read("src/main/preferences-store.ts");
assert.match(shared, /nativeCliAccountLabels: Record<string, string>;/);
assert.match(shared, /nativeCliAccountLabels: \{\},/);
assert.match(
  prefsStore,
  /nativeCliAccountLabels: normalizeStringMap\(src\.nativeCliAccountLabels\)/,
);
assert.match(
  settings,
  /label: profile\.managed\s*\? profile\.label\s*: preferences\.nativeCliAccountLabels\[/,
);
assert.match(settings, /\$\{descriptor\.runtime\}:\$\{profile\.id\}/);
assert.match(settings, /if \(!managed\) \{/);
assert.match(settings, /setPreference\("nativeCliAccountLabels", \{/);
assert.match(settings, /\[`\$\{runtime\}:\$\{profileId\}`\]: label,/);

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

// The Codex and Grok card: a card that is only signed in to the CLI says why
// it has no usage bars instead of showing none, Use-for-Cora and use-for-CLI
// are independent role rows, and everything else lives in the "···" menu.
assert.match(
  settingsView,
  /Usage limits show once this account is connected to Cora/,
);
assert.match(settingsView, /const cliOnly = Boolean\(cli && !cora\);/);
assert.match(settingsView, /\) : cliOnly \? \(/);
assert.match(settingsView, /\{card\.email \? \(/);
assert.match(settingsView, /\{card\.email\}/);
assert.match(settingsView, /function AccountRoleRow\(/);
assert.match(settingsView, /groups=\{\[menuActions, destructiveActions\]\}/);
assert.match(settingsView, /More actions for \$\{card\.label\}/);
assert.match(settingsView, /Connected to Cora/);
assert.match(settingsView, /Not signed in to \$\{cliLabel\}/);
assert.match(settingsView, /cli\?\.managed/);
assert.match(settingsView, /usingLabel="Using"/);
assert.match(settingsView, /label: "Use this account for Cora"/);
assert.match(settingsView, /: `Use this account for \$\{cliLabel\}`/);
assert.match(settingsView, /onCliConnect: \(card: AccountCardView\) => void;/);
assert.match(settingsView, /onCoraConnect: \(card: AccountCardView\) => void;/);
assert.match(settingsView, /actions\.onCoraConnect\(card\)/);
assert.match(
  settings,
  /onCoraConnect: \(card\) => addAccount\(card\.provider, card\.label\)/,
);
assert.match(settings, /onCliConnect: \(card\) => \{/);
assert.match(settings, /const reusableManaged = runtimeInspection\?\.profiles\.find/);
assert.match(settings, /profile\.status === "sign_in_required"/);
assert.match(settings, /removeProfileOnFailure: true/);
assert.match(settings, /activateOnSuccess: true/);
assert.match(settings, /spark:open-native-cli-account/);
assert.match(app, /spark:open-native-cli-account/);
assert.match(app, /nativeCodexProfileId: profileId/);
assert.match(app, /nativeGrokProfileId: profileId/);
// Switching an Anthropic account closes nothing and opens nothing: new
// terminals pick it up. App only opens a fresh session for Codex and Grok.
assert.match(app, /\(runtime !== "codex" && runtime !== "grok"\) \|\|/);
assert.doesNotMatch(app, /nativeClaudeProfileId: profileId/);
assert.match(settingsView, /"Remove from Cora"/);
assert.match(settingsView, /`Remove the \$\{cliLabel\} account`/);
assert.match(settingsView, /export function cliSignInHint\(/);
assert.match(
  settingsView,
  /if \(!facet \|\| facet\.busyAction \|\| facet\.authState !== "signed-out"\) return null;/,
);
assert.match(settingsView, /const signInHint = cliSignInHint\(cli, cliLabel\);/);
assert.match(
  settingsView,
  /const cliNeedsSignIn =[\s\S]{0,200}?cli\.authState === "signed-out"/,
);
assert.match(settingsView, /id: "cli-sign-in"/);
assert.match(
  settingsView,
  /cli \? actions\.onCliSignIn\(card\) : actions\.onCliConnect\(card\)/,
);
assert.match(settingsView, /id: "cli-use"/);
assert.match(settingsView, /actions\.onCliUse\(card\)/);
assert.match(settingsView, /`Confirm & close \$\{cliLabel\}`/);
assert.match(settingsView, /const \[cliSwitchArmed, setCliSwitchArmed\] = useState\(false\)/);
// The one-account card has none of the two-role machinery.
assert.doesNotMatch(anthropicCard, /AccountRoleRow|cliSwitchArmed|Confirm & close|Remove from Cora/);

// The main process owns the Codex and Grok shutdown boundary. Codara PTYs get
// a graceful close first, external terminals are then quiesced, and the
// account service does not mutate the selected account until that callback
// resolves. Claude never enters this path: its switch is the unified account
// service, and native-cli-accounts refuses a Claude default change.
assert.match(ipc, /nativeCliAccounts\.setSessionShutdown\(async \(runtime\) =>/);
assert.match(ipc, /pty\.disposeNativeCliRuntimeGraceful\(runtime\)/);
assert.match(ipc, /shutdownExternalNativeCliProcesses\(runtime\)/);
assert.match(ipc, /anthropicAccounts\.useAnthropicAccount\(row\.id\)/);
assert.match(ipc, /anthropicAccounts\.deleteTerminalOnlyProfile\(/);
const nativeAccounts = read("src/main/orchestration/native-cli-accounts.ts");
assert.match(nativeAccounts, /NATIVE_CLI_ACCOUNT_UNIFIED/);
assert.match(nativeAccounts, /const shutdown = await this\.sessionShutdown\(runtime\)/);

console.log(
  "PASS native CLI account IPC is sanitized, login PTY is one-shot/exact/exit-owned, transient tokens are not persisted, Anthropic switches go through the unified account service, and Codex and Grok keep fingerprint-paired two-facet cards",
);
