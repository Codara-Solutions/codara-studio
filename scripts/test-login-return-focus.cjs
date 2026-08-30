const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (relativePath) =>
  fs.readFileSync(path.join(ROOT, relativePath), "utf8");

const focus = read("src/main/window-focus.ts");
const background = read("src/main/e2e-background.ts");
const ipc = read("src/main/ipc.ts");
const subscriptionAuth = read("src/main/orchestration/pi-subscription-auth.ts");
const callbackPage = read("src/main/orchestration/pi-oauth-callback-page.ts");
const callbackServer = read("src/main/orchestration/pi-oauth-callback-server.ts");

// ---------------------------------------------------------------------------
// Returning to Studio after a browser sign-in
// ---------------------------------------------------------------------------

// The user is left in a browser at the end of every connect flow. Bringing the
// window back is the whole point, and on macOS a window-level focus alone will
// not raise a backgrounded app; the app-level steal has to be there too.
assert.match(focus, /export function focusStudioWindow\(owner\?: WebContents \| null\): void/);
assert.match(focus, /BrowserWindow\.getAllWindows\(\)/);
assert.match(focus, /BrowserWindow\.fromWebContents\(owner\)/);
assert.match(focus, /import \{ E2E_BACKGROUND, revealWindow \} from "\.\/e2e-background";/);
assert.match(focus, /revealWindow\(target\);/);
assert.match(background, /if \(target\.isMinimized\(\)\) target\.restore\(\);/);
assert.match(background, /if \(!target\.isVisible\(\)\) target\.show\(\);/);
assert.match(background, /target\.focus\(\);/);
assert.match(
  focus,
  /if \(process\.platform === "darwin" && !E2E_BACKGROUND\) app\.focus\(\{ steal: true \}\);/,
);

// Pi subscription connect: focus on success and on a real failure, never on a
// cancel the user issued from inside Studio (they are already looking at it).
assert.match(subscriptionAuth, /import \{ focusStudioWindow \} from "\.\.\/window-focus";/);
assert.match(subscriptionAuth, /focus: \(\) => focusStudioWindow\(owner\),/);
assert.match(
  subscriptionAuth,
  /type: "completed",[\s\S]{0,400}?owner\.focus\?\.\(\);/,
);
assert.match(subscriptionAuth, /if \(!cancelled\) owner\.focus\?\.\(\);/);
assert.doesNotMatch(
  subscriptionAuth,
  /type: "cancelled"[^\n]*\n\s*focusStudioWindow/,
);

