# Codara for Firefox

A Manifest V3 extension for Firefox 153 and later. It does for Firefox what
[the Chrome extension](../chrome/README.md) does for Chromium browsers: the
agents you run in Codara use the tabs you share, with your signed-in
sessions, through the same `codara_preview_*` tools. Pairing, the popup, the
blocked sites, the per-tab cookie switch and the log in Codara are the
same; what Firefox cannot do is listed below and refused with the reason.

This folder holds only what differs from Chrome (`manifest.json`,
`background.js`, `lib/firefox.js`). The popup, the options page, the icons
and the link, policy and presence code are the Chrome extension's own files,
listed in `shared.json` and copied in by the assembly, which never writes to
`extensions/chrome`. A shared file that needs other words in Firefox gets a
text patch in `shared.json`; if the Chrome file no longer has that text the
assembly fails instead of shipping Chrome's wording.

## Install (temporary add-on, for now)

1. `node extensions/firefox/build/assemble.mjs` writes the extension to
   `extensions/firefox/dist/extension/`.
2. Open `about:debugging#/runtime/this-firefox`, choose **Load Temporary
   Add-on** and pick `manifest.json` in that folder. Firefox forgets a
   temporary add-on when it quits; a signed build from addons.mozilla.org
   will replace this step.
3. Click the Codara button in the toolbar, **Connect to Codara**, and allow
   the same six-digit code in Codara.
4. Share a tab with its switch, or pick **This window** or **Everything**.

## How it connects

The same link as Chrome's (`lib/link-client.js`, shared): a WebSocket to
`ws://127.0.0.1:47615-47619/codara-chrome`, an ECDH pairing with a code both
sides show, proofs both ways on every later connect, and AES-GCM frames
after the handshake. Codara accepts the `moz-extension://<uuid>` origin;
Firefox draws that uuid per profile, so a pairing binds to the uuid it was
made with and a token copied to another profile is refused.

Firefox has no service workers for extensions: the background is an event
page. Two things differ from Chrome, both measured (see below):

- Firefox's default MV3 policy adds `upgrade-insecure-requests`, which turns
  `ws://127.0.0.1` into `wss://` and the connection fails (close code 1015).
  The manifest sets `extension_pages` to `script-src 'self'`.
- Traffic on the WebSocket does not keep an event page alive: Firefox
  unloads it after its idle timeout and the socket closes (code 1001). While
  connected, the page makes one call into the browser every 10 seconds
  (`runtime.getPlatformInfo()`), which resets the idle timer, and an alarm
  every 30 seconds reconnects if the page was unloaded anyway.

## How agents act without a debugger

Firefox gives extensions no debugger and no DevTools protocol. Codara's
tools speak that protocol, so the extension answers Codara's `cdp` requests
itself for the commands it can honour and lists them in its hello
(`extension.capabilities.cdp`). Codara refuses any other command before it
is sent, with a plain "`<method>` is not available in Firefox" error, so an
agent learns at once what to do instead.

## What works

Measured on Firefox 158.0 and on ESR 153.7.0 (Linux, headless) on 18
November 2026 with a spike extension and a fake Codara: every measured row
below gave the same result on both. The end-to-end spec
(`tests/e2e/firefox-extension.spec.ts`) checks the rows marked *e2e* on
every pull request, on the current Firefox and on ESR 153 (CI (Linux)); it
also passed locally on Firefox 158.0, 160.0.1 and ESR 153.7.0.
"Not yet" rows come in the next pull requests of this stack; until then Codara refuses them with the reason.

| Capability | Status | How, and what was measured |
|---|---|---|
| Pair, reconnect, unpair | Works (e2e) | Same link as Chrome; moz-extension origin bound at pairing. |
| Share one tab, a window, everything; blocked sites; browser pages refused | Works (e2e) | Popup shared with Chrome. Firefox pages (about:blank too: a page can write into one), local files and Mozilla's add-on and account sites are never shared. Blocked sites written in Unicode match the punycode hosts in tab URLs. Only the popup and the options page can steer the extension, one action at a time. |
| Stay connected while idle | Works (e2e) | Spike: a WebSocket alone was unloaded at the idle timeout (close 1001, at 4 s and at 25 s timeouts); `storage.local.get` per ping did not help; one `runtime.getPlatformInfo()` per ping held 80 s at Firefox's default 30 s. An alarm wakes an unloaded page and it reconnects. The e2e holds the link 40 s at a 15 s timeout with the 10 s keep-alive, and fails with it removed. |
| Refuse what Firefox cannot do, with the reason | Works (e2e) | Codara reads the hello's command list. |
| Read the page, run an agent's script | Not yet; measured | `userScripts.execute` in the page's main world: works on a page with `default-src 'none'` and Trusted Types, sees page globals, awaits promises, returns objects. Needs the `userScripts` permission, which Firefox lets the user grant only at runtime ("Allow unverified third-party scripts to access your data"), and access to that site. A thrown error comes back empty, so the extension wraps the code. `scripting.executeScript` with `eval` is blocked by such a page's policy and is not used. |
| Screenshots of background tabs | Not yet; measured | `tabs.captureTab` captures a background tab and beyond the viewport. It exists only with access to all sites (`captureTab is not a function` with one site), so screenshots ask for all sites. |
| Navigate, open and close tabs, tab groups | Not yet; measured | `tabs.group` and `tabGroups` exist in Firefox 158 and ESR 153. Until then opening a tab is refused, the extension tells Codara it cannot open tabs, and the popup hides "Open new tabs in a group". |
| Console | Not yet | Page script from document start; misses Firefox's own security and network messages. |
| Network log with headers, response bodies | Not yet; measured | `webRequest` events carry tab ids and headers; `filterResponseData` returned bodies in MV3. Needs access to the site. |
| Cookies, HttpOnly included, behind the per-tab switch | Not yet; measured | `cookies.getAll` read an HttpOnly cookie. |
| Agent's pointer, glow, Stop | Not yet; measured | Content script world, closed shadow root, constructed style sheet: drawn on a page with `default-src 'none'`. It shows in `captureTab`, so captures hide it, as in Chrome. |
| Trusted input (mouse, keys, drag) | Not yet; will be degraded | No extension API. Scripted events with the full event sequence; the page sees `isTrusted: false` (measured). Tools say so. |
| Emulation, throttling, tracing, heap, PDF, raw `tab.cdp` | Not available | No extension API in Firefox. Refused with the reason. |

NOT TESTED: background-tab screenshots in a visible or minimized window
(only headless); macOS and Windows; how addons.mozilla.org review treats
`userScripts`; the alarm's minimum period in a signed build.

## Permissions

At install: `tabs`, `storage`, `alarms` (`tabGroups` comes with opening tabs). Nothing else: site
access, `userScripts` and access to all sites are asked from a click in the
popup at the moment a feature needs them, with what stops working without
them, and never again right after a no.

## Development

```sh
node extensions/firefox/test/run.mjs          # firefox rules, manifest, assembly
node extensions/firefox/build/assemble.mjs    # dist/extension/
npm test -- firefox                           # the above plus Codara's side
CODARA_E2E_REQUIRE_FIREFOX=1 npx playwright test tests/e2e/firefox-extension.spec.ts
```

The e2e spec runs Firefox headless on a throwaway profile, installs the
assembled extension as a temporary add-on over WebDriver BiDi (the test's
remote control only; the extension never uses it) and pairs it with a test
Codara on a port of its own. `CODARA_E2E_FIREFOX` points it at another
Firefox binary; `CODARA_E2E_COLOR_SCHEME=dark` takes the popup screenshots
dark.
