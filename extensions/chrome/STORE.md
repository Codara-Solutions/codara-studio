# Chrome Web Store and Edge Add-ons

The extension is prepared for the stores but not published. Publishing is a
manual step in each store's dashboard.

## Build the upload

```sh
node extensions/chrome/build/pack.mjs            # extensions/chrome/dist/
node extensions/chrome/build/pack.mjs --out /tmp # or another folder
```

The script checks the manifest (MV3, a valid version, every referenced file
present, no remote code) and writes `codara-chrome-<version>.zip` with fixed
timestamps, so the same sources always give the same bytes. Bump `version` in
`manifest.json` for every upload; the stores refuse a version they have seen.

## Listing

- Name: Codara Studio (the manifest `name`; `short_name` stays "Codara", which
  is what the toolbar and the popup show)
- Summary (132 characters max): Let the agents you run in Codara use the
  browser tabs you share, with your signed-in sessions.
- Category: Developer Tools
- Language: English
- Small promo tile (440x280 PNG): `store/promo-tile-440x280.png`. Without
  it the store search shows the icon alone in a white box.
- Icons: `icons/icon-128.png` (store icon). Screenshots (1280x800, up to
  five) are taken headless at release time: the agent's pointer and Stop on
  a page, the popup light and dark, and Codara's connect card.

Description:

> Codara runs coding agents on your computer. With this extension they can
> use the browser tabs you choose, signed in as you: read a page, fill a
> form, click through a flow, take a screenshot, read the console and the
> network log. You pair the extension with Codara once by comparing a code.
> Agents see only the tabs you share from the popup, never the sites on your
> blocked list (banks and password managers are preset). On a shared tab,
> agents can do what the page's own scripts can: read its site storage
> (local and session storage, IndexedDB) and cookies that are not
> HttpOnly, and see its requests and responses, including sign-in headers
> such as Authorization. A second switch per tab,
> off by default, lets them read and change all of that site's cookies and
> storage. While an agent works in a tab, the page shows its pointer with its
> name and a Stop button that takes the tab back from that agent. Every
> action is logged in Codara with the agent that made it. The extension
> talks only to Codara on this computer (127.0.0.1) and sends nothing to any
> other server; Codara hands what agents read to the agents you run, which
> send it to their AI provider under your own account.

## Permission justifications

- `debugger`: the agent's actions on a shared tab (snapshot, click, type,
  screenshots, console and network) use the DevTools protocol on that tab
  only. The browser shows its debugging bar while an agent is attached, and
  Cancel stops all sharing.
- `tabs`: list the user's tabs in the popup so they can choose which to
  share, follow a shared tab's URL to enforce the blocked-sites list, and
  open, focus or close tabs when the user allowed it.
- `tabGroups`: put the tabs an agent opens into a tab group named after its
  task, so they stay together and apart from the user's own tabs.
- `storage`: remember the pairing token, the blocked-sites list and the
  user's sharing choices.
- `alarms`: reconnect to Codara after the service worker was suspended or
  Codara restarted.
- No host permissions, no content scripts, no remote code.

## Privacy practices

- Single purpose: let the user's local Codara app drive the browser tabs the
  user shares.
- Data handling: the extension relays page content of shared tabs to Codara
  on the same computer over a loopback WebSocket (encrypted after pairing;
  the first hello, the pairing handshake, is plain). The extension itself
  sends nothing to any server of ours or of a third party; Codara passes what an agent asked for
  to that agent, which sends it to its AI provider under the user's account.
  Authentication data is handled on every shared tab: request headers such
  as `Authorization`, response bodies, and what page scripts can read: site
  storage (local and session storage, IndexedDB) and cookies that are not
  HttpOnly. Cookie headers, HttpOnly cookies and the storage commands need
  the per-tab cookie switch. Contact:
  info@codarasolutions.com. The paste-ready pack, with retention, is kept
  outside the repository.
- Data use certifications: not sold, not used for unrelated purposes, not
  used for creditworthiness.
- Privacy policy URL: a section for the extension in the Codara privacy
  policy (the Cloud one does not cover it), published before submitting.
- Remote code: no. Page scripts an agent asks for run in the shared tab
  through the DevTools protocol, never in the extension.

## Edge Add-ons

The same zip uploads to Partner Center. Use the listing text above; the
category there is "Developer tools".
