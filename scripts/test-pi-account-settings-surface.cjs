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
const anthropicCard = read("src/renderer/src/components/AnthropicAccountCard.tsx");
const primitives = read("src/renderer/src/components/AccountCardPrimitives.tsx");
const usageUi = read("src/renderer/src/components/SubscriptionUsage.tsx");
const usageMeters = read("src/renderer/src/components/UsageMeters.tsx");

// The account channel set. Every one is registered through the trusted IPC
// wrapper and exposed by preload; share-login is the one addition of the
// unified Anthropic model.
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
// One Anthropic account, one card. The main process pairs the Cora row with
// its Claude Code half; the renderer keys cards by id and matches nothing.
assert.match(settings, /if \(descriptor\.provider === "anthropic"\) \{/);
assert.match(settings, /key: `anthropic:\$\{profile\.id\}`/);
assert.match(settings, /key: `anthropic:cli:\$\{profile\.id\}`/);
assert.match(settings, /key: "anthropic:account-one"/);
assert.match(settings, /profile\.managed && !linked\.has\(profile\.id\)/);
assert.match(settings, /builtIn: profile\.builtIn === true/);
assert.match(settings, /active: profile\.isDefault/);
assert.match(settings, /connected: profile\.connected/);
assert.match(settings, /expired: profile\.expired/);
assert.match(settings, /canRefresh: profile\.canRefresh/);
assert.match(settings, /\.\.\.\(profile\.terminal \? \{ terminal: profile\.terminal \} : \{\}\)/);
// Nothing in the Anthropic branch pairs on identity.
const anthropicBranchStart = settings.indexOf('if (descriptor.provider === "anthropic") {');
const anthropicBranchEnd = settings.indexOf("// Identity pairing:", anthropicBranchStart);
assert.ok(anthropicBranchStart >= 0 && anthropicBranchEnd > anthropicBranchStart);
const anthropicBranch = settings.slice(anthropicBranchStart, anthropicBranchEnd);
assert.doesNotMatch(anthropicBranch, /accountFingerprint|cliByEmail|cliByFingerprint|pairHint/);
assert.doesNotMatch(anthropicBranch, /nativeCliAccountLabels/);

// The section copy says what the unified account does.
assert.ok(
  settings.includes(
    "One sign-in per account. Switching an account moves Cora and Claude Code together. New terminals pick it up; running ones keep theirs. Account 1 is your own claude login.",
  ),
);
// The footer counts accounts, not the signed-out Account 1 instruction slot,
// and is omitted when there are none.
assert.match(settings, /card\.coraProfileId \|\| card\.terminal\?\.connected/);
assert.match(settings, /\.\.\.\(count > 0 \? \{ footer: `\$\{count\} \$\{count === 1 \? "account" : "accounts"\}` \} : \{\}\)/);
// The cards gate opens once the overview settled either way, so a failed
// status read still shows what the CLI side can build.
assert.match(settings, /\(overview !== null \|\| overviewSettled\) && \(cliInspection !== null \|\| cliError !== null\)/);
assert.match(settings, /setOverviewSettled\(true\)/);
// Every error class name is stripped before a message reaches the panel.
assert.match(settings, /\.replace\(\/\^\[A-Za-z\]\*Error:\\s\*\/, ""\)/);
// The armed Delete derives its count from the live overview after a refusal.
assert.match(settings, /profile\.terminal\?\.liveSessions \?\? 0/);
assert.match(settings, /setCloseSessionsPrompt\(null\);\n    void window\.spark\.piSubscriptions\n      \.status\(\)/);
// A dead-end terminal-only profile says what to do; Account 1 always carries its hint.
assert.ok(anthropicCard.includes("Not signed in to Claude Code. Delete it and add the account again."));
assert.ok(anthropicCard.includes("Claude Code cannot use this profile's folder. Delete it and add the account again."));
assert.match(anthropicCard, /terminalUsable\(card\)\n\s*\? "Found your claude login\. Cora is linking it now\."/);
assert.match(anthropicCard, /card\.cora\?\.error && state !== "account-one-signed-out"/);
// The Anthropic picker step is the sign-in, not a naming step.
assert.match(cards, /oneSignIn\(selectedView\)\n\s*\? `Sign in to \$\{selectedFamily\?\.displayName\}`/);

// One Use action switches both halves through the Pi make-default channel.
// Never nativeCliAccounts.setDefault for Claude.
assert.match(settings, /anthropic: \{/);
assert.match(settings, /void makeDefault\("anthropic", card\.coraProfileId\)/);
assert.match(settings, /reconnectAccount\("anthropic", card\.coraProfileId, card\.label\)/);
assert.match(settings, /piSubscriptions\.shareLogin\(\{ coraProfileId \}\)/);
assert.match(settings, /piSubscriptions\.shareLogin\(\{ cliProfileId \}\)/);
assert.match(settings, /void deleteAccount\(card\.coraProfileId, closeSessions\)/);
assert.match(settings, /\.\.\.\(closeSessions \? \{ closeSessions: true \} : \{\}\)/);
assert.match(settings, /nativeCliAccounts\.delete\(\{ runtime: "claude", profileId \}\)/);
assert.match(settings, /nativeCliAccounts\.rename\(\{\s*runtime: "claude",/);
assert.equal(
  (settings.match(/runtime: "claude"/g) ?? []).length,
  2,
  "the only Claude-runtime native calls are rename and delete of a terminal-only half",
);
// A refused delete carries the live terminal count; the card's next Delete
// offers to close them.
assert.match(settings, /function liveTerminalCount\(message: string\): number \| null/);
assert.match(settings, /terminal sessions\? \(\?:is\|are\) using this account/);
assert.match(settings, /setCloseSessionsPrompt\(\{ profileId, count \}\)/);
assert.match(settings, /\? closeSessionsPrompt\.count\n\s*: \(profile\.terminal\?\.liveSessions \?\? 0\)/);
assert.match(settings, /function ipcErrorMessage\(err: unknown\): string/);

// No pop-in: every store answers before any card shows.
assert.match(settings, /const accountsReady =/);
assert.match(
  settings,
  /\(overview !== null \|\| overviewSettled\) && \(cliInspection !== null \|\| cliError !== null\)/,
);
assert.doesNotMatch(settings, /loading \|\| cliLoading/);
assert.match(settings, /\{!accountsReady \? \(/);

// The login URL only ever reopens in the system browser: openExternal routes
// browser-ish URLs into the in-app browser, which cannot finish an OAuth
// callback.
assert.match(settings, /openInSystemBrowser\(login\.url!\)/);
assert.doesNotMatch(settings, /openExternal\(login\.url/);

// ---------------------------------------------------------------------------
// The card itself: six states, one primary action each, one overflow menu.
assert.match(anthropicCard, /export function anthropicAccountState\(/);
for (const state of [
  '"active"',
  '"signed-in"',
  '"needs-reconnect"',
  '"terminal-only"',
  '"cora-only"',
  '"account-one-signed-out"',
]) {
  assert.ok(anthropicCard.includes(`| ${state}`), `${state} must be a card state`);
}
assert.match(anthropicCard, /return card\.builtIn \? "account-one-signed-out" : "terminal-only";/);
assert.match(anthropicCard, /if \(card\.builtIn && !coraUsable\) return "account-one-signed-out";/);
assert.match(anthropicCard, /if \(!coraUsable\) return "needs-reconnect";/);
assert.match(anthropicCard, /if \(!card\.cliProfileId\) return "cora-only";/);
assert.match(anthropicCard, /return card\.active \? "active" : "signed-in";/);
// A refreshable lapse is not an expiry.
assert.match(anthropicCard, /!\(card\.cora\?\.expired && !card\.cora\.canRefresh\)/);
assert.ok(anthropicCard.includes('text: "Refreshing the Cora sign-in."'));
for (const label of [
  'label: "Use this account"',
  'label: "Reconnect"',
  'label: "Share with Claude Code"',
  'label: "Share with Cora"',
  'label: "Rename"',
  '"Confirm delete"',
  '"Delete"',
]) {
  assert.ok(anthropicCard.includes(label), `${label} must render`);
}
assert.ok(
  anthropicCard.includes(
    '"Run claude login in a terminal to use this account."',
  ),
);
assert.match(anthropicCard, /<UsingChip label="Using" color=\{brand\} \/>/);
// Active shows the badge and no Use button.
assert.match(anthropicCard, /case "active":\s*case "account-one-signed-out":\s*return undefined;/);
// Delete is two-step inside the menu; the second step closes the terminals
// main reported and resends with closeSessions.
assert.match(anthropicCard, /setDeleteArmed\(true\);\s*return false;/);
assert.match(
  anthropicCard,
  /`Close \$\{closeCount\} \$\{closeCount === 1 \? "session" : "sessions"\} and delete`/,
);
assert.match(anthropicCard, /actions\.onDelete\(card, \{ closeSessions: closeCount > 0 \}\)/);
assert.match(anthropicCard, /onClose=\{\(\) => setDeleteArmed\(false\)\}/);
// Account 1 is renameable but never deleted or reconnected from here.
assert.match(anthropicCard, /if \(renameable && !card\.builtIn\) \{/);
assert.equal((anthropicCard.match(/<CardOverflowMenu/g) ?? []).length, 1);
assert.doesNotMatch(anthropicCard, /AccountRoleRow|cliSwitchArmed|Confirm & close|Remove from Cora/);
assert.doesNotMatch(anthropicCard, /nativeCliAccounts|piSubscriptions/);
assert.match(anthropicCard, /agentBrandColor\("claude"\)/);
assert.match(anthropicCard, /inset 2px 0 0 \$\{brand\}/);
assert.match(anthropicCard, /\{card\.email\}/);
assert.match(anthropicCard, /\{card\.plan\} plan/);

// The Add-account picker has no destination step for Claude: one browser
// sign-in writes both halves.
assert.match(cards, /export function AccountAddPicker\(/);
assert.match(settings, /<AccountAddPicker providers=\{providerViews\} actions=\{accountActions\} \/>/);
assert.match(cards, /const oneSignIn = \(view: AccountProviderView\) => view\.provider === "anthropic";/);
assert.match(cards, /if \(oneSignIn\(view\)\) \{\s*setDestination\("cora"\);\s*actions\.onBeginAddCora\(view\.provider\);/);
assert.ok(cards.includes("Sign in once in your browser. Cora and Claude Code both use it."));
assert.match(cards, /oneSignIn\(selectedView\)\s*\? "Sign in"\s*: "Connect"/);
assert.equal(
  (cards.match(/\n\s*Add account\n/g) ?? []).length,
  1,
  "the Accounts UI must render one global Add account trigger",
);
// Codex and Grok keep their two destinations.
assert.ok(cards.includes("Connect to Cora"));
assert.ok(cards.includes("Sign in to {selectedView.cliLabel}"));
assert.match(cards, /actions\.onBeginAddCli\(selectedView\.provider\)/);
// The provider group dispatches Anthropic cards to the one-account card.
assert.match(cards, /\(view\.anthropicCards \?\? \[\]\)\.map\(\(card\) => \(\s*<AnthropicAccountCard/);
assert.match(cards, /actions=\{actions\.anthropic\}/);
assert.match(cards, /anthropic: AnthropicAccountActions;/);

// Plain language, no dashes, no configuration vocabulary in visible copy.
for (const [name, source] of [
  ["AnthropicAccountCard.tsx", anthropicCard],
  ["AccountCardPrimitives.tsx", primitives],
  ["AccountCards.tsx", cards],
]) {
  assert.doesNotMatch(source, /[\u2013\u2014]/, `${name} must not contain dashes`);
}
for (const jargon of ["OAuth", "credential", 'profile"', "managed account"]) {
  for (const source of [cards, anthropicCard]) {
    assert.equal(
      source.includes(`>${jargon}`),
      false,
      `${jargon} must not appear in visible account copy`,
    );
  }
}
const anthropicSection = settings.slice(
  settings.indexOf("function AccountsSettings()"),
  settings.indexOf("function AgentsSettings()"),
);
assert.doesNotMatch(anthropicSection, /[\u2013\u2014]/, "the Accounts section must not contain dashes");

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
assert.doesNotMatch(anthropicCard, /position:\s*"absolute"/);
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
// Wire contract. The Anthropic row carries the id of its Claude Code half
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
assert.match(shared, /closeSessions\?: boolean;/);

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
// main; the renderer never sees a token, a directory, or the Keychain.
const piAuth = read("src/main/orchestration/pi-subscription-auth.ts");
assert.match(piAuth, /\.\.\.\(cliProfileId \? \{ cliProfileId \} : \{\}\)/);
assert.match(piAuth, /\.\.\.\(cliProfileId === "personal" \? \{ builtIn: true as const \} : \{\}\)/);
assert.match(piAuth, /\.\.\.\(terminal \? \{ terminal \} : \{\}\)/);
assert.match(piAuth, /terminalStatusesByProvider\(\)/);
assert.match(piAuth, /terminals\.get\(profile\.provider\)\?\.get\(cliProfileId\)/);
assert.match(piAuth, /profile\.accountEmail \?\? status\?\.accountEmail/);
assert.match(piAuth, /\.\.\.\(email \? \{ email \} : \{\}\)/);
assert.doesNotMatch(settings, /accessToken|refreshToken|CLAUDE_CONFIG_DIR|\.credentials\.json|Keychain/);
assert.doesNotMatch(anthropicCard, /accessToken|refreshToken|CLAUDE_CONFIG_DIR|\.credentials\.json|Keychain/);

assert.match(settings, /function accountCardShowsUsage/);
assert.match(usageUi, /connected && usage\.windows\.length === 0 && !usage\.limitReached/);
assert.doesNotMatch(
  usageUi,
  /This provider reported no usage windows\./,
  "providers with no quota API must not render a red empty-windows error",
);

console.log(
  "PASS one Anthropic account per card with one Use, one Share, one Delete through the unified Pi channels; Codex and Grok keep their two-facet cards; no pop-in, system-browser sign-in, portalled menus, and a token-blind IPC contract",
);
