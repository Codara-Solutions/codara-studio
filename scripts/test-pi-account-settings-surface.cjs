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
const usageUi = read("src/renderer/src/components/SubscriptionUsage.tsx");

const channels = [
  "pi-subscriptions:add-account",
  "pi-subscriptions:reconnect-account",
  "pi-subscriptions:rename-account",
  "pi-subscriptions:make-default",
  "pi-subscriptions:delete-account",
];
for (const channel of channels) {
  assert.ok(ipc.includes(`handle(\n    "${channel}"`) || ipc.includes(`handle("${channel}"`),
    `${channel} must be registered through the trusted IPC wrapper`);
  assert.ok(preload.includes(`ipcRenderer.invoke("${channel}"`),
    `${channel} must be exposed by preload`);
}

for (const compatibilityChannel of [
  "pi-subscriptions:connect",
  "pi-subscriptions:disconnect",
]) {
  assert.ok(ipc.includes(`handle("${compatibilityChannel}"`));
  assert.ok(preload.includes(`ipcRenderer.invoke("${compatibilityChannel}"`));
}

assert.match(ipc, /isPiSubscriptionProvider\(value\)/);
assert.doesNotMatch(
  ipc,
  /value === "anthropic" \|\| value === "openai-codex"/,
);
assert.match(ipc, /startPiSubscriptionProfileLogin/);
assert.match(ipc, /renamePiAccountProfile/);
assert.match(ipc, /setDefaultPiAccountProfile/);
assert.match(ipc, /deletePiSubscriptionProfile/);
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
]) {
  assert.ok(preload.includes(api), `${api} renderer API must exist`);
}