// Managed CLI sign-ins no longer run in a Studio terminal: one browser
// sign-in through the account card writes both halves, so there is no login
// terminal to return from and pty:spawn refuses a login token outright.
assert.doesNotMatch(ipc, /launchPreparedLogin|isNativeCliLoginCancellation|native-cli-accounts:login-error/);
assert.match(
  ipc,
  /if \(args\?\.nativeCliLoginToken !== undefined\) \{\s*throw new NativeCliAccountError\("NATIVE_CLI_ACCOUNT_UNIFIED"\)/,
);

// ---------------------------------------------------------------------------
// The branded page the browser lands on
// ---------------------------------------------------------------------------

// Pi's own success page carries Pi's mark. Codara serves its own, so the last
// thing the user sees before coming back is Codara Studio.
assert.match(callbackPage, /<title>Codara Studio<\/title>/);
assert.match(callbackPage, /"Account connected"/);
assert.ok(
  callbackPage.includes(
    "You can close this tab and return to Codara Studio.",
  ),
);
assert.match(callbackPage, /export function codaraOAuthSuccessHtml\(\): string/);
assert.match(callbackPage, /export function codaraOAuthErrorHtml\(message: string\): string/);
// The page must render with no network at all: the mark is inlined, and the
// only styling is in the document.
assert.match(callbackPage, /data:image\/png;base64,\$\{bytes\.toString\("base64"\)\}/);
assert.doesNotMatch(callbackPage, /https?:\/\//);
// Light and dark are both real: the browser may be in either.
assert.match(callbackPage, /color-scheme: light dark/);
assert.match(callbackPage, /@media \(prefers-color-scheme: dark\)/);
// Nothing interpolated into the page escapes as markup.
assert.match(callbackPage, /function escapeHtml\(value: string\): string/);
assert.match(callbackPage, /escapeHtml\(heading\)/);
assert.match(callbackPage, /escapeHtml\(message\)/);

// Codara renders its own page rather than reaching into Pi's, which is what
// makes "no Pi branding" true no matter what Pi ships.
assert.match(
  callbackServer,
  /import \{ codaraOAuthErrorHtml, codaraOAuthSuccessHtml \} from "\.\/pi-oauth-callback-page";/,
);
for (const source of [callbackPage, callbackServer]) {
  assert.doesNotMatch(source, /^\s*import[^\n]*oauth-page\.js/m);
  assert.doesNotMatch(source, /^\s*import[^\n]*pi-ai/m);
}

// ---------------------------------------------------------------------------
// Owning the callback without owning the OAuth flow
// ---------------------------------------------------------------------------

// The redirect URI is registered against a fixed port, so Codara's listener is
// the same URI Pi would have used; it does not invent a second one.
assert.match(callbackServer, /export const PI_OPENAI_CALLBACK_PORT = 1455;/);
assert.match(callbackServer, /export const PI_OPENAI_CALLBACK_PATH = "\/auth\/callback";/);
// Pi reads its callback host from this variable; disagreeing would leave both
// listeners bound and the callback delivered to the wrong one.
assert.match(callbackServer, /PI_OAUTH_CALLBACK_HOST/);

// Pi still validates state and still exchanges the code. Codara's listener
// refuses anything that is not this sign-in, exactly as Pi's own would, and
// hands back only the two parameters Pi reads.
assert.match(callbackServer, /expectState\(state: string\): void/);
assert.match(
  callbackServer,
  /if \(!expectedState \|\| !state \|\| state !== expectedState \|\| !code\)/,
);
assert.match(callbackServer, /handback\.searchParams\.set\("code", code\);/);
assert.match(callbackServer, /handback\.searchParams\.set\("state", state\);/);
// A rejected callback must not settle the wait; the real one may still land.
assert.match(
  callbackServer,
  /if \(!expectedState[^\n]*\n[\s\S]{0,200}?respond\(res, 400[\s\S]{0,120}?return;/,
);
// Losing the bind is not an error: Pi then runs its own listener as before.
assert.match(
  callbackServer,
  /export async function startPiOAuthCallbackServer\(\): Promise<PiOAuthCallbackServer \| null>/,
);
assert.match(callbackServer, /if \(!listening\) \{\s*settle\(null\);\s*return null;\s*\}/);
// The browser keeps the callback socket alive; without this the port stays
// bound and the next sign-in cannot take it.
assert.match(callbackServer, /server\.closeAllConnections\(\);/);

// Only the OpenAI flow tolerates losing its listener. Anthropic's callback
// server rejects on a bind error instead of falling back to a pasted code, so
// taking its port would break that sign-in outright.
assert.match(
  subscriptionAuth,
  /if \(provider === "openai-codex"\) callback = await startPiOAuthCallbackServer\(\);/,
);
assert.doesNotMatch(
  subscriptionAuth,
  /provider === "anthropic"[^\n]*startPiOAuthCallbackServer/,
);
// The state Pi expects is learned from the authorize URL before the browser
// opens, so no callback is ever accepted unvalidated.
assert.match(subscriptionAuth, /const state = oauthStateFromAuthUrl\(event\.url\);/);
assert.match(subscriptionAuth, /if \(state\) callback\?\.expectState\(state\);/);
// The listener answers Pi's manual-code prompt; a genuine paste still wins.
assert.match(subscriptionAuth, /if \(!callback \|\| prompt\.type !== "manual_code"\) return typed;/);
assert.match(callbackServer, /waitForRedirect\(\): Promise<string \| null>/);
assert.match(subscriptionAuth, /callback\.waitForRedirect\(\)\.then\(\(url\) => \(\{ kind: "callback" as const, url \}\)\)/);
assert.match(subscriptionAuth, /if \(outcome\.kind === "typed"\) return outcome\.value;/);
assert.match(subscriptionAuth, /if \(outcome\.kind === "failed"\) throw outcome\.error;/);
// The listener is released on every exit path, cancel included.
assert.match(subscriptionAuth, /\} finally \{\s*(?:clearTimeout\(stallWatchdog\);\s*)?callback\?\.close\(\);/);

console.log(
  "PASS Studio returns to the front when a sign-in finishes, and the OpenAI callback lands on a Codara-branded page served from Pi's own registered redirect URI",
);
