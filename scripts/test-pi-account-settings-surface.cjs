const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (relativePath) =>
  fs.readFileSync(path.join(ROOT, relativePath), "utf8");

const shared = read("src/shared/types.ts");
const ipc = read("src/main/ipc.ts");
const runGuard = read("src/main/orchestration/pi-account-run-guard.ts");
const preload = read("src/preload/index.ts");
const settings = read("src/renderer/src/components/SettingsDialog.tsx");
const cards = read("src/renderer/src/components/AccountCards.tsx");
const card = read("src/renderer/src/components/AccountCard.tsx");
const descriptors = read("src/renderer/src/lib/account-provider-descriptors.ts");
const primitives = read("src/renderer/src/components/AccountCardPrimitives.tsx");
const app = read("src/renderer/src/App.tsx");
const usageUi = read("src/renderer/src/components/SubscriptionUsage.tsx");
const usageMeters = read("src/renderer/src/components/UsageMeters.tsx");

// The account channel set. Every one is registered through the trusted IPC
// wrapper and exposed by preload; share-login is the one addition of the
// unified account model.
const channels = [
  "pi-subscriptions:status",
  "pi-subscriptions:add-account",
  "pi-subscriptions:reconnect-account",
  "pi-subscriptions:rename-account",
  "pi-subscriptions:make-default",
  "pi-subscriptions:delete-account",
  "pi-subscriptions:share-login",
  "pi-subscriptions:respond",
  "pi-subscriptions:cancel",
  "pi-subscriptions:usage",
];
for (const channel of channels) {
  assert.ok(
    ipc.includes(`handle(\n    "${channel}"`) || ipc.includes(`handle("${channel}"`),
    `${channel} must be registered through the trusted IPC wrapper`,
  );
  assert.ok(
    preload.includes(`ipcRenderer.invoke("${channel}"`),
    `${channel} must be exposed by preload`,
  );
}

