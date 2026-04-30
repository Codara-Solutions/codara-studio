# Terminal Performance Fixes

The first uploaded app had the right UI skeleton, but the terminal and explorer could become laggy.

## Problems found

### 1. File explorer could load huge directories

The old `fs-tree.ts` had a dotfile skip condition, but it did not call `continue`, so hidden folders were still added to the tree.

That meant directories like `.git` and potentially `node_modules` could enter the UI tree and slow rendering.

Fix applied:

- hide `.git`, `node_modules`, build outputs, caches, and most dotfiles
- show only useful dotfiles such as `.env`, `.env.local`, `.gitignore`, `.npmrc`
- cap entries per directory to 800

### 2. PTY output was sent over IPC for every chunk

Claude/Codex workers can produce very chatty terminal output. Forwarding every chunk over Electron IPC makes the renderer work too hard.

Fix applied:

- batch PTY chunks in the main process
- flush approximately every animation frame
- flush immediately if the buffer gets large

### 3. xterm wrote every chunk immediately

`term.write(data)` was called directly for every IPC message. This can starve the UI thread during heavy output.

Fix applied:

- queue renderer output
- flush through `requestAnimationFrame`
- wait for xterm write callback before writing the next batch
- cap runaway render queue

### 4. Web link scanning was enabled

The WebLinks addon can be useful, but it adds work while streaming large logs.

Fix applied:

- removed WebLinksAddon for now
- add it back later as an optional setting

### 5. Resize work could repeat too often

Every `ResizeObserver` event called fit and resize.

Fix applied:

- fit/resize through animation frame
- only send PTY resize when cols/rows changed

## Test command

Run this in several terminal tiles:

```bash
yes "spark terminal stress test" | head -n 5000
```

Expected result: the terminal should stream output, but the whole app should remain responsive.

## Future improvements

- keep terminal sessions mounted when switching tabs
- virtualize terminal tile layout when many workers exist
- separate raw worker logs from visible terminal output
- add output rate indicator per worker
- add setting for scrollback size
- add setting for web-link detection