// One top-level "Add account" button opens the branded family picker; choosing
// a family then names both isolated destinations in plain language.
for (const action of [
  "Add account",
  "Connect to Cora",
  "Rename",
  // Switching the active account is the same stored default underneath; the
  // surface has to say so in the language of one-login-at-a-time providers.
  "Use this account",
  "Delete",
]) {
  assert.ok(cards.includes(action), `${action} action must render`);
}
assert.ok(
  cards.includes("Using"),
  "the account Cora or the CLI is running on must be marked Using",
);
assert.match(cards, /export function AccountAddPicker\(/);
assert.match(settings, /<AccountAddPicker providers=\{providerViews\} actions=\{accountActions\} \/>/);
assert.equal(
  (cards.match(/\n\s*Add account\n/g) ?? []).length,
  1,
  "the Accounts UI must render one global Add account trigger",
);
assert.match(cards, /aria-haspopup="menu"/);
assert.match(cards, /aria-haspopup="dialog"/);
assert.match(cards, /role="menuitem"/);
assert.match(cards, /role="listbox"/);
assert.match(cards, /role="option"/);
// The picker rides the shared .spark-menu surface and its large branded rows
// use the flexible menu-item primitive rather than fixed-height buttons.
assert.match(cards, /className="spark-menu"/);
assert.match(cards, /className="spark-menu-item"/);
assert.doesNotMatch(cards, /role="menuitem"\s+className="spark-btn"/);
// Each card has two independently switchable roles. Use-for-Cora and
// use-for-CLI are always named, never a combined "Use this account". Rename,
// reconnect, sign out, and delete wait behind the "···" menu.
assert.match(cards, /function AccountRoleRow\(/);
assert.match(cards, /<CodaraMark size=\{13\} \/>/);
assert.match(read("src/renderer/src/components/BrandMarks.tsx"), /export function CodaraMark/);
assert.match(cards, /Use this account for Cora/);
assert.match(cards, /Use this account for \$\{cliLabel\}/);
assert.match(cards, /function CardOverflowMenu\(/);
assert.match(cards, /More actions for \$\{card\.label\}/);
assert.match(cards, /onCliConnect/);
// The destructive block (Sign out, Delete) sits in its own bottom menu group,
// and Delete keeps its two-step arming inside the menu: the first click arms
// ("Confirm delete") and returns false so the menu stays open.
assert.match(cards, /groups=\{\[menuActions, destructiveActions\]\}/);
assert.match(cards, /if \(action\.run\(\) === false\) return;/);
assert.match(cards, /setDeleteArmed\("cora"\);\s*return false;/);
assert.match(cards, /setDeleteArmed\("cli"\);\s*return false;/);
assert.ok(cards.includes("Confirm delete"));
// Closing the menu in any way disarms a half-armed delete.
assert.match(cards, /onClose=\{\(\) => setDeleteArmed\(null\)\}/);
// Selection wash follows the agent brand, not the workspace accent, so a
// Claude card stays orange in a teal project.
assert.match(cards, /agentBrandColor\(runtime\)/);
assert.doesNotMatch(cards, /background: active\s*\? "var\(--accent-soft\)"/);
// Each card says which login it is, and a CLI-only card says why it shows no
// usage bars rather than showing none. Nothing is fetched for that card: Codara
// must never use the command-line tool's credential to ask about limits.
assert.match(cards, /\{card\.email\}/);
assert.match(cards, /email\?: string;/);
assert.ok(
  cards.includes(
    "Usage limits show once this account is connected to Cora — they cover everything the account does, including the terminal.",
  ),
  "a CLI-only card must explain the missing usage bars in plain language",
);
assert.match(cards, /const cliOnly = Boolean\(cli && !cora\);/);
// A CLI-only card offers connecting that account to Cora as its lead action.
assert.match(cards, /actions\.onCoraConnect\(card\)/);
// Every card can be renamed — CLI sign-ins without a native name field get a
// Codara-side display name through the same Rename affordance.
assert.match(cards, /onCliRename/);
assert.ok(cards.includes("Connect to Cora"));
assert.ok(cards.includes("Use it for Cora chats, workers, and automations."));
assert.ok(cards.includes("Sign in to {selectedView.cliLabel}"));
assert.ok(cards.includes("Use it when you run {selectedView.cliLabel} in a terminal."));
assert.match(cards, /actions\.onBeginAddCora\(selectedView\.provider\)/);
assert.match(cards, /actions\.onBeginAddCli\(selectedView\.provider\)/);
// Claude, Codex, and Grok are derived from the family registry and rendered
// with their real brand marks rather than duplicated labels or image assets.
assert.match(cards, /familyForRuntime\(runtime\)/);
assert.match(cards, /\{family\.displayName\}/);
assert.match(cards, /<RuntimeMark runtime=\{runtime\} size=\{20\} \/>/);
assert.match(cards, /\{view\.label\} · Cora or \{view\.cliLabel\}/);
// The old per-provider and side-by-side add buttons are gone.
assert.doesNotMatch(cards, /Add an account for Cora/);
assert.doesNotMatch(cards, /Add a \{view\.cliLabel\} account/);
const providerGroupSource = cards.slice(
  cards.indexOf("function AccountProviderGroup("),
  cards.indexOf("export default function AccountCards("),
);
assert.doesNotMatch(providerGroupSource, /Add account/);
// Plain language: no configuration vocabulary anywhere the user can read it.
for (const jargon of ["OAuth", "credential", "profile\"", "managed account"]) {
  assert.equal(
    cards.includes(`>${jargon}`),
    false,
    `${jargon} must not appear in visible account copy`,
  );
}
// A Cora-only card beside an unmatched CLI sign-in offers the one thing that
// would merge them.
assert.match(cards, /card\.pairHint/);
// The merged Accounts section keeps every Pi account action wired to the same
// handlers, and the accent edge still marks only the active card.
assert.match(settings, /title="Accounts"/);
assert.match(settings, /overview\?\.profiles/);
assert.match(settings, /onCoraReconnect:/);
assert.match(settings, /onCoraRename:/);
assert.match(settings, /onCoraUse:/);
assert.match(settings, /onCoraDelete:/);
assert.match(settings, /onCliConnect:/);
assert.match(settings, /reuse its empty named slot/);
assert.match(settings, /removeProfileOnFailure: true/);
assert.match(settings, /activateOnSuccess: true/);
assert.match(settings, /active: profile\.isDefault/);
assert.match(cards, /inset 2px 0 0 \$\{brand\}/);
assert.match(settings, /connected: profile\.connected/);
assert.match(settings, /expired: profile\.expired/);

// A Cora account and a CLI sign-in for the same human render as one card. The
// match is made on an anonymous sha256 of the vendor account id computed in the
// main process; the id, the email, and the auth path stay there.
const piAuth = read("src/main/orchestration/pi-subscription-auth.ts");
const piStore = read("src/main/orchestration/pi-account-auth-store.ts");
assert.match(
  piAuth,
  /profile\.identityFingerprint \?\? status\?\.accountFingerprint/,
  "the overview must project the stored digest, backfilled from the stored credential",
);
assert.match(piAuth, /\.\.\.\(accountFingerprint \? \{ accountFingerprint \} : \{\}\)/);
// The address is projected the same way: the registry value captured at connect
// time, backfilled from the stored credential's own claims for Codex.
assert.match(piAuth, /profile\.accountEmail \?\? status\?\.accountEmail/);
assert.match(piAuth, /\.\.\.\(email \? \{ email \} : \{\}\)/);
assert.match(piStore, /jwtEmailClaim\(credential\.access\)/);
assert.match(piStore, /if \(provider === "openai-codex"\)/);
assert.match(piStore, /if \(provider === "xai"\)/);
assert.match(piStore, /createHash\("sha256"\)\.update\(accountId\)\.digest\("hex"\)/);
assert.match(shared, /accountFingerprint\?: string;/);
assert.match(settings, /Identity pairing/);
assert.match(settings, /cliByFingerprint/);
// Email fallback pairing: when a fingerprint verdict is impossible (a Cora
// connection from before Codara captured account ids), a case-insensitive
// email match inside the same provider group merges the two sign-ins into one
// card. The fingerprint always wins — two differing digests are two accounts
// no matter what the addresses say — and the map is built inside the
// per-provider loop, so an email can never match across providers.
assert.match(settings, /const cliByEmail = new Map<string, NativeCliAccountProfile>\(\);/);
assert.match(settings, /profile\.email\?\.trim\(\)\.toLowerCase\(\)/);
assert.match(settings, /const candidate = byFingerprint \?\? byEmail;/);
assert.match(
  settings,
  /!profile\.accountFingerprint \|\| !byEmailCandidate\.accountFingerprint/,
  "an email match must never override two differing fingerprints",
);
assert.match(settings, /an email never matches across providers/);
// The email-merged card says how to make the hint proof.
assert.match(
  settings,
  /Same email address — reconnect to Cora to fully pair these sign-ins\./,
);
// Unmatched accounts still get their own card and clear copy explaining why.
assert.match(settings, /filter\(\(profile\) => !pairedCliIds\.has\(profile\.id\)\)/);
assert.match(
  settings,
  /profile\.managed \|\| profile\.status === "connected"/,
  "an unsigned built-in CLI slot must not render as its own account card",
);
assert.match(settings, /unsigned built-in CLI slot is not an account/);
assert.match(settings, /Only a \*signed-in\* unmatched CLI can merge/);

assert.match(settings, /function accountCardShowsUsage/);
assert.match(usageUi, /connected && usage\.windows\.length === 0 && !usage\.limitReached/);
assert.doesNotMatch(
  usageUi,
  /This provider reported no usage windows\./,
  "providers with no quota API must not render a red empty-windows error",
);

const connectionDtoStart = shared.indexOf(
  "export interface PiSubscriptionProfileConnection",
);
const connectionDtoEnd = shared.indexOf(
  "export interface PiSubscriptionAddAccountInput",
  connectionDtoStart,
);
assert.ok(connectionDtoStart >= 0 && connectionDtoEnd > connectionDtoStart);
const connectionDto = shared.slice(connectionDtoStart, connectionDtoEnd);
assert.match(connectionDto, /^\s*accountFingerprint\?: string;/m);
// The account's own address is allowed on this row — it is what tells two
// similarly named cards apart — while the vendor ids behind it are not.
assert.match(connectionDto, /^\s*email\?: string;/m);
for (const forbiddenField of [
  "accessToken",
  "refreshToken",
  "accountId",
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

// The Accounts panel lives inside the Settings dialog's `overflow: auto`
// content pane, so any popover authored as position:absolute in this file gets
// clipped at the pane edge — the card menus reached left of their narrow
// triggers, painted nothing over the nav column, and their clicks landed ON
// the nav. Both the "···" menu and the Add-account chooser must therefore
// render through the portalled AnchoredMenu primitive (fixed positioning at
// <body>), dropping below their trigger, right-aligned to it, above the
// dialog's z 100.
const anchored = read(
  "src/renderer/src/components/chat/composer/AnchoredMenu.tsx",
);
assert.match(cards, /import AnchoredMenu from "\.\/chat\/composer\/AnchoredMenu"/);
assert.equal(
  (cards.match(/<AnchoredMenu\b/g) ?? []).length,
  2,
  "both account menus must render through AnchoredMenu",
);
assert.equal((cards.match(/placement="below"/g) ?? []).length, 2);
assert.equal((cards.match(/align="end"/g) ?? []).length, 2);
assert.equal((cards.match(/zIndex=\{SETTINGS_MENU_Z\}/g) ?? []).length, 2);
assert.match(cards, /const SETTINGS_MENU_Z = 120/);
assert.doesNotMatch(
  cards,
  /position:\s*"absolute"/,
  "no absolutely positioned popover may come back to AccountCards — the Settings scroll pane clips it",
);
// The primitive itself must still portal and support the dropdown mode the
// account menus rely on.
assert.match(anchored, /createPortal\(/);
assert.match(anchored, /document\.body,?\s*\)/);
assert.match(anchored, /placement\?: "above" \| "below"/);
assert.match(anchored, /align\?: "start" \| "end"/);

// Single-open coordination lives in the primitive: opening any AnchoredMenu
// deterministically closes whichever one was open before, via a module-level
// registry — NOT via click-outside, which the Settings dialog surface defeats
// by calling stopPropagation on mousedown (that is exactly how two account
// menus ended up on screen at once). The outside-click listener itself must be
// capture-phase for the same reason, or clicks inside the dialog never close a
// menu at all.
assert.match(anchored, /let activeMenu: \{ id: symbol; close: \(\) => void \} \| null = null;/);
assert.match(anchored, /if \(activeMenu !== null && activeMenu\.id !== id\) activeMenu\.close\(\);/);
assert.match(anchored, /if \(activeMenu\?\.id === id\) activeMenu = null;/);
assert.match(anchored, /addEventListener\("mousedown", onPointerDown, true\)/);
assert.match(anchored, /removeEventListener\("mousedown", onPointerDown, true\)/);

// The "···" trigger is anchored at the card's top-right, in the header row
// — never on a role row. Use-for-Cora and use-for-CLI live on those rows, so
// a card with both sides already Using still has its menu.
const overflowIndex = cards.indexOf("<CardOverflowMenu");
const roleRowIndex = cards.indexOf("<AccountRoleRow");
assert.ok(overflowIndex >= 0 && roleRowIndex >= 0);
assert.ok(
  overflowIndex < roleRowIndex,
  "the overflow menu must render in the card header, before the Cora / CLI role rows",
);
assert.equal(
  (cards.match(/<CardOverflowMenu/g) ?? []).length,
  1,
  "the overflow menu renders once, in the header",
);
assert.equal(
  (cards.match(/<AccountRoleRow/g) ?? []).length,
  2,
  "each card has one Cora row and one CLI row",
);
assert.doesNotMatch(
  cards,
  /visibleActions\.length > 0/,
  "use actions live on the role rows, not a leftover action ladder",
);

console.log(
  "PASS Pi multi-account Settings, one branded top-level account picker, sanitized IPC that carries only an anonymous account fingerprint and the account's own email, one card per paired account, the CLI-only usage explanation, the live-run deletion guard, and portalled unclipped account menus",
);
