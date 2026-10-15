const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (relativePath) =>
  fs.readFileSync(path.join(ROOT, relativePath), "utf8").replace(/\r\n/g, "\n");

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
  "pi-subscriptions:resume-login",
  "pi-subscriptions:usage",
  "pi-subscriptions:codex-reset",
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
assert.match(ipc, /unifiedAccountsFor\(provider\)\.useAccount\(profileId\);/);
assert.match(ipc, /unifiedAccountsFor\(target\.provider\)\.deleteAccount\(profileId, \{/);
// Switching never closes sessions, so the renderer's closeSessions flag is ignored.
assert.doesNotMatch(ipc, /closeSessions: input\?\.closeSessions === true/);
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
assert.match(descriptors, /brand: "claude" \| "codex" \| "grok";/);
assert.match(descriptors, /claude: \{ cliLabel: "Claude Code", systemHome: "~\/\.claude", runningSessionsSwitch: true \}/);
assert.match(descriptors, /codex: \{ cliLabel: "Codex", systemHome: "~\/\.codex", runningSessionsSwitch: false \}/);
assert.match(descriptors, /grok: \{ cliLabel: "Grok", systemHome: "~\/\.grok", runningSessionsSwitch: false \}/);
assert.equal(
  (descriptors.match(/runningSessionsSwitch: true/g) ?? []).length,
  1,
  "only Claude Code picks a switch up in running sessions",
);
// Nothing closes sessions or copies a login command any more.
assert.doesNotMatch(descriptors, /switchClosesSessions|sessionsFollowLiveLogin|loginHint/);
assert.match(descriptors, /export function accountProviderDetail\(/);
// Hot swap (accounts spec 18): Claude Code sessions switch on their next
// request, Codex and Grok only for new sessions, and the System login only
// ever for new sessions.
// The rule is said once, in the switching explainer, never again under
// each provider's name.
assert.doesNotMatch(descriptors, /accountProviderSummary/);
assert.ok(descriptors.includes("`Running ${cliLabel} sessions switch on their next request.`"));
assert.ok(descriptors.includes("`New ${cliLabel} sessions use the new account. Running ones keep theirs.`"));
assert.ok(
  descriptors.includes(
    "`${running} Switching to or from your own ${cliLabel} login applies to new sessions.`",
  ),
);
assert.ok(descriptors.includes("return `Your ${descriptor.cliLabel} login`;"));

// ---------------------------------------------------------------------------
// One card model for every provider. The main process pairs the Cora row
// with its terminal half; the renderer keys cards by id and matches nothing.
assert.match(settings, /return ACCOUNT_PROVIDER_DESCRIPTORS\.map\(\(descriptor\) => \{/);
assert.match(settings, /detail: accountProviderDetail\(descriptor\),/);
assert.match(settings, /key: `\$\{provider\}:\$\{profile\.id\}`/);
assert.match(settings, /key: `\$\{provider\}:cli:\$\{profile\.id\}`/);
assert.match(settings, /profile\.managed && !linked\.has\(profile\.id\)/);
assert.match(settings, /builtIn: profile\.builtIn === true/);
assert.match(settings, /active: profile\.isDefault/);
assert.match(settings, /connected: profile\.connected/);
assert.match(settings, /expired: profile\.expired/);
assert.match(settings, /canRefresh: profile\.canRefresh/);
assert.match(settings, /\.\.\.\(profile\.terminal \? \{ terminal: profile\.terminal \} : \{\}\)/);
// No card is drawn without a row: the System login is a row the user added
// or a one-line offer, never a pseudo-card.
assert.doesNotMatch(settings, /account-one|accountOneSlot|"Account 1"/);
assert.match(
  settings,
  /const cards = stableAccountCardKeys\(\[\.\.\.rows, \.\.\.terminalOnly\], cardKeysRef\.current\);/,
);
assert.match(settings, /const systemOffer = overview\?\.systemOffers\?\.\[provider\];/);
assert.match(settings, /canUseSystemLogin: anyActive && !systemRow,/);
// No provider branch, no renderer-side pairing, no second card shape.
const accountsSection = settings.slice(
  settings.indexOf("function AccountsSettings("),
  settings.indexOf("function AgentsSettings("),
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
// The footer applies one rule to every provider: an account is ready when
// its row would offer Switch or show Active, so "2 of 4 ready" always agrees
// with the rows. A row whose Cora half reports an error offers a fix
// instead, so it is not ready. It is omitted when there are none.
assert.match(settings, /const ready = cards\.filter\(accountCardReady\)\.length;/);
assert.match(
  card,
  /export function accountCardReady\(card: AccountCardView\): boolean \{\s*const state = accountCardState\(card\);\s*if \(state === "system"\) return terminalUsable\(card\);\s*return \(state === "active" \|\| state === "signed-in"\) && !card\.cora\?\.error;/,
);
assert.match(settings, /const footer = cards\.length === 0 \? null : `\$\{ready\} of \$\{cards\.length\} ready`;/);
assert.match(settings, /\.\.\.\(footer \? \{ footer \} : \{\}\)/);
// The switching explainer says what one account is.
assert.ok(
  settings.includes(
    "Every account is one sign-in for Cora and its terminal tool. The Active account is used by new Codara terminals and new Cora chats.",
  ),
);
// The section's own detail (accounts spec 13). The page subtitle already
// says what the page is, so the detail lives in the switching explainer.
assert.ok(
  settings.includes(
    "Sign-ins for Cora and for the Claude Code, Codex and Grok terminals that Codara opens. They stay inside Codara. Your own logins and settings, and every terminal outside Codara, are never changed.",
  ),
);
assert.doesNotMatch(settings, /closes that tool's running sessions first/);

// One Use, one Reconnect, one Share, one Rename, one Delete, all through
// the Pi account channels, the provider taken from the card. The terminal
// id only reaches the native store for a half that has no row. Nothing
// closes sessions, so nothing counts them or asks again.
assert.match(settings, /onUse: \(card\) => \{/);
assert.match(settings, /void makeDefault\(card\.provider, card\.coraProfileId\)/);
assert.match(settings, /piSubscriptions\.makeDefault\(\{ provider, profileId \}\)/);
assert.match(settings, /reconnectAccount\(card\.provider, card\.coraProfileId, card\.label\)/);
assert.match(settings, /piSubscriptions\.shareLogin\(\{ coraProfileId \}\)/);
assert.match(settings, /piSubscriptions\.shareLogin\(\{\s*cliProfileId,\s*provider: card\.provider,\s*\}\)/);
assert.match(settings, /void deleteAccount\(card\.coraProfileId\)/);
assert.match(settings, /piSubscriptions\.deleteAccount\(\{ profileId \}\)/);
assert.match(settings, /nativeCliAccounts\.rename\(\{\s*runtime: runtimeForSubscription\(card\.provider\),/);
assert.match(settings, /nativeCliAccounts\.delete\(\{\s*runtime: runtimeForSubscription\(card\.provider\),/);
assert.doesNotMatch(settings, /runtime: "claude"/);
assert.doesNotMatch(
  settings,
  /closeSessions|liveTerminalCount|refusedWithSessions|setCloseSessionsPrompt|switchSessionCounts|liveSessions/,
);
// The System login: add it as a row, hide its offer, or point new sessions
// back at it. Each goes through its own preload call and nothing else.
assert.match(settings, /piSubscriptions\.addSystemAccount\(provider\)/);
assert.match(settings, /piSubscriptions\.dismissSystemOffer\(provider\)/);
assert.match(settings, /piSubscriptions\.useSystemLogin\(provider\)/);
for (const [api, channel] of [
  ["useSystemLogin:", "pi-subscriptions:use-system-login"],
  ["addSystemAccount:", "pi-subscriptions:add-system-account"],
  ["dismissSystemOffer:", "pi-subscriptions:dismiss-system-offer"],
]) {
  assert.ok(preload.includes(api), `${api} renderer API must exist`);
  assert.ok(preload.includes(`ipcRenderer.invoke("${channel}", { provider })`), `${channel} must be exposed`);
  assert.ok(ipc.includes(`"${channel}"`), `${channel} must be handled`);
}
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
  '"system"',
]) {
  assert.ok(card.includes(`| ${state}`), `${state} must be a card state`);
}
assert.doesNotMatch(card, /account-one|loginHint|copyLogin|onCopyCommand|Copy sign-in command/);
assert.match(card, /if \(card\.builtIn\) return "system";/);
assert.match(card, /if \(!card\.coraProfileId\) return "terminal-only";/);
assert.match(card, /if \(!coraUsable\(card\)\) return "needs-reconnect";/);
assert.match(card, /if \(!card\.cliProfileId\) return "cora-only";/);
assert.match(card, /return card\.active \? "active" : "signed-in";/);
// A refreshable lapse is not an expiry; a row with no Cora grant is not usable.
assert.match(card, /!\(card\.cora\?\.expired && !card\.cora\.canRefresh\)/);
assert.match(card, /card\.cora\?\.held !== false/);
assert.ok(card.includes('text: "Refreshing the sign-in."'));
assert.match(card, /descriptor: AccountProviderDescriptor;/);
assert.match(card, /const brand = agentBrandColor\(descriptor\.brand\);/);
// Provider words live in the descriptor, never in a string the card renders.
assert.doesNotMatch(card, /agentBrandColor\("claude"\)|["`][^"`\n]*(?:Claude Code|Codex|Grok|claude login)/);
for (const label of [
  '"Switch to this account"',
  'label: "Reconnect"',
  "label: `Share with ${descriptor.cliLabel}`",
  'label: "Share with Cora"',
  'label: "Rename"',
  '"Remove from Codara"',
  '"Remove"',
  "Connect Cora",
]) {
  assert.ok(card.includes(label), `${label} must render`);
}
// Accounts spec 13 copy, word for word.
for (const copy of [
  '"Signed in"',
  '"Cora connected"',
  '"Cora isn\'t connected."',
  "`${cliLabel} on this computer is signed out.`",
  '"Sign-in expired."',
  "`Remove \"${card.label}\" from Codara? Your ${cliLabel} login stays as it is. Codara stops offering it.`",
  "`Remove \"${card.label}\"? Codara deletes this sign-in from its own folder. Your ${cliLabel} login outside Codara is not affected. This can't be undone; to use it again, add it again.`",
  "`Signed in to Cora only. Share it so ${cliLabel} can use it too.`",
  "`${cliLabel} cannot use this profile's folder. Remove it and add the account again.`",
  "`Not signed in to ${cliLabel}. Remove it and add the account again.`",
  "`Signed in to ${cliLabel} only. Share it so Cora can use it too.`",
  "`Signed in. The ${cliLabel} copy is catching up.`",
]) {
  assert.ok(card.includes(copy), `${copy} must be the card's copy`);
}
assert.match(card, /<span className="st-acct-badge">\{systemLoginBadge\(descriptor\)\}<\/span>/);
assert.match(card, /\{card\.active \? <ActiveBadge label="Active" \/> : null\}/);
// Active shows the badge and no Use button; any errored row offers
// Reconnect, never Switch. A System row never reconnects its own login:
// Connect Cora gives Cora a grant of its own.
assert.match(card, /case "active":\s*case "needs-reconnect":\s*return undefined;/);
assert.match(card, /if \(status\.danger && card\.coraProfileId && state !== "system" && state !== "terminal-only"\) \{/);
assert.match(card, /title=\{action\.title\}/);
// Every row keeps the menu's slot, so the buttons end on one edge.
assert.match(card, /<span aria-hidden className="st-acct__menu-slot" \/>/);
// Every row action is the same secondary button; the Active badge is the
// only accent in the list.
assert.doesNotMatch(card, /<ActionButton[^>]*\bprimary\b/);
assert.match(card, /onUse: \(card: AccountCardView\) => void;/);
assert.match(card, /onDelete: \(card: AccountCardView\) => void;/);
// Remove always asks once, in the row, with the sentence that says what
// goes and what stays; nothing is deleted from the menu click itself.
assert.match(card, /<RemoveConfirm\s+text=\{removeConfirmText\(card, descriptor\)\}/);
assert.match(card, /onConfirm=\{\(\) => \{\s*setConfirmingRemove\(false\);\s*actions\.onDelete\(card\);/);
assert.match(primitives, /export function RemoveConfirm\(/);
assert.match(primitives, /role="alertdialog"/);
assert.doesNotMatch(card, /closeSessions|deleteArmed|Confirm delete|Confirm forget|Forget this account/);
assert.doesNotMatch(card, /if \(renameable && !card\.builtIn\) \{/);
// ...and the handler must carry the remove through for a System row too.
assert.doesNotMatch(settings, /if \(card\.builtIn\) return;/);
assert.match(
  settings,
  /onDelete: \(card\) => \{[\s\S]{0,400}?if \(card\.coraProfileId\) \{\s*void deleteAccount\(card\.coraProfileId\);/,
);
assert.equal((card.match(/<CardOverflowMenu/g) ?? []).length, 1);
assert.doesNotMatch(card, /nativeCliAccounts|piSubscriptions/);
// The active row is marked by the row itself as well as the badge.
assert.match(card, /className=\{`st-acct\$\{card\.active \? " is-active" : ""\}/);
assert.match(card, /\{card\.email\}/);
// A row without an email still says why, instead of leaving a blank line.
assert.match(card, /<span className="st-acct__email is-missing">Email not reported<\/span>/);
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
    "`Sign in in your browser. Codara keeps this account in its own folder and never touches ${selectedView.descriptor.systemHome}.`",
  ),
);
// The System login offer line and the way back to it (accounts spec 5.2, 13).
assert.ok(cards.includes("`${cliLabel} on this computer is signed in as ${offer.email}.`"));
assert.match(cards, />\s*Use in Codara\s*</);
assert.match(cards, />\s*Dismiss\s*</);
assert.match(cards, /actions\.onAddSystemAccount\(descriptor\.provider\)/);
assert.match(cards, /actions\.onDismissSystemOffer\(descriptor\.provider\)/);
assert.match(cards, /actions\.onUseSystemLogin\(descriptor\.provider\)/);
assert.match(cards, /Use your \{descriptor\.cliLabel\} login/);
assert.match(cards, /MCP servers that need a sign-in must be connected once in each Codara account\./);
assert.match(cards, />\s*Sign in\s*<\/button>/);
assert.match(cards, /actions\.onAdd\(selectedView\.descriptor\.provider\);/);
assert.match(cards, /\{label\} · Cora and \{cliLabel\}/);
assert.equal(
  (cards.match(/\n\s*Add account\n/g) ?? []).length,
  1,
  "the Accounts UI must render one global Add account trigger",
);
// The provider group renders the one card for every provider.
assert.match(cards, /\{view\.cards\.map\(\(card, position\) => \(\s*<AccountCard\s+key=\{card\.key\}\s+card=\{card\}\s+descriptor=\{descriptor\}/);
assert.match(cards, /export interface AccountActions extends AccountCardActions \{/);
assert.match(settings, /const accountActions: AccountActions = \{/);
assert.match(settings, /onBeginAdd: \(provider\) => \{/);
assert.match(settings, /onAdd: \(provider\) => addAccount\(provider, addLabel\)/);
assert.match(settings, /piSubscriptions\.addAccount\(\{/);
assert.match(settings, /piSubscriptions\.reconnectAccount\(\{ provider, profileId \}\)/);

// The retired sign-in and switch surfaces are gone from preload and the
// shared contract; main still refuses them for any caller.
const preloadStart = preload.indexOf("nativeCliAccounts: {");
const preloadEnd = preload.indexOf("\n  piSubscriptions:", preloadStart);
assert.ok(preloadStart >= 0 && preloadEnd > preloadStart);
const preloadAccountApi = preload.slice(preloadStart, preloadEnd);
for (const gone of [
  "create:",
  "setDefault:",
  "prepareLogin:",
  "cancelLogin:",
  "logout:",
  "onLoginError:",
  "native-cli-accounts:login-error",
]) {
  assert.equal(preloadAccountApi.includes(gone), false, `${gone} must not be exposed by preload`);
}
for (const kept of ["inspect:", "rename:", "delete:", "onChanged:"]) {
  assert.ok(preloadAccountApi.includes(kept), `${kept} must stay exposed for terminal-only halves`);
}
assert.doesNotMatch(shared, /NativeCliAccountLoginInput|NativeCliAccountLoginPreparation|NativeCliAccountCancelLoginInput/);
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
assert.match(piAuth, /\.\.\.\(cliProfileId === SYSTEM_CLI_PROFILE_ID \? \{ builtIn: true as const \} : \{\}\)/);
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

// An empty provider group starts its sign-in in one click, through the same
// entry point as the Add picker, and never while another login runs.
assert.match(
  cards,
  /No \{descriptor\.label\} account yet\.<\/span>[\s\S]*?<ActionButton[\s\S]*?disabled=\{view\.disabled \|\| view\.busy\}\s*onClick=\{\(\) => actions\.onAdd\(descriptor\.provider\)\}\s*>\s*Sign in to \{descriptor\.label\}/,
);
assert.match(settings, /const busy = busyProvider !== null \|\| accountMutationId !== null;/);

console.log(
  "PASS one account per card for every provider with one Use, one Share, one Delete through the unified Pi channels; one sign-in in the Add picker; no pop-in, system-browser sign-in, portalled menus, and a token-blind IPC contract",
);
