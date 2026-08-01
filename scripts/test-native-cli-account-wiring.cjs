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
const app = read("src/renderer/src/App.tsx");
const tabs = read("src/renderer/src/tabs/useTabs.ts");
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
]) {
  assert.equal(
    preloadAccountApi.includes(forbidden),
    false,
    `${forbidden} must not appear in the preload account API`,
  );
}

// Main owns the launch specification. Renderer pty.spawn can supply only the
// opaque token; the branch resolves executable/args/env inside main.
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

// Settings presents one merged Accounts section: CLI sign-ins and Cora
// connections share a single card list, and the copy still tells the user the
// two logins are stored apart — in plain language, with no OAuth vocabulary.
assert.match(settings, /title="Accounts"/);
assert.match(settings, /each need their own sign-in, even to the same account/);
assert.match(settings, /<AccountCards providers=\{providerViews\}/);
assert.ok(
  settings.indexOf("<AccountsSettings />") >= 0,
  "the Agents tab must render the merged Accounts section",
);
// A Cora connection and a CLI sign-in share one card only when the main
// process reports the same anonymous account fingerprint for both.
assert.match(settings, /Identity pairing/);
assert.match(settings, /cliByFingerprint/);
assert.match(settings, /profile\.accountFingerprint/);
assert.match(
  settings,
  /key: paired \? `cora:\$\{profile\.id\}\+cli:\$\{paired\.id\}` : `cora:\$\{profile\.id\}`/,
);
assert.match(settings, /\.\.\.\(paired \? \{ cli: cliFacet\(paired\) \} : \{\}\)/);
// Unmatched entries keep their own card, and the copy still says so. An
// Anthropic account connected before Codara could read its account id is the
// one case that can be merged by reconnecting, so that card — and only a
// Cora-only card sitting beside an unmatched CLI sign-in — offers it.
assert.match(settings, /filter\(\(profile\) => !pairedCliIds\.has\(profile\.id\)\)/);
assert.match(settings, /key: `cli:\$\{profile\.id\}`/);
assert.match(settings, /that account appears twice — once for each sign-in/);
assert.match(settings, /card\.cora && !card\.cli && cliOnlyCards\.length > 0/);
assert.match(settings, /pairHint: `Reconnect to Cora if this is the same account/);
// The built-in CLI sign-in has no name field of its own, so its card name is a
// Codara-side preference (nativeCliAccountLabels, keyed runtime:profileId) with
// "Personal" as the fallback. The label is cosmetic: the unmanaged rename path
// writes the preference and never reaches the CLI rename IPC.
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
assert.match(settings, /\|\| "Personal"/);
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
// The address a card shows comes from the same read: Codex keeps it in the
// OpenID claims of the token it stored, Claude Code in its config. Neither is
// verified, decoded further, or used for anything but display.
assert.match(identity, /jwtEmailClaim\(tokens\.id_token\)/);
assert.match(identity, /account\.emailAddress/);
assert.match(identity, /Buffer\.from\(payload, "base64url"\)/);
assert.doesNotMatch(identity, /createVerify|jwt\.verify|crypto\.verify/);
// Claude Code records the same Anthropic account uuid the Cora side captures
// when its login finishes, so both hash into one id space per provider.
assert.match(identity, /account\.accountUuid/);
assert.match(identity, /oauthAccount/);
assert.match(identity, /accountUuid\.trim\(\)\.toLowerCase\(\)/);
// The home directory is supplied by the caller, so a store pointed at a
// sandbox can never read the real one.
assert.match(identity, /join\(configDirEnv \?\? homeDir, "\.claude\.json"\)/);
assert.doesNotMatch(identity, /homedir\(\)/);
// Read-only: the stored files are opened for reading and nothing else.
assert.match(identity, /fs\.readFile\(path, "utf8"\)/);
assert.doesNotMatch(
  identity,
  /writeFile|appendFile|\bfs\.rename\b|\bfs\.rm\b|unlink|chmod|utimes|copyFile|\bfs\.open\(/,
);
// Unreadable or account-id-less files are simply unpaired, never errors.
assert.match(identity, /return undefined;/);
assert.match(identity, /\} catch \{/);

// Anthropic's account uuid is read exactly once, from the endpoint that answers
// the access token the login just produced. It is never read from a stored
// credential and never triggers a refresh.
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
assert.match(
  piAuthSource,
  /readAnthropicAccountIdentity\(credential\.access\)/,
);
// Only the connect path may call it: persistCredential runs with the credential
// the login just returned.
assert.equal(
  piAuthSource.split("readAnthropicAccountIdentity(").length - 1,
  1,
);
assert.match(
  piAuthSource,
  /const identity = await connectTimeIdentity\(/,
);
// The address is persisted with the digest, so an existing connection picks it
// up on its next reconnect exactly as the digest does.
assert.match(
  piAuthSource,
  /accountEmail: identity\.email/,
);
// Reconnecting an account that predates the capture is what pairs it, so the
// digest is recorded on the existing profile rather than only on a new one.
const authStoreSource = read("src/main/orchestration/pi-account-auth-store.ts");
assert.match(authStoreSource, /recordIdentityFingerprint\(/);
const profilesSource = read("src/main/orchestration/pi-account-profiles.ts");
assert.match(profilesSource, /async recordIdentityFingerprint\(/);
assert.match(profilesSource, /async recordAccountEmail\(/);
assert.match(authStoreSource, /recordAccountEmail\(/);
// It never overwrites a digest and never lets a duplicate corrupt the file.
assert.match(profilesSource, /if \(current\.identityFingerprint\) return cloneProfile\(current\);/);
assert.match(profilesSource, /if \(claimed\) return cloneProfile\(current\);/);

const nativeDtoSource = shared.slice(dtoStart, dtoEnd);
assert.match(nativeDtoSource, /accountFingerprint\?: string;/);
// The account's own address is the one identity value the local Settings window
// gets besides the digest; the vendor ids behind it still never cross.
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
    `${rawIdentity} must never cross IPC — only the fingerprint digest does`,
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

// A card that is only signed in to the CLI says why it has no usage bars
// instead of showing none — Codara never uses the CLI's credential to ask.
assert.match(
  settingsView,
  /Usage limits show once this account is connected to Cora/,
);
assert.match(settingsView, /const cliOnly = Boolean\(cli && !cora\);/);
assert.match(settingsView, /\) : cliOnly \? \(/);
// The address renders under the card name, once, taking the Cora facet first.
// The render is unconditional on the card kind: a Cora-only card shows its
// email exactly like a CLI or merged card whenever one is known.
assert.match(settingsView, /\{card\.email \? \(/);
assert.match(settingsView, /\{card\.email\}/);
assert.match(settings, /const email = profile\.email \?\? paired\?\.email;/);
assert.match(settings, /\.\.\.\(email \? \{ email \} : \{\}\)/);

// When fingerprints are absent, a case-insensitive email match inside the same
// provider group is the fallback pairing: the two sign-ins merge into one card
// with a hint to reconnect. A fingerprint match always wins, two differing
// fingerprints block the email match, and the email map is scoped to one
// provider's loop so a match can never cross providers.
assert.match(settings, /const cliByEmail = new Map<string, NativeCliAccountProfile>\(\);/);
assert.match(settings, /profile\.email\?\.trim\(\)\.toLowerCase\(\)/);
assert.match(settings, /const candidate = byFingerprint \?\? byEmail;/);
assert.match(
  settings,
  /!profile\.accountFingerprint \|\| !byEmailCandidate\.accountFingerprint/,
);
assert.match(settings, /an email never matches across providers/);
assert.match(settings, /const pairedByEmail = Boolean\(paired && !byFingerprint\);/);
assert.match(
  settings,
  /Same email address — reconnect to Cora to fully pair these sign-ins\./,
);

// Action diet on every card: at most two visible buttons (the accent primary
// next step plus one runner-up); everything else — including Sign out and the
// two-step Delete — lives in the "···" overflow menu on the shared spark-menu
// surface, with the destructive group at the bottom.
assert.match(settingsView, /const MAX_VISIBLE_CARD_ACTIONS = 2;/);
assert.match(settingsView, /nextSteps\.slice\(0, MAX_VISIBLE_CARD_ACTIONS\)/);
assert.match(settingsView, /function CardOverflowMenu\(/);
assert.match(settingsView, /groups=\{\[menuActions, destructiveActions\]\}/);
assert.match(settingsView, /More actions for \$\{card\.label\}/);

// Each card names its connections in plain language, one line per connection,
// and a merged card carries both sides' actions and its own active wording.
assert.match(settingsView, /Connected to Cora/);
assert.match(settingsView, /Not signed in to \$\{cliLabel\}/);
assert.match(settingsView, /cli\?\.managed/);
assert.match(settingsView, /"Active in Cora"/);
assert.match(settingsView, /`Active in \$\{cliLabel\}`/);
// The pill always names the side it means; plain "Active" is reserved for a
// paired card that is the live account on both sides — a lone "Active" next to
// "Not connected to Cora" read as a contradiction.
assert.match(
  settingsView,
  /cora && cli && cora\.active && cli\.active\s*\? "Active"/,
);
// A card with a CLI sign-in but no Cora connection leads with "Connect to
// Cora", wired to the same add-account login flow seeded with the card's name.
assert.match(settingsView, /onCoraConnect: \(card: AccountCardView\) => void;/);
assert.match(settingsView, /actions\.onCoraConnect\(card\)/);
assert.match(
  settings,
  /onCoraConnect: \(card\) => addAccount\(card\.provider, card\.label\)/,
);
assert.match(settingsView, /cli \? "Use this account for Cora" : "Use this account"/);
assert.match(
  settingsView,
  /cora \? `Use this account for \$\{cliLabel\}` : "Use this account"/,
);
assert.match(settingsView, /"Remove from Cora"/);
assert.match(settingsView, /`Remove the \$\{cliLabel\} account`/);

// A managed account directory is created past the CLI's first-run wizard, so a
// never-signed-in account opens a working prompt with no sign-in behind it. The
// card says so up front — one muted line, only while the facet exists, is not
// busy, and is signed out — rather than letting the terminal be the messenger.
assert.match(settingsView, /export function cliSignInHint\(/);
assert.match(
  settingsView,
  /if \(!facet \|\| facet\.busyAction \|\| facet\.authState !== "signed-out"\) return null;/,
);
assert.match(
  settingsView,
  /This account isn't signed in to \$\{cliLabel\} yet — use "Sign in to \$\{cliLabel\}" below, or run \$\{facet\.runtime\} in a terminal once\./,
);
assert.match(settingsView, /const signInHint = cliSignInHint\(cli, cliLabel\);/);
assert.match(settingsView, /\{signInHint \? \(/);
assert.match(settingsView, /\{signInHint\}/);
// The hint points at a button that is guaranteed to be on screen: "Sign in to
// <tool>" is built first in the ladder for exactly this state, so it is always
// among the visible actions rather than hidden in the overflow menu.
assert.match(
  settingsView,
  /const cliNeedsSignIn =[\s\S]{0,200}?cli\.authState === "signed-out"/,
);
assert.match(
  settingsView,
  /if \(cliNeedsSignIn\) \{\s*nextSteps\.push\(\{\s*id: "cli-sign-in",/,
);
// Switching the terminal to an account is only offered once that account is
// actually signed in, so the hint never sits next to an action that would fail.
assert.match(
  settingsView,
  /if \(cli\?\.authState === "connected" && !cli\.active\) \{\s*nextSteps\.push\(\{\s*id: "cli-use",/,
);

console.log(
  "PASS native CLI account IPC is sanitized, login PTY is one-shot/exact/exit-owned, transient tokens are not persisted, and Settings pairs a Cora connection with a CLI sign-in on an anonymous fingerprint while unmatched accounts keep their own cards",
);