assert.match(ipc, /isPiSubscriptionProvider\(value\)/);
assert.doesNotMatch(
  ipc,
  /value === "anthropic" \|\| value === "openai-codex"/,
);
assert.match(ipc, /startPiSubscriptionProfileLogin/);
assert.match(ipc, /renamePiAccountProfile/);
// Every provider's mutations go through its unified service: one switch for
// both halves, one delete that hands off and closes only that account's
// terminals, one share in either direction.
assert.match(ipc, /unifiedAccountsFor\(provider\)\.useAccount\(profileId, \{/);
assert.match(ipc, /unifiedAccountsFor\(target\.provider\)\.deleteAccount\(profileId, \{/);
assert.match(ipc, /closeSessions: input\?\.closeSessions === true/);
assert.match(ipc, /unifiedAccountsFor\(provider\)\.shareLogin\(\{/);
assert.doesNotMatch(ipc, /setDefaultPiAccountProfile|deletePiSubscriptionProfile|useAnthropicAccount|deleteAnthropicAccount/);
assert.match(ipc, /ownershipGuard:\s*async \(profile\)/);
assert.match(ipc, /const \{ listRuns \} = await getRunStore\(\)/);
assert.match(ipc, /assertPiAccountProfileIsNotActiveInRuns\(runs, profileId\)/);
assert.match(runGuard, /run\.chatAccountProfileId === profileId/);
assert.match(runGuard, /run\.sparkCalls\.some\(\(call\) => call\.accountProfileId === profileId\)/);
assert.match(runGuard, /attempt\.accountProfileId === profileId/);
assert.match(runGuard, /"complete",\s*"failed",\s*"cancelled"/);
assert.match(runGuard, /"succeeded",\s*"failed",\s*"timed_out",\s*"cancelled"/);
assert.ok(
  runGuard.includes(
    "This account is still in use by an active Cora run or worker. Finish or cancel that work before deleting it.",
  ),
);
assert.match(
  ipc,
  /Codara could not verify whether this account is used by an active run\. The account was not deleted\./,
);

for (const api of [
  "addAccount:",
  "reconnectAccount:",
  "renameAccount:",
  "makeDefault:",
  "deleteAccount:",
  "shareLogin:",
]) {
  assert.ok(preload.includes(api), `${api} renderer API must exist`);
}
// The legacy one-row-per-provider channels are gone from the renderer.
assert.doesNotMatch(preload, /ipcRenderer\.invoke\("pi-subscriptions:connect"/);
assert.doesNotMatch(preload, /ipcRenderer\.invoke\("pi-subscriptions:disconnect"/);
assert.doesNotMatch(settings, /piSubscriptions\.connect\(/);
assert.doesNotMatch(settings, /piSubscriptions\.disconnect\(/);
assert.doesNotMatch(settings, /PiSubscriptionRow/);
assert.doesNotMatch(settings, /overview\.connections/);
assert.doesNotMatch(settings, /<SubscriptionUsage\b/);
// The title bar reads the one active flag; there is no providers[] fallback.
assert.doesNotMatch(usageMeters, /overview\?\.providers/);
assert.match(usageMeters, /overview\?\.profiles\?\.filter\(\(profile\) => profile\.isDefault\)/);
assert.doesNotMatch(usageUi, /function ProviderCard\(/);
assert.doesNotMatch(usageUi, /export default function SubscriptionUsage/);

// ---------------------------------------------------------------------------
// One descriptor per provider: the only place the three differ in the panel.
assert.match(descriptors, /export const ACCOUNT_PROVIDER_DESCRIPTORS/);
assert.match(descriptors, /AGENT_FAMILY_IDS\.map\(\(id\) => \(\{/);
assert.match(descriptors, /cliLabel: "Claude Code" \| "Codex" \| "Grok";/);
assert.match(descriptors, /loginHint: "claude login" \| "codex login" \| "grok login";/);
assert.match(descriptors, /brand: "claude" \| "codex" \| "grok";/);
assert.match(descriptors, /claude: \{ cliLabel: "Claude Code", loginHint: "claude login", switchClosesSessions: false \}/);
assert.match(descriptors, /codex: \{ cliLabel: "Codex", loginHint: "codex login", switchClosesSessions: true \}/);
assert.match(descriptors, /grok: \{ cliLabel: "Grok", loginHint: "grok login", switchClosesSessions: false \}/);
assert.equal((descriptors.match(/switchClosesSessions: true/g) ?? []).length, 1, "only Codex closes sessions on a switch");
assert.match(descriptors, /export function accountProviderDetail\(/);
assert.ok(
  descriptors.includes(
    "`One sign-in per account. Switching an account moves Cora and ${descriptor.cliLabel} together. New terminals pick it up; running ones keep theirs. Account 1 is your own ${descriptor.loginHint}.`",
  ),
);
assert.ok(
  descriptors.includes(
    "`One sign-in per account. Switching an account moves Cora and ${descriptor.cliLabel} together and closes running ${descriptor.cliLabel} sessions, because ${descriptor.cliLabel} keeps one sign-in for every terminal. Account 1 is your own ${descriptor.loginHint}.`",
  ),
);
assert.match(descriptors, /if \(descriptor\.switchClosesSessions\) \{/);

// ---------------------------------------------------------------------------
// One card model for every provider. The main process pairs the Cora row
// with its terminal half; the renderer keys cards by id and matches nothing.
assert.match(settings, /return ACCOUNT_PROVIDER_DESCRIPTORS\.map\(\(descriptor\) => \{/);
assert.match(settings, /detail: accountProviderDetail\(descriptor\),/);
assert.match(settings, /key: `\$\{provider\}:\$\{profile\.id\}`/);
assert.match(settings, /key: `\$\{provider\}:cli:\$\{profile\.id\}`/);
assert.match(settings, /key: `\$\{provider\}:account-one`/);
assert.match(settings, /profile\.managed && !linked\.has\(profile\.id\)/);
assert.match(settings, /builtIn: profile\.builtIn === true/);
assert.match(settings, /active: profile\.isDefault/);
assert.match(settings, /connected: profile\.connected/);
assert.match(settings, /expired: profile\.expired/);
assert.match(settings, /canRefresh: profile\.canRefresh/);
assert.match(settings, /\.\.\.\(profile\.terminal \? \{ terminal: profile\.terminal \} : \{\}\)/);
assert.match(settings, /label: personal\.label \|\| "Account 1"/);
// No provider branch, no renderer-side pairing, no second card shape.
const accountsSection = settings.slice(
  settings.indexOf("function AccountsSettings()"),
  settings.indexOf("function AgentsSettings()"),
);
assert.ok(accountsSection.length > 0, "the Accounts section must exist");
assert.doesNotMatch(accountsSection, /descriptor\.provider === "anthropic"|provider === "anthropic"/);
assert.doesNotMatch(
  accountsSection,
  /accountFingerprint|cliByEmail|cliByFingerprint|pairHint|cliOnlyCards|Identity pairing/,
);
assert.doesNotMatch(
  accountsSection,
  /signInCli|onCoraConnect|onCliConnect|onCliUse|onCliSignIn|onCliSignOut|onCliDelete|onCoraUse|onCoraDelete|onBeginAddCli|onAddCli/,
);
assert.doesNotMatch(accountsSection, /anthropicCards|AnthropicAccountCardView|anthropic: \{/);
assert.doesNotMatch(settings, /nativeCliAccountLabels|spark:open-native-cli|cliRuntimeForProvider|nativeCliAuthState/);
assert.doesNotMatch(
  settings,
  /nativeCliAccounts\.(?:create|setDefault|prepareLogin|cancelLogin|logout)\(/,
  "no sign-in, switch or sign-out may go through the native CLI account store",
);
// The footer counts accounts, not the signed-out Account 1 instruction slot,
// and is omitted when there are none.
assert.match(settings, /card\.coraProfileId \|\| card\.terminal\?\.connected/);
assert.match(settings, /\.\.\.\(count > 0 \? \{ footer: `\$\{count\} \$\{count === 1 \? "account" : "accounts"\}` \} : \{\}\)/);
// The section copy says what one account is.
assert.ok(
  settings.includes(
    "The sign-ins Cora and the terminal tools run on. Every account is one sign-in for both Cora and its terminal tool: Claude Code, Codex, or Grok.",
  ),
);
assert.doesNotMatch(settings, /closes that tool's running sessions first/);

// One Use, one Reconnect, one Share, one Rename, one Delete, all through
// the Pi account channels, the provider taken from the card. The terminal
// id only reaches the native store for a half that has no row.
assert.match(settings, /onUse: \(card, \{ closeSessions \}\) => \{/);
assert.match(settings, /void makeDefault\(card\.provider, card\.coraProfileId, closeSessions\)/);
assert.match(settings, /reconnectAccount\(card\.provider, card\.coraProfileId, card\.label\)/);
assert.match(settings, /piSubscriptions\.shareLogin\(\{ coraProfileId \}\)/);
assert.match(settings, /piSubscriptions\.shareLogin\(\{\s*cliProfileId,\s*provider: card\.provider,\s*\}\)/);
assert.match(settings, /void deleteAccount\(card\.coraProfileId, closeSessions\)/);
assert.match(settings, /\.\.\.\(closeSessions \? \{ closeSessions: true \} : \{\}\)/);
assert.match(settings, /nativeCliAccounts\.rename\(\{\s*runtime: runtimeForSubscription\(card\.provider\),/);
assert.match(settings, /nativeCliAccounts\.delete\(\{\s*runtime: runtimeForSubscription\(card\.provider\),/);
assert.doesNotMatch(settings, /runtime: "claude"/);
// A refused switch or delete carries the live terminal count; the card's
// next Use or Delete offers to close them.
assert.match(settings, /function liveTerminalCount\(message: string\): number \| null/);
assert.match(settings, /terminal sessions\? \(\?:is\|are\) using this account/);
assert.match(settings, /action: "use" \| "delete";/);
assert.match(settings, /refusedWithSessions\(profileId, "use", err\)/);
assert.match(settings, /refusedWithSessions\(profileId, "delete", err\)/);
assert.match(settings, /setCloseSessionsPrompt\(\{ profileId, action, count \}\)/);
assert.match(settings, /refused\?\.action === "delete"\s*\? refused\.count\s*: \(profile\.terminal\?\.liveSessions \?\? 0\)/);
assert.match(settings, /const switchCloseSessionsCount = refused\?\.action === "use" \? refused\.count : 0;/);
assert.match(settings, /setCloseSessionsPrompt\(null\);\n    void window\.spark\.piSubscriptions\n      \.status\(\)/);
assert.match(settings, /function ipcErrorMessage\(err: unknown\): string/);
// Every error class name is stripped before a message reaches the panel.
assert.match(settings, /\.replace\(\/\^\[A-Za-z\]\*Error:\\s\*\/, ""\)/);

// No pop-in: every store answers before any card shows, and a failed status
// read still shows what the CLI side can build.
assert.match(settings, /const accountsReady =/);
assert.match(
  settings,
  /\(overview !== null \|\| overviewSettled\) && \(cliInspection !== null \|\| cliError !== null\)/,
);
assert.match(settings, /setOverviewSettled\(true\)/);
assert.doesNotMatch(settings, /loading \|\| cliLoading/);
assert.match(settings, /\{!accountsReady \? \(/);

// The login URL only ever reopens in the system browser: openExternal routes
// browser-ish URLs into the in-app browser, which cannot finish an OAuth
// callback.
assert.match(settings, /openInSystemBrowser\(login\.url!\)/);
assert.doesNotMatch(settings, /openExternal\(login\.url/);
assert.doesNotMatch(card, /openExternal|window\.open\(/);
assert.doesNotMatch(cards, /openExternal|window\.open\(/);

// ---------------------------------------------------------------------------
// The card itself: six states, one primary action each, one overflow menu,
// every word taken from the descriptor.
assert.match(card, /export function accountCardState\(card: AccountCardView\): AccountCardState/);
for (const state of [
  '"active"',
  '"signed-in"',
  '"needs-reconnect"',
  '"terminal-only"',
  '"cora-only"',
  '"account-one-signed-out"',
]) {
  assert.ok(card.includes(`| ${state}`), `${state} must be a card state`);
}
assert.match(card, /return card\.builtIn \? "account-one-signed-out" : "terminal-only";/);
assert.match(card, /if \(card\.builtIn && !coraUsable\) return "account-one-signed-out";/);
assert.match(card, /if \(!coraUsable\) return "needs-reconnect";/);
assert.match(card, /if \(!card\.cliProfileId\) return "cora-only";/);
assert.match(card, /return card\.active \? "active" : "signed-in";/);
// A refreshable lapse is not an expiry.
assert.match(card, /!\(card\.cora\?\.expired && !card\.cora\.canRefresh\)/);
assert.ok(card.includes('text: "Refreshing the Cora sign-in."'));
assert.match(card, /descriptor: AccountProviderDescriptor;/);
assert.match(card, /const brand = agentBrandColor\(descriptor\.brand\);/);
// Provider words live in the descriptor, never in a string the card renders.
assert.doesNotMatch(card, /agentBrandColor\("claude"\)|["`][^"`\n]*(?:Claude Code|Codex|Grok|claude login)/);
for (const label of [
  '"Use this account"',
  'label: "Reconnect"',
  "label: `Share with ${descriptor.cliLabel}`",
  'label: "Share with Cora"',
  'label: "Rename"',
  '"Confirm delete"',
  '"Delete"',
]) {
  assert.ok(card.includes(label), `${label} must render`);
}
for (const copy of [
  "`Run ${descriptor.loginHint} in a terminal to use this account.`",
  "`Found your ${descriptor.loginHint}. Cora is linking it now.`",
  "`Signed in to Cora only. Share it so ${cliLabel} can use it too.`",
  "`${cliLabel} cannot use this profile's folder. Delete it and add the account again.`",
  "`Not signed in to ${cliLabel}. Delete it and add the account again.`",
  "`Signed in to ${cliLabel} only, and the terminal is using it. Share it so Cora can use it too.`",
  "`Signed in to ${cliLabel} only. Share it so Cora can use it too.`",
  "`Signed in to Cora. The ${cliLabel} copy is catching up.`",
  "`Signed in to Cora and ${cliLabel}.`",
  '"The Cora sign-in expired. Reconnect to keep using this account."',
]) {
  assert.ok(card.includes(copy), `${copy} must be the card's copy`);
}
assert.match(card, /card\.cora\?\.error && state !== "account-one-signed-out"/);
assert.match(card, /<UsingChip label="Using" color=\{brand\} \/>/);
// Active shows the badge and no Use button.
assert.match(card, /case "active":\s*case "account-one-signed-out":\s*return undefined;/);
// A Codex switch main refused arms the same button to close the sessions
// and switch; the card never invents the count, so Anthropic and Grok
// never show it.
assert.match(card, /const switchCount = card\.switchCloseSessionsCount \?\? 0;/);
assert.match(card, /\? `Close \$\{sessions\(switchCount\)\} and switch`\s*: "Use this account"/);
assert.match(card, /run: \(\) => actions\.onUse\(card, \{ closeSessions: switchCount > 0 \}\)/);
assert.match(card, /onUse: \(card: AccountCardView, options: \{ closeSessions: boolean \}\) => void;/);
// Delete is two-step inside the menu; the second step closes the terminals
// main reported and resends with closeSessions.
assert.match(card, /setDeleteArmed\(true\);\s*return false;/);
assert.match(card, /`Close \$\{sessions\(closeCount\)\} and delete`/);
assert.match(card, /return `\$\{count\} \$\{count === 1 \? "session" : "sessions"\}`;/);
assert.match(card, /actions\.onDelete\(card, \{ closeSessions: closeCount > 0 \}\)/);
assert.match(card, /onClose=\{\(\) => setDeleteArmed\(false\)\}/);
// Account 1 is renameable but never deleted or reconnected from here.
assert.match(card, /if \(renameable && !card\.builtIn\) \{/);
assert.equal((card.match(/<CardOverflowMenu/g) ?? []).length, 1);
assert.doesNotMatch(card, /nativeCliAccounts|piSubscriptions/);
assert.match(card, /inset 2px 0 0 \$\{brand\}/);
assert.match(card, /\{card\.email\}/);
assert.match(card, /\{card\.plan\} plan/);

// The two-facet card and every piece of its machinery are gone.
for (const source of [card, cards, settings, app]) {
  assert.doesNotMatch(
    source,
    /AccountRoleRow|cliSwitchArmed|Confirm & close|Remove from Cora|Remove the \$\{cliLabel\} account|CLI_ONLY_USAGE_HINT|cliSignInHint|AccountCoraFacet|AccountCliFacet|AnthropicAccountCard|anthropicCards|oneSignIn|AddAccountDestination/,
  );
}
assert.doesNotMatch(cards, /Connect to Cora|Sign in to \{selectedView\.cliLabel\}|Use this account for Cora|onBeginAddCli/);
assert.doesNotMatch(app, /spark:open-native-cli-account|spark:open-native-cli-login|onLoginError|cancelLogin/);

// The Add-account picker has one destination for every provider: choose the
// agent, name it, sign in. Pi's flow does the rest (a browser page for
// Anthropic and OpenAI, a device code for xAI).
assert.match(cards, /export function AccountAddPicker\(/);
assert.match(settings, /<AccountAddPicker providers=\{providerViews\} actions=\{accountActions\} \/>/);
assert.match(cards, /const providerDisabled = \(view: AccountProviderView\) => view\.disabled \|\| view\.busy;/);
assert.match(cards, /setSelectedProvider\(view\.descriptor\.provider\);\s*actions\.onBeginAdd\(view\.descriptor\.provider\);/);
assert.ok(
  cards.includes(
    "`Sign in once in your browser. Cora and ${selectedView.descriptor.cliLabel} both use it.`",
  ),
);
assert.match(cards, />\s*Sign in\s*<\/button>/);
assert.match(cards, /actions\.onAdd\(selectedView\.descriptor\.provider\);/);
assert.match(cards, /\{label\} · Cora and \{cliLabel\}/);
assert.equal(
  (cards.match(/\n\s*Add account\n/g) ?? []).length,
  1,
  "the Accounts UI must render one global Add account trigger",
);
// The provider group renders the one card for every provider.
assert.match(cards, /\{view\.cards\.map\(\(card\) => \(\s*<AccountCard\s+key=\{card\.key\}\s+card=\{card\}\s+descriptor=\{descriptor\}/);
assert.match(cards, /export interface AccountActions extends AccountCardActions \{/);
assert.match(settings, /const accountActions: AccountActions = \{/);
assert.match(settings, /onBeginAdd: \(provider\) => \{/);
assert.match(settings, /onAdd: \(provider\) => addAccount\(provider, addLabel\)/);
assert.match(settings, /piSubscriptions\.addAccount\(\{/);
assert.match(settings, /piSubscriptions\.reconnectAccount\(\{ provider, profileId \}\)/);

assert.doesNotMatch(shared, /nativeCliAccountLabels/);
assert.doesNotMatch(read("src/main/preferences-store.ts"), /nativeCliAccountLabels/);

// Plain language, no dashes, no configuration vocabulary in visible copy.
for (const [name, source] of [
  ["AccountCard.tsx", card],
  ["AccountCardPrimitives.tsx", primitives],
  ["AccountCards.tsx", cards],
  ["account-provider-descriptors.ts", descriptors],
]) {
  assert.doesNotMatch(source, /[\u2013\u2014]/, `${name} must not contain dashes`);
}
for (const jargon of ["OAuth", "credential", 'profile"', "managed account"]) {
  for (const source of [cards, card]) {
    assert.equal(
      source.includes(`>${jargon}`),
      false,
      `${jargon} must not appear in visible account copy`,
    );
  }
}
assert.doesNotMatch(accountsSection, /[\u2013\u2014]/, "the Accounts section must not contain dashes");

// ---------------------------------------------------------------------------
// Menus portal through AnchoredMenu (the Settings scroll pane clips in-place
// popovers): the shared card menu in the primitives module and the
// Add-account chooser in AccountCards, both below their trigger, end-aligned,
// above the dialog's z 100.
const anchored = read(
  "src/renderer/src/components/chat/composer/AnchoredMenu.tsx",
);
assert.match(primitives, /import AnchoredMenu from "\.\/chat\/composer\/AnchoredMenu"/);
assert.match(cards, /import AnchoredMenu from "\.\/chat\/composer\/AnchoredMenu"/);
assert.match(primitives, /export function CardOverflowMenu\(/);
assert.match(primitives, /if \(action\.run\(\) === false\) return;/);
assert.equal((primitives.match(/<AnchoredMenu\b/g) ?? []).length, 1);
assert.equal((cards.match(/<AnchoredMenu\b/g) ?? []).length, 1);
for (const source of [primitives, cards]) {
  assert.match(source, /placement="below"/);
  assert.match(source, /align="end"/);
  assert.match(source, /zIndex=\{SETTINGS_MENU_Z\}/);
  assert.doesNotMatch(
    source,
    /position:\s*"absolute"/,
    "no absolutely positioned popover may come back to the account cards",
  );
}
assert.doesNotMatch(card, /position:\s*"absolute"/);
assert.match(primitives, /export const SETTINGS_MENU_Z = 120/);
assert.match(primitives, /aria-haspopup="menu"/);
assert.match(primitives, /role="menuitem"/);
assert.match(primitives, /className="spark-menu"/);
assert.match(primitives, /className="spark-menu-item"/);
assert.match(cards, /aria-haspopup="dialog"/);
assert.match(cards, /role="listbox"/);
assert.match(cards, /role="option"/);
assert.match(anchored, /createPortal\(/);
assert.match(anchored, /document\.body,?\s*\)/);
assert.match(anchored, /placement\?: "above" \| "below"/);
assert.match(anchored, /align\?: "start" \| "end"/);
assert.match(anchored, /let activeMenu: \{ id: symbol; close: \(\) => void \} \| null = null;/);
assert.match(anchored, /if \(activeMenu !== null && activeMenu\.id !== id\) activeMenu\.close\(\);/);
assert.match(anchored, /if \(activeMenu\?\.id === id\) activeMenu = null;/);
assert.match(anchored, /addEventListener\("mousedown", onPointerDown, true\)/);
assert.match(anchored, /removeEventListener\("mousedown", onPointerDown, true\)/);

// ---------------------------------------------------------------------------
// Wire contract. Every provider's row carries the id of its terminal half
// and a token-blind status for it, never a path, token, or raw account id.
const connectionDtoStart = shared.indexOf(
  "export interface PiSubscriptionProfileConnection",
);
const connectionDtoEnd = shared.indexOf(
  "export interface PiSubscriptionAddAccountInput",
  connectionDtoStart,
);
assert.ok(connectionDtoStart >= 0 && connectionDtoEnd > connectionDtoStart);
const connectionDto = shared.slice(connectionDtoStart, connectionDtoEnd);
assert.match(connectionDto, /^\s*email\?: string;/m);
assert.match(connectionDto, /^\s*cliProfileId\?: string;/m);
assert.match(connectionDto, /^\s*builtIn\?: true;/m);
assert.match(
  connectionDto,
  /^\s*terminal\?: \{\s*connected: boolean;\s*expired: boolean;\s*canRefresh: boolean;\s*(?:\/\*\*[^*]*\*\/\s*)?liveSessions\?: number;\s*\};/m,
);
for (const forbiddenField of [
  "accessToken",
  "refreshToken",
  "accountId",
  "accountUuid",
  "identityFingerprint",
  "configDir",
  "authFile",
]) {
  assert.doesNotMatch(
    connectionDto,
    new RegExp(`^\\s*${forbiddenField}\\??\\s*:`, "m"),
    `${forbiddenField} must not cross the account IPC contract`,
  );
}
assert.match(
  shared,
  /export type PiSubscriptionShareLoginInput =\s*\| \{ coraProfileId: string \}\s*\| \{ cliProfileId: string; provider\?: PiSubscriptionProvider \};/,
);
assert.match(shared, /export interface PiSubscriptionMakeDefaultInput \{[\s\S]*?closeSessions\?: boolean;/);
assert.match(shared, /export interface PiSubscriptionDeleteAccountInput \{[\s\S]*?closeSessions\?: boolean;/);

const dtoStart = shared.indexOf("export interface PiSubscriptionAddAccountInput");
const dtoEnd = shared.indexOf("export interface PiSubscriptionOverview", dtoStart);
assert.ok(dtoStart >= 0 && dtoEnd > dtoStart, "shared account-management DTOs must exist");
const dtoSource = shared.slice(dtoStart, dtoEnd);
for (const forbiddenField of [
  "accessToken",
  "refreshToken",
  "identityFingerprint",
  "configDir",
  "authFile",
  "email",
]) {
  assert.doesNotMatch(
    dtoSource,
    new RegExp(`^\\s*${forbiddenField}\\??\\s*:`, "m"),
    `${forbiddenField} must not cross the account-management IPC contract`,
  );
}

// Token blindness: the overview projects status and the link, computed in
// main for every provider; the renderer never sees a token, a directory, or
// the Keychain.
const piAuth = read("src/main/orchestration/pi-subscription-auth.ts");
assert.match(piAuth, /\.\.\.\(cliProfileId \? \{ cliProfileId \} : \{\}\)/);
assert.match(piAuth, /\.\.\.\(cliProfileId === "personal" \? \{ builtIn: true as const \} : \{\}\)/);
assert.match(piAuth, /\.\.\.\(terminal \? \{ terminal \} : \{\}\)/);
assert.match(piAuth, /terminalStatusesByProvider\(\)/);
assert.match(piAuth, /terminals\.get\(profile\.provider\)\?\.get\(cliProfileId\)/);
assert.match(piAuth, /profile\.accountEmail \?\? status\?\.accountEmail/);
assert.match(piAuth, /\.\.\.\(email \? \{ email \} : \{\}\)/);
for (const source of [settings, card, cards]) {
  assert.doesNotMatch(source, /accessToken|refreshToken|CLAUDE_CONFIG_DIR|CODEX_HOME|GROK_HOME|\.credentials\.json|Keychain/);
}

assert.match(settings, /function accountCardShowsUsage/);
assert.match(usageUi, /connected && usage\.windows\.length === 0 && !usage\.limitReached/);
assert.doesNotMatch(
  usageUi,
  /This provider reported no usage windows\./,
  "providers with no quota API must not render a red empty-windows error",
);

console.log(
  "PASS one account per card for every provider with one Use, one Share, one Delete through the unified Pi channels; one sign-in in the Add picker; no pop-in, system-browser sign-in, portalled menus, and a token-blind IPC contract",
);
