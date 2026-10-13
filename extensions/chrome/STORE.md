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

- Name: Codara
- Summary (132 characters max): Let the agents you run in Codara use the
  browser tabs you share, with your signed-in sessions.
- Category: Developer Tools
- Language: English
- Icons: `icons/icon-128.png` (store icon). Screenshots (1280x800) of the
  popup with a shared tab and of Codara's pairing prompt are taken from the
  running app at release time.

Description:

> Codara runs coding agents on your computer. With this extension they can
> use the browser tabs you choose, signed in as you: read a page, fill a
> form, click through a flow, take a screenshot, read the console and the
> network log. You pair the extension with Codara once by comparing a code.
> Agents see only the tabs you share from the popup, never the sites on your
> blocked list (banks and password managers are preset), and need your
> permission per tab before they can read cookies or site storage. Every
> action is logged in Codara with the agent that made it. The extension talks
> only to Codara on this computer (127.0.0.1) and sends nothing anywhere else.

## Permission justifications

- `debugger`: the agent's actions on a shared tab (snapshot, click, type,
  screenshots, console and network) use the DevTools protocol on that tab
  only. The browser shows its debugging bar while an agent is attached, and
  Cancel stops all sharing.
- `tabs`: list the user's tabs in the popup so they can choose which to
  share, follow a shared tab's URL to enforce the blocked-sites list, and
  open, focus or close tabs when the user allowed it.
- `storage`: remember the pairing token, the blocked-sites list and the
  user's sharing choices.
- `alarms`: reconnect to Codara after the service worker was suspended or
  Codara restarted.
- No host permissions, no content scripts, no remote code.

## Privacy practices

- Single purpose: let the user's local Codara app drive the browser tabs the
  user shares.
- Data handling: the extension relays page content of shared tabs to Codara
  on the same computer over a loopback WebSocket. It does not collect, sell
  or transmit data to any server of ours or of a third party. Cookies and
  site storage are relayed only for tabs where the user turned that on.
- Data use certifications: not sold, not used for unrelated purposes, not
  used for creditworthiness.
- Privacy policy URL: the Codara privacy policy (to be linked at publication).

## Edge Add-ons

The same zip uploads to Partner Center. Use the listing text above; the
category there is "Developer tools".
