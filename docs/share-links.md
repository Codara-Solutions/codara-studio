# Share as link

Share an HTML or Markdown file from the editor as a private link that anyone
can open in a browser, without an account. The page is served by the Codara
share service (the `codara-share` repository).

## Sharing a page

Open the file and click the share icon in the editor toolbar, next to
Preview and Edit. The prompt shows the file name, the size of the page, what
it includes, and **Anyone with the link can open this page.** Pick when the
link expires (7, 30 or 90 days; 30 by default) and click **Share**. Nothing
leaves the computer before that click.

The link is copied to the clipboard and shown in the prompt with a Copy
button. Settings, **Shared pages** lists every link this computer shared:
copy it, change when it expires (counted from today), or delete it. A deleted
or expired link stops working at once.

## What the page contains

The shared page is one self-contained HTML document, built on this computer
from the file as it is in the editor (unsaved edits included):

- **Markdown** is rendered by the same pipeline as the preview, with the same
  sanitizer: raw scripts, event handlers and `javascript:` links are removed.
  Code blocks keep their highlighting and Mermaid diagrams become pictures.
  The page follows the reader's light or dark mode.
- **HTML** is shared as written, scripts included.
- **Local files** the page uses (pictures, fonts, stylesheets, scripts, audio
  and video) are embedded, as long as they are in the page's folder or the
  workspace it belongs to, are not hidden (no segment starting with a dot),
  and have the extension of what they are used as. The prompt lists what it
  embedded and what it left out, and why.
- **Links to other files on this computer**, frames, embeds, `<base>` and
  redirects are removed, because they cannot work for someone else.
- **Files from other sites** stay as references but do not load: the page is
  served sealed (below). The prompt says how many there are.

A page is at most 5 MB after embedding.

## How the page is served

The service serves each page with a Content Security Policy that runs it in
a sandbox: it cannot load anything from another site or call one from a
script, submit forms, use the service's cookies or storage, or be framed by
another site. A script in the page can still open or move to another page,
as any link can. Pages carry `noindex`, are never cached, and the
link's id is 144 random bits, so it cannot be guessed. Anyone who has the
link can open the page, and forward it, until it expires or you delete it.

## Agents

An agent that writes a report for someone else can call
`codara_share_offer` with the file's path (see
[mcp-tools.md](./mcp-tools.md#share-offer)). Codara opens the file and shows
the same prompt; nothing is uploaded unless you click Share, and the agent
never gets the link.

## Your share key

The first time you share, Codara creates a key in
`~/.codarastudio/share/identity.json` (mode 0600, in a 0700 folder). It signs
every request, so the service knows which pages are yours: only this key can
list, extend or delete them. It is separate from the Remote access key, it
never leaves the main process, and nothing in the app can read it. If the
file is lost or damaged, Codara makes a new key: links you shared keep
working until they expire, but this computer can no longer manage them.

## Service address

Studio talks to the production share service by default. For tests and local
development, `CODARA_SHARE_URL` points it at another instance: an `https`
address, or `http` on a loopback address only.
