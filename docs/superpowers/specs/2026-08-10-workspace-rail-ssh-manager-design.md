# Workspace rail cleanup + SSH manager — design

Date: 2026-08-10
Status: approved by Etienne (conversation), pending spec review

## Goal

Declutter the workspaces panel header to a single **+** button with a dropdown,
fix the two long-standing "…" menu bugs (inconsistent liquid glass, clipping at
the bottom of the sidebar), and replace the bare-bones SSH connect dialog with a
proper SSH manager that gives `~/.ssh` a UI: servers, keys, and copy-paste
setup helpers.

## Scope

### 1. Toolbar simplification (`WorkspaceRail.tsx`)

- The workspaces `SectionHeader` keeps **one** action: a `+` `RailIconButton`.
- Clicking `+` opens an `AnchoredMenu` dropdown with three items:
  1. **New workspace…** — existing `onCreate` flow (`createWs` in `App.tsx`).
  2. **New folder** — existing `createWorkspaceGroup` flow, enters inline rename.
  3. **New remote workspace (SSH)…** — opens the new SSH manager dialog.
- **Removed:** the folders button, the remote SSH button, and the minus
  (delete-active-workspace) button, including the local
  `deleteActiveWorkspace` helper. Deletion remains available in each
  workspace's and folder's "…" menu.
- **Right-click on blank space** in the workspaces panel scroll area opens a
  context menu with **New workspace…** and **New folder**. Follow the
  `contextMenu` state pattern from `FileTree.tsx` (blank-space handler,
  entry resolution), rendered with the same portal/glass treatment as other
  menus. Right-click on a row or folder does nothing new in this iteration
  (the "…" menu remains the affordance there).

### 2. "…" menu fixes — migrate to `AnchoredMenu`

Both bugs share one root cause chain; one migration fixes both.

- **Bug A — two-tone glass:** the folder card `<section>` sets an inline
  `backdrop-filter` (`WorkspaceRail.tsx` ~:961–978), making it a backdrop root.
  Menus rendered inside it sample the folder card's interior instead of the
  workbench, so they render dark/flat, while unfiled rows' menus get the real
  liquid glass.
- **Bug B — clipping:** both menus are `position: absolute` with hardcoded
  offsets inside the rail's `overflow: auto` scroll container, always open
  downward, never flip, and get cut off near the bottom.
- **Fix:** replace both hand-rolled menus (folder menu ~:1093–1136, row menu
  ~:1777–1889) with the existing
  `src/renderer/src/components/chat/composer/AnchoredMenu.tsx`, which portals
  to `document.body` with `position: fixed`, flips above when there is no room
  below, clamps to the right edge, re-measures on scroll/resize, and has a
  single-open registry. Portalling out of the folder card restores the correct
  glass backdrop everywhere.
- Replace the inline-styled `RowMenuItem` with the shared `.spark-menu-item`
  styling (or keep `RowMenuItem` but align it with the shared class) so all
  rail menus look identical.
- The `+` dropdown and the blank-space context menu use the same component, so
  every menu in the rail shares one look and one positioning engine.
- The `.spark-workspace-folder:focus-within { z-index: 40; }` workaround in
  `styles.css` (~:2500) exists only to lift in-card menus over the next card;
  once menus are portalled it should be removable — verify drag/drop and focus
  visuals still behave, then remove.

### 3. SSH manager (`SshManagerDialog`)

A new, larger two-tab dialog replacing `RemoteConnectDialog`. Reuses the
existing main-process SSH stack: `ssh-hosts.ts` (config parsing + manual
hosts), `connections.ts` (ssh2 pool, known-hosts, auth prompts),
`browse.ts` (SFTP picker), `secret-store.ts` (safeStorage). The existing
`BrowsePane` and `RemoteAuthPrompt` are reused as-is (BrowsePane may move to a
shared location).

`~/.ssh/config` is **never written**. Config-sourced hosts are read-only;
app-managed hosts persist in `spark-remote-hosts.json` as today.

#### Servers tab

- Unified host list: config hosts badged "from ssh config" (read-only) and
  app-managed hosts (editable/removable).
- Add/edit host form: name (id), host, user, port, identity — choose from keys
  found in `~/.ssh` (dropdown fed by the Keys tab data) or an arbitrary file.
- Per host:
  - **Test connection** — attempts a connection via existing `remote.connect`,
    shows live status (existing `remote.onStatus`), surfaces auth prompts
    through `RemoteAuthPrompt`.
  - **Open as workspace…** — SFTP folder browser (`BrowsePane`) → existing
    `createRemoteWs` flow.
  - **Remove** — app hosts only.

#### Keys tab

- Lists key pairs found in `~/.ssh`: name, type, fingerprint, truncated
  public-key preview, whether a matching private key exists.
- **Generate key** — invokes system `ssh-keygen` (`-t ed25519`) from the main
  process; custom filename (default suggestion offered), optional passphrase
  (passphrase passed via `-N`, never logged). Refuses to overwrite an existing
  file.
- **Import key** — file picker; copies the private key (and `.pub` sibling if
  present) into `~/.ssh` with `0600`/`0644` permissions; derives the public key
  via `ssh-keygen -y` when the `.pub` is missing (prompting for passphrase if
  needed is out of scope — surface a clear error instead).
- **Copy & setup helper** — per key: one-click copy of the public key plus a
  guide panel with provider recipes: DigitalOcean (Settings → Security → Add
  SSH key), GitHub (Settings → SSH and GPG keys), and generic server
  (ready-to-copy `echo '<pubkey>' >> ~/.ssh/authorized_keys` snippet with the
  actual key substituted).
- **Delete key** — last in build order, trivially cuttable. Deletes both halves
  of the pair after a strong confirmation that warns it can lock you out of
  servers that trust this key.

#### New main-process surface

- `src/main/remote/ssh-keys.ts`: `listKeys`, `generateKey`, `importKey`,
  `deleteKey`, `readPublicKey`. Key discovery = scan `~/.ssh` for `.pub` files
  plus well-known private key names; parse type/comment/fingerprint from the
  public key.
- IPC channels `sshKeys:list|generate|import|delete` registered in `ipc.ts`,
  exposed via preload as `window.spark.sshKeys.*`.
- Security constraints: all paths confined to `~/.ssh` (no traversal);
  passphrases never persisted or logged; `ssh-keygen` invoked with arg arrays
  (no shell interpolation).

#### Wiring

- `App.tsx`: `remoteConnectOpen` state and `handleCreateRemote` now open
  `SshManagerDialog`; `RemoteConnectDialog.tsx` is deleted. `createRemoteWs`
  is unchanged.

## Out of scope

- Writing to `~/.ssh/config`.
- Editing config-sourced hosts.
- `ssh-agent` management / adding keys to the agent.
- RSA/ECDSA generation options (ed25519 only).
- Right-click menus on individual rows/folders (the "…" menu stays).

## Error handling

- `ssh-keygen` missing (unlikely on macOS): generate/import fall back to a
  clear error message; list/copy still work.
- Key generation/import failures surface stderr in the dialog, not a toast.
- Test connection reuses the existing status/auth-prompt plumbing; failures
  show the error inline on the host row.

## Testing

- Main process: unit tests for `ssh-keys.ts` against a temp dir standing in
  for `~/.ssh` (list parsing, generate happy path, refuse-overwrite, import
  permissions, path confinement).
- Renderer: type-check + existing lint; manual verification of the four visual
  fixes (glass parity inside/outside folders, flip-up at the bottom, `+`
  dropdown, right-click folder creation) in the running app.
