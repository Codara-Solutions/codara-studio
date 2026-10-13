# Codara browser extension

A Manifest V3 extension for Chrome, Edge, Brave and other Chromium browsers.
It lets the agents you run in Codara (Cora, Claude Code, Codex, any MCP
client, or a shell agent through `cora tool`) use the tabs you share, with
your signed-in sessions. Codara drives them with the same `codara_preview_*`
tools it uses for its own browser tabs.

## Install (unpacked)

1. In Codara open Settings > General > Chrome extension and press
   **Reveal folder** (or **Copy path**). Codara copies the extension into
   `<Codara home>/chrome-extension` and keeps that copy current.
2. Open `chrome://extensions` (Edge: `edge://extensions`), turn on
   **Developer mode**, choose **Load unpacked** and pick that folder.
3. Click the Codara icon in the toolbar and choose **Connect to Codara**. The
   popup and Codara show the same six-digit code; press **Allow** in Codara
   only when they match.
4. In the popup, turn on **Let agents use this tab** for each tab agents may
   use. The popup shows the tab's id (`chrome:<tabId>`) with a copy button.

## How it connects

- The service worker opens a WebSocket to `ws://127.0.0.1:<port>/codara-chrome`,
  trying ports 47615 to 47619. There is no native messaging host and nothing
  is installed outside the browser and Codara's own folder.
- Codara accepts only loopback connections whose `Origin` is a
  `chrome-extension://` id, and only after the user allowed the pairing code.
  Pairing is an ECDH exchange: the extension commits to its key before it
  sees Codara's, and the code both screens show is derived from both keys,
  so a program relaying the exchange shows a different code. The token is
  derived from the exchange on both sides and never sent; Codara stores only
  its hash, bound to that extension id
  (`<Codara home>/chrome-link/links.json`). On every later connect Codara
  proves first that it holds the pairing (an HMAC over fresh nonces from
  both sides), then the extension proves the same, so a program that took
  Codara's port gets nothing it could use.
- Every frame after that handshake is encrypted and authenticated with a
  key for that session alone (AES-GCM, numbered per direction). A program
  that relayed the handshake can neither read the session nor add, drop or
  change a frame: either side closes the link at the first frame that does
  not open.
- The socket pings every 20 seconds, which keeps the MV3 service worker
  alive while connected. An alarm every 30 seconds reconnects after the
  worker was suspended or Codara restarted. A Codara that does not know the
  token (a second install, a test run) does not cost the pairing; only
  **Disconnect** in Codara or in the popup forgets it.
- Codara relays the DevTools protocol through `chrome.debugger`. While an
  agent is attached the browser shows its "is debugging this browser" bar,
  and the tab's badge reads `AI` (`ON` when shared but idle). Cancel on that
  bar stops sharing every tab.

## What agents can and cannot do

- Only tabs you shared: this tab, every tab in this window, or every tab in
  the browser (asks for confirmation). Stop one tab or all from the popup.
- Never a site on the blocked list (Options, or **Blocked sites** in the
  popup). It starts with examples for banks, payment services, password
  managers and account sign-in pages; one host per line, `*.` for
  subdomains, an optional path. A shared tab that navigates to a blocked
  site is detached at once, and its events stop.
- Browser pages (`chrome://`, the extension stores, other extensions) are
  never usable.
- Cookies and site storage (`Network.getCookies`, `DOMStorage.*`,
  `IndexedDB.*`, `Fetch.*` and similar) need **Allow cookie and storage
  access** for that tab, and reach only that tab's site: another site's
  cookies or storage, or a blocked site's, are refused even with it.
  Without it, cookie headers are removed from network events. Profile-wide
  cookie reads, clearing browser data, closing tabs it did not open, loading
  other URLs with your cookies (`Network.loadNetworkResource`), redirecting
  downloads and every `Browser.*` and `Target.*` command that would reach
  other tabs are always refused. Script an agent runs in a shared tab
  (`codara_preview_evaluate`) sees what the page's own scripts see, such as
  `localStorage` and non-HttpOnly cookies, but never HttpOnly cookies; share
  only tabs whose page you would let an agent script.
- Opening a new tab needs **Let agents open new tabs**; such a tab is shared
  automatically and only those tabs can be closed by an agent.
- Codara logs every tool call with the agent that made it (Settings > General
  > Chrome extension, and `<Codara home>/chrome-link/activity.jsonl`). The
  popup shows which agent used each tab last.

## Development

```sh
node extensions/chrome/test/run.mjs     # policy, link client, packing
node extensions/chrome/build/pack.mjs   # dist/codara-chrome-<version>.zip
npm test -- chrome                      # the above plus Codara's side
npx playwright test tests/e2e/chrome-extension.spec.ts
```

The e2e spec loads this folder into Playwright's Chromium with
`--load-extension` in a throwaway profile and pairs it with a test Codara on
a port of its own (`CODARA_CHROME_LINK_PORTS`). To point a loaded extension
at another port by hand, run
`chrome.storage.local.set({ ports: [47699] })` in its service worker console.
`CODARA_CHROME_LINK=0` turns the link off in Codara.

Store packaging is described in [STORE.md](STORE.md).
