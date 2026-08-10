# Workspace Rail Cleanup + SSH Manager Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the workspaces panel header to a single `+` button with a dropdown, fix the rail "…" menus (inconsistent liquid glass + bottom clipping) by migrating them to the portal-based `AnchoredMenu`, and replace the bare-bones SSH connect dialog with a two-tab SSH manager (Servers / Keys) backed by a new `ssh-keys` main-process module.

**Architecture:** Electron app (electron-vite). Renderer is React 18 + inline styles + shared CSS classes in `src/renderer/src/styles.css` (`.spark-menu`, `.spark-btn`, `.spark-input`, `.spark-glass`). Main↔renderer via `ipcMain.handle` wrappers in `src/main/ipc.ts` exposed through `src/preload/index.ts` as `window.spark.*` (renderer types flow automatically from the `api` object via `src/preload/preload-types.d.ts`). Existing SSH stack lives in `src/main/remote/` and stays untouched except for the new `ssh-keys.ts`.

**Tech Stack:** TypeScript, React 18, Electron 43, ssh2 + ssh-config (existing), system `ssh-keygen` for key generation, esbuild-bundled node test scripts under `scripts/` (repo's test convention — see `scripts/test-fs-sandbox.cjs`).

**Spec:** `docs/superpowers/specs/2026-08-10-workspace-rail-ssh-manager-design.md`

## Global Constraints

- `~/.ssh/config` is NEVER written. Config-sourced hosts are read-only in every UI.
- All ssh-key file operations are confined to the ssh dir: key names must match `/^[A-Za-z0-9._-]+$/` and must not contain `..`.
- Passphrases are never persisted or logged; `ssh-keygen` is invoked via `execFile` with an argument array (no shell).
- Every new dropdown/popover in the rail must render through a portal to `document.body` (via `AnchoredMenu` or `createPortal`) — never `position: absolute` inside the rail's scroll container.
- Keep `className="spark-menu"` on every menu surface (that class carries the liquid-glass material).
- Verification commands: `npm run typecheck:web` (renderer), `npm run typecheck:node` (main/preload), `node scripts/test-ssh-keys.cjs` (new module).
- Commit after every task. Do not commit unrelated files already dirty in the worktree (`package.json`, `src/main/ipc.ts` etc. carry unrelated in-flight changes — stage only the files you touched, and only your hunks are expected in them; use `git add <specific files>`; for `ipc.ts`/`preload/index.ts` your edits are additive blocks so staging the whole file is acceptable ONLY if `git diff` shows just your additions plus the pre-existing dirty hunks — in that case use `git add -p` to stage only your hunks).

---

### Task 1: Migrate the workspace-row "…" menu to AnchoredMenu

Fixes, for workspace rows: the dark/flat glass inside folder cards and the clipping at the bottom of the sidebar.

**Files:**
- Modify: `src/renderer/src/components/WorkspaceRail.tsx` (row menu at ~:1777–1889, its dismissal listeners at ~:1510–1526)

**Interfaces:**
- Consumes: `AnchoredMenu` from `src/renderer/src/components/chat/composer/AnchoredMenu.tsx` — props `{ anchorRef, open, onClose, className, role, ariaLabel, placement, align, zIndex, children }`.
- Produces: nothing new — same `RowMenuItem` children, same handlers.

- [ ] **Step 1: Add the import and an anchor ref**

At the top of `WorkspaceRail.tsx` add:

```tsx
import AnchoredMenu from "./chat/composer/AnchoredMenu";
```

In `WorkspaceRow` (component starts ~:1390), find `menuWrapRef` (declared near the other row refs and used at ~:1777). Add next to it:

```tsx
const menuBtnRef = useRef<HTMLButtonElement>(null);
```

and put `ref={menuBtnRef}` on the "…" `<button>` at ~:1778.

- [ ] **Step 2: Replace the absolute menu with AnchoredMenu**

Replace the whole `{menuOpen && !editing && ( <div role="menu" className="spark-menu" style={{ position: "absolute", top: 24, ... }}> ... </div> )}` block (~:1845–1888) with:

```tsx
<AnchoredMenu
  anchorRef={menuBtnRef}
  open={menuOpen && !editing}
  onClose={() => setMenuOpen(false)}
  className="spark-menu"
  role="menu"
  ariaLabel="Workspace actions"
  placement="below"
  align="end"
>
  <div style={{ minWidth: 168, maxWidth: 240, padding: 4, display: "grid", gap: 2 }}>
    <RowMenuItem
      label="Edit"
      onClick={() => {
        setMenuOpen(false);
        onEdit();
      }}
    />
    {!ws.remote && (
      <RowMenuItem
        label="Create isolated worktree…"
        onClick={() => {
          setMenuOpen(false);
          onCreateCopyBranch();
        }}
      />
    )}
    <RowMenuItem
      label="Delete"
      danger
      onClick={() => {
        setMenuOpen(false);
        onDelete();
      }}
    />
  </div>
</AnchoredMenu>
```

Notes: the inner `<div>` carries the old width/padding/grid styles (the portal wrapper itself gets `spark-menu`, position comes from `AnchoredMenu`). The old `maxHeight: 280 / overflowY` is dropped — three items never scroll, and AnchoredMenu flips instead of scrolling. Leave the default `zIndex` (60): the rail sits in the workbench, nothing between 40 and 60 competes.

- [ ] **Step 3: Delete the row's manual dismissal listeners**

`WorkspaceRow` has a `useEffect` (~:1510–1526) adding `document` `mousedown` + `Escape` listeners to close `menuOpen`. Delete that effect entirely — `AnchoredMenu` owns outside-click, Escape, scroll-away, and single-open behavior. Keep `menuWrapRef` only if it is still referenced (it holds the 18px flex slot `<div>`; keep the div, the ref can stay or go — remove the ref if nothing else uses it after the effect is deleted).

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck:web`
Expected: PASS (no new errors; pre-existing errors, if any, must be unchanged).

- [ ] **Step 5: Visual check**

Run the app (`npm run dev`), open a workspace's "…" menu (a) on an unfiled workspace, (b) on a workspace inside a folder, (c) on the bottom-most row with the sidebar scrolled so the row sits near the panel bottom. Expected: identical liquid-glass material in all three, and (c) flips upward instead of clipping.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/WorkspaceRail.tsx
git commit -m "fix: portal workspace-row menu via AnchoredMenu (glass parity + no clipping)"
```

---

### Task 2: Migrate the folder "…" menu to AnchoredMenu and drop the z-index workaround

**Files:**
- Modify: `src/renderer/src/components/WorkspaceRail.tsx` (folder menu ~:1093–1136, folder dismissal listeners ~:856–872)
- Modify: `src/renderer/src/styles.css` (`.spark-workspace-folder:focus-within { z-index: 40; }` at ~:2500–2504)

**Interfaces:**
- Consumes: `AnchoredMenu` (import added in Task 1), `RowMenuItem`.
- Produces: nothing new.

- [ ] **Step 1: Replace the folder menu**

In `WorkspaceFolder` (~:802), the menu trigger is a `.spark-icon-btn` inside a wrapper with `menuRef` (~:1094). Add a button ref:

```tsx
const folderMenuBtnRef = useRef<HTMLButtonElement>(null);
```

put `ref={folderMenuBtnRef}` on the trigger button, then replace the `{menuOpen && ( <div role="menu" className="spark-menu" style={{ position: "absolute", top: 21, right: 0, minWidth: 160, padding: 4, zIndex: 30 }}> ... )}` block with:

```tsx
<AnchoredMenu
  anchorRef={folderMenuBtnRef}
  open={menuOpen}
  onClose={() => setMenuOpen(false)}
  className="spark-menu"
  role="menu"
  ariaLabel="Folder actions"
  placement="below"
  align="end"
>
  <div style={{ minWidth: 160, padding: 4, display: "grid", gap: 2 }}>
    {/* keep the existing menu items exactly as they are (Rename folder / Delete folder) */}
  </div>
</AnchoredMenu>
```

Copy the existing `RowMenuItem` children verbatim into the inner div — only the container changes.

- [ ] **Step 2: Delete the folder's manual dismissal listeners**

Remove the `useEffect` at ~:856–872 (document mousedown + Escape for the folder menu), same rationale as Task 1 Step 3.

- [ ] **Step 3: Remove the stacking workaround**

In `styles.css` (~:2500) delete the rule and its comment:

```css
/* Folder cards use backdrop-filter, which creates a stacking context. Lift the
   focused card so a workspace/folder action menu can float over the following
   folder instead of being visually present but pointer-blocked by it. */
.spark-workspace-folder:focus-within { z-index: 40; }
```

It existed only so in-card menus could overhang the next folder card; portalled menus don't need it.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck:web`
Expected: PASS.

- [ ] **Step 5: Visual check**

In the running app: open a folder's "…" menu (glass should now match everything else), open it on a folder near the panel bottom (flips up), drag a workspace between folders (drag/drop unaffected by the removed z-index rule), and confirm opening a second menu closes the first.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/WorkspaceRail.tsx src/renderer/src/styles.css
git commit -m "fix: portal folder menu via AnchoredMenu, drop focus-within z-index workaround"
```

---

### Task 3: Single `+` header button with dropdown

**Files:**
- Modify: `src/renderer/src/components/WorkspaceRail.tsx` (header actions ~:488–523, `deleteActiveWorkspace` ~:206, glyphs `FolderPlusGlyph` ~:2089 / `RemoteGlyph` ~:2100)

**Interfaces:**
- Consumes: existing props `onCreate`, `props.onCreateWorkspaceGroup` (returns new group id), `props.onCreateRemote`, `setEditingGroupId`; `AnchoredMenu`; `RowMenuItem`; `RailIconButton`; `PlusIcon`.
- Produces: header state `createMenuOpen: boolean` + `createBtnRef` inside `WorkspaceRail` (used again by Task 4's shared items only conceptually — Task 4 is independent).

- [ ] **Step 1: Add dropdown state and replace the four buttons**

In `WorkspaceRail` (top-level component, ~:175), add near its other state:

```tsx
const [createMenuOpen, setCreateMenuOpen] = useState(false);
const createBtnRef = useRef<HTMLButtonElement>(null);
```

Replace the entire `actions={<>...</>}` block (~:495–522, all four `RailIconButton`s) with:

```tsx
actions={
  <>
    <RailIconButton
      ref={createBtnRef}
      title="New…"
      onClick={() => setCreateMenuOpen((o) => !o)}
    >
      <PlusIcon size={11} />
    </RailIconButton>
    <AnchoredMenu
      anchorRef={createBtnRef}
      open={createMenuOpen}
      onClose={() => setCreateMenuOpen(false)}
      className="spark-menu"
      role="menu"
      ariaLabel="Create"
      placement="below"
      align="end"
    >
      <div style={{ minWidth: 200, padding: 4, display: "grid", gap: 2 }}>
        <RowMenuItem
          label="New workspace…"
          onClick={() => {
            setCreateMenuOpen(false);
            onCreate();
          }}
        />
        <RowMenuItem
          label="New folder"
          onClick={() => {
            setCreateMenuOpen(false);
            setEditingGroupId(props.onCreateWorkspaceGroup());
          }}
        />
        <RowMenuItem
          label="New remote workspace (SSH)…"
          onClick={() => {
            setCreateMenuOpen(false);
            props.onCreateRemote();
          }}
        />
      </div>
    </AnchoredMenu>
  </>
}
```

- [ ] **Step 2: Make RailIconButton forward its ref**

`RailIconButton` (~:1262) renders a `<button>` but is a plain function component. Wrap it:

```tsx
const RailIconButton = React.forwardRef<HTMLButtonElement, RailIconButtonProps>(
  function RailIconButton({ ...existing props... }, ref) {
    // existing body, with ref={ref} added to the <button>
  },
);
```

(Keep the existing props interface; only add the forwarded ref. If the props are currently inline-typed, extract them to a local `interface RailIconButtonProps` unchanged.)

- [ ] **Step 3: Delete dead code**

Remove:
- `deleteActiveWorkspace` (~:206) — no caller remains.
- `FolderPlusGlyph` (~:2089) and `RemoteGlyph` (~:2100) if no other references remain (grep the file).
- `MinusIcon` import if now unused (grep the file).

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck:web`
Expected: PASS.

- [ ] **Step 5: Visual check**

In the app: header shows only `+`; the dropdown's three items each work (workspace picker opens; folder appears in inline-rename; SSH dialog opens). Menu gets the glass material and right-aligns to the button.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/WorkspaceRail.tsx
git commit -m "feat: collapse workspaces header actions into a single + dropdown"
```

---

### Task 4: Right-click on blank sidebar space → New workspace / New folder

**Files:**
- Modify: `src/renderer/src/components/WorkspaceRail.tsx` (scroll container div ~:524–526; new `RailContextMenu` component near `RowMenuItem` ~:1902)

**Interfaces:**
- Consumes: `onCreate`, `props.onCreateWorkspaceGroup`, `setEditingGroupId`, `RowMenuItem`, `createPortal` from `react-dom`.
- Produces: local component `RailContextMenu({ x, y, onClose, children })` — portal-fixed menu at a screen point.

- [ ] **Step 1: Add context-menu state and handler**

In `WorkspaceRail`, next to `createMenuOpen`:

```tsx
const [railCtxMenu, setRailCtxMenu] = useState<{ x: number; y: number } | null>(null);
```

On the workspaces scroll container `<div>` (~:525, the one with `flex: 1, overflow: "auto"`), add:

```tsx
onContextMenu={(event) => {
  // Blank space only — rows and folders keep their "…" menus.
  if (event.target !== event.currentTarget) return;
  event.preventDefault();
  setRailCtxMenu({ x: event.clientX, y: event.clientY });
}}
```

- [ ] **Step 2: Add the RailContextMenu component**

Add near `RowMenuItem` (file bottom):

```tsx
// Right-click menu for blank rail space. Anchored to a POINT, not an element,
// so AnchoredMenu doesn't fit — but the same rules apply: portal to body
// (correct glass backdrop, no overflow clipping) and clamp to the viewport.
function RailContextMenu({
  x,
  y,
  onClose,
  children,
}: {
  x: number;
  y: number;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const pad = 8;
    const rect = el.getBoundingClientRect();
    setPos({
      left: Math.min(Math.max(pad, x), window.innerWidth - rect.width - pad),
      top: Math.min(Math.max(pad, y), window.innerHeight - rect.height - pad),
    });
  }, [x, y]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && ref.current?.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    // Capture-phase: some dialog surfaces stopPropagation on mousedown.
    document.addEventListener("mousedown", onPointerDown, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", onPointerDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="spark-menu"
      style={{
        position: "fixed",
        left: pos?.left ?? x,
        top: pos?.top ?? y,
        minWidth: 180,
        padding: 4,
        display: "grid",
        gap: 2,
        zIndex: 60,
        visibility: pos ? "visible" : "hidden",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
```

Add `import { createPortal } from "react-dom";` and ensure `useLayoutEffect` is imported from react.

- [ ] **Step 3: Render it**

Inside the workspaces section render (next to the scroll container, e.g. right after the closing tag of the `!collapsed.workspaces` div):

```tsx
{railCtxMenu && (
  <RailContextMenu x={railCtxMenu.x} y={railCtxMenu.y} onClose={() => setRailCtxMenu(null)}>
    <RowMenuItem
      label="New workspace…"
      onClick={() => {
        setRailCtxMenu(null);
        onCreate();
      }}
    />
    <RowMenuItem
      label="New folder"
      onClick={() => {
        setRailCtxMenu(null);
        setEditingGroupId(props.onCreateWorkspaceGroup());
      }}
    />
  </RailContextMenu>
)}
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck:web`
Expected: PASS.

- [ ] **Step 5: Visual check**

Right-click blank space below the rows → menu appears at the cursor with glass material; both items work; right-click ON a row does nothing new; Escape/outside click closes; right-click near the window bottom clamps on-screen.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/WorkspaceRail.tsx
git commit -m "feat: right-click blank rail space to create workspace/folder"
```

---

### Task 5: Main-process `ssh-keys` module (TDD)

**Files:**
- Create: `src/shared/ssh-keys.ts`
- Create: `src/main/remote/ssh-keys.ts`
- Test: `scripts/test-ssh-keys.cjs`
- Modify: `package.json` (add `"test:ssh-keys": "node scripts/test-ssh-keys.cjs"` to scripts)

**Interfaces:**
- Produces (shared types, `src/shared/ssh-keys.ts`):

```ts
export interface SshKeyInfo {
  /** Private-key filename inside the ssh dir, e.g. "id_ed25519". */
  name: string;
  privateKeyPath: string;
  publicKeyPath: string | null;
  /** Full one-line contents of the .pub file, trimmed. Null when no .pub. */
  publicKey: string | null;
  /** Key algorithm parsed from the .pub line, e.g. "ssh-ed25519". */
  type: string | null;
  /** "SHA256:…" via `ssh-keygen -lf`; null when unavailable. */
  fingerprint: string | null;
  comment: string | null;
  hasPrivateKey: boolean;
}

export interface SshKeyImportResult {
  key: SshKeyInfo;
  /** Set when the private key imported fine but the .pub could not be derived. */
  warning?: string;
}

export function isValidKeyName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && !name.includes("..") && !name.endsWith(".pub");
}
```

- Produces (main module, `src/main/remote/ssh-keys.ts`; every function takes an optional `dir` defaulting to `join(homedir(), ".ssh")` so tests point it at a temp dir):

```ts
export async function listKeys(dir?: string): Promise<SshKeyInfo[]>;
export async function generateKey(
  opts: { name: string; passphrase?: string; comment?: string },
  dir?: string,
): Promise<SshKeyInfo>;
export async function importKey(sourcePath: string, dir?: string): Promise<SshKeyImportResult>;
export async function deleteKey(name: string, dir?: string): Promise<void>;
```

Behavior contract:
- `listKeys`: missing dir → `[]`. A key = every `*.pub` file (name = filename minus `.pub`) plus any of the well-known private names `id_rsa`, `id_ecdsa`, `id_ed25519` present without a `.pub`. Skip `known_hosts*`, `config`, `authorized_keys`. Parse `.pub` as `"<type> <base64> [comment]"`. Fingerprint via `execFile("ssh-keygen", ["-lf", pubPath])`, best-effort (null on failure). Sorted by name.
- `generateKey`: validate `isValidKeyName(name)` (throw `Error("Invalid key name.")`), throw `Error(\`${name} already exists.\`)` if private or pub path exists. `mkdir` the dir with `{ recursive: true, mode: 0o700 }`. Run `execFile("ssh-keygen", ["-t", "ed25519", "-f", privPath, "-N", passphrase ?? "", "-C", comment ?? \`${userInfo().username}@codara-studio\`])`. On failure throw with stderr text. Return the new key's `SshKeyInfo`.
- `importKey`: read source; if it doesn't contain `"PRIVATE KEY"` throw `Error("Not a private key file.")`. Dest name = `basename(sourcePath)`, must pass `isValidKeyName`; refuse overwrite like generate. `copyFile` then `chmod 0o600`. If `<source>.pub` exists copy it too (`chmod 0o644`); else try `execFile("ssh-keygen", ["-y", "-P", "", "-f", destPath])` and write stdout to `<dest>.pub` (0o644); on derive failure return `{ key, warning: "Imported, but the public key could not be derived (key may have a passphrase). Import the .pub file manually." }`.
- `deleteKey`: validate name, resolve inside dir, throw if the private key doesn't exist, unlink private + `.pub` (pub best-effort).

- [ ] **Step 1: Write the shared types file**

Create `src/shared/ssh-keys.ts` with exactly the interface block above (plus a brief header comment: shared between main and renderer, key discovery is main-side only).

- [ ] **Step 2: Write the failing test script**

Create `scripts/test-ssh-keys.cjs` following the repo pattern in `scripts/test-fs-sandbox.cjs`: esbuild-bundle the TS module into a temp `.cjs`, `require` it, run assertions with a tiny `check(name, fn)` harness that prints `ok <name>` / `FAIL <name>` and exits 1 on any failure.

```js
// Tests for src/main/remote/ssh-keys.ts against a temp dir standing in for
// ~/.ssh. Generation/import tests are skipped (with a notice) when ssh-keygen
// is not on PATH.
//
//   node scripts/test-ssh-keys.cjs

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const outFile = path.join(os.tmpdir(), `ssh-keys-under-test-${process.pid}.cjs`);
esbuild.buildSync({
  entryPoints: [path.join(ROOT, "src/main/remote/ssh-keys.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: outFile,
});
const mod = require(outFile);

let hasKeygen = true;
try {
  execFileSync("ssh-keygen", ["-?"], { stdio: "ignore" });
} catch (err) {
  // ssh-keygen -? exits non-zero but existing → ENOENT is the real signal.
  hasKeygen = err.code !== "ENOENT";
}

const failures = [];
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`FAIL ${name}\n  ${err && err.message}`);
  }
}
function tmpSshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codara-ssh-keys-"));
}

(async () => {
  await check("listKeys returns [] for a missing dir", async () => {
    const keys = await mod.listKeys(path.join(os.tmpdir(), "codara-no-such-dir-xyz"));
    assert.deepStrictEqual(keys, []);
  });

  await check("listKeys parses a .pub and flags missing private half", async () => {
    const dir = tmpSshDir();
    fs.writeFileSync(
      path.join(dir, "deploy.pub"),
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPlaceholderPlaceholderPlaceholderPlacehold me@example\n",
    );
    fs.writeFileSync(path.join(dir, "known_hosts"), "ignored");
    fs.writeFileSync(path.join(dir, "config"), "ignored");
    const keys = await mod.listKeys(dir);
    assert.strictEqual(keys.length, 1);
    assert.strictEqual(keys[0].name, "deploy");
    assert.strictEqual(keys[0].type, "ssh-ed25519");
    assert.strictEqual(keys[0].comment, "me@example");
    assert.strictEqual(keys[0].hasPrivateKey, false);
    assert.ok(keys[0].publicKey.startsWith("ssh-ed25519 "));
  });

  await check("generateKey rejects invalid names", async () => {
    const dir = tmpSshDir();
    for (const bad of ["../evil", "a/b", "", "x..y", "name.pub"]) {
      await assert.rejects(() => mod.generateKey({ name: bad }, dir));
    }
  });

  await check("deleteKey rejects traversal and unknown names", async () => {
    const dir = tmpSshDir();
    await assert.rejects(() => mod.deleteKey("../outside", dir));
    await assert.rejects(() => mod.deleteKey("nope", dir));
  });

  if (hasKeygen) {
    await check("generateKey creates an ed25519 pair with 0600 perms", async () => {
      const dir = tmpSshDir();
      const key = await mod.generateKey({ name: "testkey", comment: "codara-test" }, dir);
      assert.strictEqual(key.name, "testkey");
      assert.strictEqual(key.hasPrivateKey, true);
      assert.ok(key.publicKey && key.publicKey.includes("ssh-ed25519"));
      assert.ok(key.fingerprint && key.fingerprint.includes("SHA256:"));
      if (process.platform !== "win32") {
        const mode = fs.statSync(path.join(dir, "testkey")).mode & 0o777;
        assert.strictEqual(mode, 0o600);
      }
    });

    await check("generateKey refuses to overwrite", async () => {
      const dir = tmpSshDir();
      await mod.generateKey({ name: "dupe" }, dir);
      await assert.rejects(() => mod.generateKey({ name: "dupe" }, dir), /already exists/);
    });

    await check("importKey copies with 0600 and derives the .pub", async () => {
      const srcDir = tmpSshDir();
      const dir = tmpSshDir();
      await mod.generateKey({ name: "movable" }, srcDir);
      fs.rmSync(path.join(srcDir, "movable.pub")); // force the -y derive path
      const result = await mod.importKey(path.join(srcDir, "movable"), dir);
      assert.strictEqual(result.key.name, "movable");
      assert.strictEqual(result.key.hasPrivateKey, true);
      assert.ok(result.key.publicKey, "expected derived public key");
      if (process.platform !== "win32") {
        const mode = fs.statSync(path.join(dir, "movable")).mode & 0o777;
        assert.strictEqual(mode, 0o600);
      }
    });

    await check("importKey rejects non-key files", async () => {
      const dir = tmpSshDir();
      const junk = path.join(tmpSshDir(), "notes.txt");
      fs.writeFileSync(junk, "hello");
      await assert.rejects(() => mod.importKey(junk, dir), /Not a private key/);
    });

    await check("deleteKey removes both halves", async () => {
      const dir = tmpSshDir();
      await mod.generateKey({ name: "gone" }, dir);
      await mod.deleteKey("gone", dir);
      assert.ok(!fs.existsSync(path.join(dir, "gone")));
      assert.ok(!fs.existsSync(path.join(dir, "gone.pub")));
    });
  } else {
    console.log("skip: ssh-keygen not found — generation/import/delete tests skipped");
  }

  if (failures.length) {
    console.error(`\n${failures.length} failing`);
    process.exit(1);
  }
  console.log("\nall ssh-keys tests passed");
})();
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node scripts/test-ssh-keys.cjs`
Expected: esbuild fails with "Could not resolve … src/main/remote/ssh-keys.ts" (module doesn't exist yet).

- [ ] **Step 4: Implement `src/main/remote/ssh-keys.ts`**

Implement to the behavior contract above. Skeleton:

```ts
import { promises as fs } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isValidKeyName, type SshKeyImportResult, type SshKeyInfo } from "@shared/ssh-keys";

// Local SSH key management for the SSH manager's Keys tab. Everything is
// confined to the ssh dir (default ~/.ssh); key names are validated filenames,
// never paths. ssh-keygen does the crypto so the resulting files are standard.

const run = promisify(execFile);

const WELL_KNOWN_PRIVATE = ["id_rsa", "id_ecdsa", "id_ed25519"];
const IGNORED = new Set(["config", "authorized_keys", "environment"]);

function sshDir(dir?: string): string {
  return dir ?? join(homedir(), ".ssh");
}

function assertValidName(name: string): void {
  if (!isValidKeyName(name)) throw new Error("Invalid key name.");
}
```

Then `listKeys`, `generateKey`, `importKey`, `deleteKey` per the contract. Details that matter:
- `listKeys` skips filenames starting with `known_hosts` and anything in `IGNORED`.
- Fingerprint: `const { stdout } = await run("ssh-keygen", ["-lf", pubPath])` → second whitespace field is the `SHA256:…` token; wrap in try/catch → null.
- `generateKey` failure: catch the execFile error and rethrow `new Error(String((err as { stderr?: string }).stderr || err))` so the dialog can show stderr.
- Never log the passphrase; do not include it in thrown messages.
- Check `@shared` path alias works from `src/main` (other main files import `@shared/remote` — same pattern).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node scripts/test-ssh-keys.cjs`
Expected: all `ok`, exit 0 (on a Mac dev machine ssh-keygen exists, so nothing skips).

- [ ] **Step 6: Register the npm script and typecheck**

Add to `package.json` scripts: `"test:ssh-keys": "node scripts/test-ssh-keys.cjs"`.
Run: `npm run typecheck:node`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/shared/ssh-keys.ts src/main/remote/ssh-keys.ts scripts/test-ssh-keys.cjs
git add -p package.json   # stage ONLY the test:ssh-keys script line; package.json has unrelated dirty hunks
git commit -m "feat: ssh key management module (list/generate/import/delete) with tests"
```

---

### Task 6: IPC + preload wiring for ssh keys and a key-file picker

**Files:**
- Modify: `src/main/ipc.ts` (add handlers next to the `remote:*` block, ~:3238–3281; key-file picker next to `dialog:openImages`, ~:1380)
- Modify: `src/preload/index.ts` (add `sshKeys` block next to `remote`, ~:1258–1290; add `openSshKey` inside `dialog`, ~:553)

**Interfaces:**
- Consumes: `listKeys/generateKey/importKey/deleteKey` from `src/main/remote/ssh-keys.ts`; types from `@shared/ssh-keys`.
- Produces (renderer-visible):

```ts
window.spark.sshKeys.list(): Promise<SshKeyInfo[]>
window.spark.sshKeys.generate(opts: { name: string; passphrase?: string; comment?: string }): Promise<SshKeyInfo>
window.spark.sshKeys.import(sourcePath: string): Promise<SshKeyImportResult>
window.spark.sshKeys.delete(name: string): Promise<void>
window.spark.dialog.openSshKey(): Promise<string | null>   // native file picker, defaultPath ~/.ssh
```

- [ ] **Step 1: Main handlers**

In `src/main/ipc.ts`, directly after the `remote:detectAgents` handler (~:3281), add:

```ts
// SSH key management for the SSH manager's Keys tab. Confined to ~/.ssh by
// the module itself; the renderer never passes paths for list/generate/delete.
handle("sshKeys:list", async (): Promise<SshKeyInfo[]> => listSshKeys());
handle(
  "sshKeys:generate",
  async (
    _e,
    opts: { name: string; passphrase?: string; comment?: string },
  ): Promise<SshKeyInfo> => generateSshKey(opts),
);
handle(
  "sshKeys:import",
  async (_e, sourcePath: string): Promise<SshKeyImportResult> => importSshKey(sourcePath),
);
handle("sshKeys:delete", async (_e, name: string): Promise<void> => deleteSshKey(name));
```

with imports at the top of `ipc.ts` (alias to avoid collisions with any same-named locals):

```ts
import {
  listKeys as listSshKeys,
  generateKey as generateSshKey,
  importKey as importSshKey,
  deleteKey as deleteSshKey,
} from "./remote/ssh-keys";
import type { SshKeyImportResult, SshKeyInfo } from "@shared/ssh-keys";
```

Then after `dialog:openImages` (~:1394) add:

```ts
handle("dialog:openSshKey", async (e): Promise<string | null> => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const result = await dialog.showOpenDialog(win!, {
    title: "Import SSH key",
    properties: ["openFile", "showHiddenFiles"],
    defaultPath: join(app.getPath("home"), ".ssh"),
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});
```

(`join` is already imported in `ipc.ts`; verify, otherwise import from `node:path`.)

- [ ] **Step 2: Preload bridge**

In `src/preload/index.ts`, inside the `dialog: {` block (~:553) add:

```ts
openSshKey: (): Promise<string | null> => ipcRenderer.invoke("dialog:openSshKey"),
```

After the `remote: { ... }` block (~:1290) add a sibling:

```ts
// SSH key management (SSH manager → Keys tab). Paths never leave ~/.ssh
// except the import source, which comes from the native file picker.
sshKeys: {
  list: (): Promise<SshKeyInfo[]> => ipcRenderer.invoke("sshKeys:list"),
  generate: (opts: { name: string; passphrase?: string; comment?: string }): Promise<SshKeyInfo> =>
    ipcRenderer.invoke("sshKeys:generate", opts),
  import: (sourcePath: string): Promise<SshKeyImportResult> =>
    ipcRenderer.invoke("sshKeys:import", sourcePath),
  delete: (name: string): Promise<void> => ipcRenderer.invoke("sshKeys:delete", name),
},
```

with `import type { SshKeyImportResult, SshKeyInfo } from "@shared/ssh-keys";` at the top. Renderer typing flows automatically (`preload-types.d.ts` re-exports `SparkApi` from this file).

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck:node && npm run typecheck:web`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -p src/main/ipc.ts src/preload/index.ts   # both files carry unrelated dirty hunks — stage only the sshKeys/openSshKey additions
git commit -m "feat: IPC + preload bridge for ssh key management and key-file picker"
```

---

### Task 7: SshManagerDialog shell + Servers tab (replaces RemoteConnectDialog)

**Files:**
- Create: `src/renderer/src/components/remote/BrowsePane.tsx` (extracted from RemoteConnectDialog)
- Create: `src/renderer/src/components/remote/SshManagerDialog.tsx`
- Delete: `src/renderer/src/components/remote/RemoteConnectDialog.tsx`
- Modify: `src/renderer/src/App.tsx` (render site ~:5465–5470)

**Interfaces:**
- Consumes: `window.spark.remote.*` (listHosts/saveHost/deleteHost/connect/status/browse/onStatus — signatures in `src/preload/index.ts:1258–1290`), `window.spark.sshKeys.list` (Task 6), types from `@shared/remote`, `makeRemotePath`/`isValidHostId`.
- Produces:

```tsx
// BrowsePane.tsx
export default function BrowsePane(props: {
  status: RemoteConnectionStatus | null;
  browse: RemoteBrowseResult | null;
  browsing: boolean;
  onUp: () => void;
  onOpen: (path: string) => void;
  onBack: () => void;
  onChoose: () => void;
}): JSX.Element;

// SshManagerDialog.tsx
export default function SshManagerDialog(props: {
  onClose: () => void;
  /** Chosen host + absolute POSIX path → App turns it into an ssh:// workspace. */
  onPick: (host: RemoteHostConfig, remotePath: string) => void;
}): JSX.Element;
```

Task 8 adds `<KeysTab />` into the shell built here; the shell must render tab state `"servers" | "keys"` from this task with a placeholder Keys tab (`<div style={{ color: "var(--muted)", fontSize: 12, padding: 8 }}>Keys tab arrives in the next task.</div>`).

- [ ] **Step 1: Extract BrowsePane**

Create `BrowsePane.tsx`: move `BrowsePane` and `PaneMsg` verbatim from `RemoteConnectDialog.tsx` (lines ~319–424), `export default BrowsePane`, keep `PaneMsg` private, import the two types from `@shared/remote`. Also export `PaneMsg`-style message div is not needed elsewhere — keep private.

- [ ] **Step 2: Build the dialog shell**

`SshManagerDialog.tsx` structure (reuse the overlay/scrim pattern from the old dialog VERBATIM — including its "NO backdrop-filter on this overlay" comment, which documents the same backdrop-root trap this whole feature keeps hitting):

```tsx
export default function SshManagerDialog({ onClose, onPick }: Props) {
  const [tab, setTab] = useState<"servers" | "keys">("servers");
  // ...servers state from Step 3...
  return (
    <div role="dialog" aria-modal="true" aria-label="SSH manager" onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 350, display: "flex",
        alignItems: "center", justifyContent: "center", background: "transparent" }}>
      <div className="spark-scrim" style={{ position: "absolute", inset: 0, zIndex: 0 }} />
      <div className="spark-glass" onClick={(e) => e.stopPropagation()}
        style={{ position: "relative", zIndex: 1, width: 640, maxWidth: "94vw",
          height: "min(560px, 84vh)", padding: 20, borderRadius: 12,
          display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span className="spark-eyebrow" style={{ color: "var(--accent)" }}>SSH</span>
          <TabButton label="Servers" active={tab === "servers"} onClick={() => setTab("servers")} />
          <TabButton label="Keys" active={tab === "keys"} onClick={() => setTab("keys")} />
          <span style={{ flex: 1 }} />
          <button type="button" className="spark-btn" onClick={onClose}>Close</button>
        </div>
        {tab === "servers" ? <ServersTab onPick={onPick} /> : <KeysPlaceholder />}
      </div>
    </div>
  );
}

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" className={active ? "spark-btn is-primary" : "spark-btn"}
      style={{ fontSize: 12, padding: "3px 12px" }} onClick={onClick}>
      {label}
    </button>
  );
}
```

- [ ] **Step 3: ServersTab**

Port the old dialog's state machine into `ServersTab` (private component in the same file), with these upgrades over the old `HostList`:

1. **List**: same row layout, but the `· ssh config` suffix becomes a small badge (`<span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 999, border: "1px solid var(--rule)", color: "var(--muted)" }}>ssh config</span>`), and manual hosts get an **Edit** `spark-btn` that opens the form pre-filled.
2. **Form** (`HostForm`, ported from `AddHostForm`): add an `initial?: RemoteHostConfig` prop; when set, the Name field is disabled (id is identity) and the duplicate-id check skips itself; add an identity picker: next to the "Private key (optional)" input a `spark-btn` "Choose…" listing keys via `window.spark.sshKeys.list()` in a `<select className="spark-input">` (options = `privateKeyPath`, plus a "Custom path…" option that leaves the free-text input authoritative). Keep the free-text input as the source of truth (`identityFile`).
3. **Test connection**: per-host `spark-btn` "Test" → `setTestState(host.id, "connecting")`, `await window.spark.remote.connect(host.id)`, show result inline in the row (`connected` → green check + "connected", `error` → `status.error` in `var(--danger)`, 11px). Subscribe once in `ServersTab` to `window.spark.remote.onStatus` to keep the shown state live. Auth prompts during connect are handled by the global `RemoteAuthPrompt` already mounted in App — nothing to do here.
4. **Open as workspace…**: per-host primary button → switches ServersTab into the browse stage exactly like the old `connectAndBrowse` (state, `BrowsePane` import from the new file, `onChoose` → `onPick(host, browse.path)`). Port `connectAndBrowse`/`navigate` verbatim.
5. Empty state: "No SSH hosts yet. Add one below, or entries from ~/.ssh/config appear here automatically."

- [ ] **Step 4: Wire App.tsx and delete the old dialog**

In `App.tsx` ~:5465–5470 replace the `RemoteConnectDialog` element with:

```tsx
{remoteConnectOpen && (
  <SshManagerDialog
    onClose={() => setRemoteConnectOpen(false)}
    onPick={(host, remotePath) => {
      setRemoteConnectOpen(false);
      createRemoteWs(host, remotePath);
    }}
  />
)}
```

(match the existing props/callbacks at that site — the old element already does exactly this shape; keep its behavior, only the component changes). Update the import, then `git rm src/renderer/src/components/remote/RemoteConnectDialog.tsx`. Grep for any other `RemoteConnectDialog` references (there should be none).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck:web`
Expected: PASS.

- [ ] **Step 6: Visual check**

In the app: `+` → "New remote workspace (SSH)…" opens the manager; hosts list shows config hosts with the badge and no Edit/Remove; add a manual host, edit it, test connection (against a real or bogus host — bogus shows the error inline); Open as workspace browses and creates the ssh:// workspace; Keys tab shows the placeholder.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/components/remote/BrowsePane.tsx src/renderer/src/components/remote/SshManagerDialog.tsx src/renderer/src/App.tsx
git rm src/renderer/src/components/remote/RemoteConnectDialog.tsx
git commit -m "feat: SSH manager dialog with Servers tab, replacing RemoteConnectDialog"
```

---

### Task 8: Keys tab (list, generate, import, copy + setup helper)

**Files:**
- Create: `src/renderer/src/components/remote/SshKeysTab.tsx`
- Modify: `src/renderer/src/components/remote/SshManagerDialog.tsx` (replace `KeysPlaceholder` with `<SshKeysTab />`)

**Interfaces:**
- Consumes: `window.spark.sshKeys.list/generate/import` (Task 6), `window.spark.dialog.openSshKey` (Task 6), `SshKeyInfo` from `@shared/ssh-keys`, `navigator.clipboard.writeText`.
- Produces: `export default function SshKeysTab(): JSX.Element` (no props; Task 9 adds delete inside this file).

- [ ] **Step 1: Build the tab**

Layout: scrollable key list on top, action row ("Generate key", "Import key…") below, and an expandable setup-helper panel per key. Concrete structure:

```tsx
export default function SshKeysTab() {
  const [keys, setKeys] = useState<SshKeyInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);   // shows GenerateForm
  const [helperFor, setHelperFor] = useState<string | null>(null); // key name
  const [copiedFor, setCopiedFor] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void window.spark.sshKeys.list().then(setKeys).catch((e) => setError(String(e)));
  }, []);
  useEffect(refresh, [refresh]);
  // ...
}
```

**Key row**: name (bold, 13px), type + fingerprint in mono 11px muted, a "no private key" / "no public key" warning chip when one half is missing, and buttons: **Copy public key** (disabled when `publicKey` null; on click `navigator.clipboard.writeText(key.publicKey)`, set `copiedFor` for 1.5s → button label flips to "Copied ✓"), **Setup…** (toggles the helper panel).

**Setup helper panel** (rendered under the row when `helperFor === key.name`), copy written for a non-expert:

```tsx
<div style={{ padding: "10px 12px", borderRadius: 8, border: "1px solid var(--rule)", background: "var(--panel)", display: "grid", gap: 8, fontSize: 12 }}>
  <div style={{ color: "var(--ink)" }}>
    Your <b>public</b> key is safe to share — paste it wherever the server or provider asks for an SSH key:
  </div>
  <ul style={{ margin: 0, paddingLeft: 18, color: "var(--muted)", display: "grid", gap: 4 }}>
    <li><b>DigitalOcean:</b> Settings → Security → “Add SSH Key” → paste, then pick it when creating a droplet.</li>
    <li><b>GitHub:</b> Settings → SSH and GPG keys → “New SSH key” → paste.</li>
    <li><b>Any server you can already reach:</b> run the command below on it (adds the key to that user’s authorized keys):</li>
  </ul>
  <CopyableCode text={`echo '${key.publicKey}' >> ~/.ssh/authorized_keys`} />
  <div style={{ color: "var(--muted-2)", fontSize: 11 }}>
    Never share the private half ({key.name}) — it stays on this machine.
  </div>
</div>
```

`CopyableCode`: mono 11px `<code>` block with overflow-x auto and a small copy button (same copied-flash pattern).

**GenerateForm** (shown when `generating`): fields Name (default suggestion `id_ed25519` or, if taken, `id_ed25519_codara`), Passphrase (password input, optional, helper text "Optional — protects the key file; you'll be asked for it when connecting"), Comment (default `""` → module default). Submit → `setBusy(true)`, `window.spark.sshKeys.generate({ name, passphrase: passphrase || undefined, comment: comment || undefined })`, on success `refresh()` + close form + `setNotice("Key created. Use Setup… to install it on a server.")`, on error show `String(err)` inline (Electron wraps thrown errors; strip the `Error invoking remote method` prefix with `.replace(/^Error invoking remote method '[^']+': /, "")` — add a tiny `ipcErrorText(err)` helper and reuse it for import/delete too).

**Import button**: `const p = await window.spark.dialog.openSshKey(); if (!p) return;` → `window.spark.sshKeys.import(p)` → refresh; if `result.warning`, show it as the notice (amber `var(--warn, var(--muted))` color).

- [ ] **Step 2: Mount it**

In `SshManagerDialog.tsx`: `import SshKeysTab from "./SshKeysTab";`, replace `<KeysPlaceholder />` with `<SshKeysTab />`, delete `KeysPlaceholder`.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck:web`
Expected: PASS.

- [ ] **Step 4: Functional check**

In the app: Keys tab lists your real `~/.ssh` keys with fingerprints; generate a key named `codara_smoke_test` (verify it appears and `ls -la ~/.ssh` shows 0600); Copy public key puts the right line on the clipboard; Setup panel shows the echo command with the actual key inline; import a key file; delete the smoke-test files manually afterwards (`rm ~/.ssh/codara_smoke_test*`) since delete-from-UI arrives in Task 9.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/remote/SshKeysTab.tsx src/renderer/src/components/remote/SshManagerDialog.tsx
git commit -m "feat: SSH manager Keys tab — list, generate, import, copy + setup helper"
```

---

### Task 9: Key deletion (last, cuttable)

**Files:**
- Modify: `src/renderer/src/components/remote/SshKeysTab.tsx`

**Interfaces:**
- Consumes: `window.spark.sshKeys.delete(name)` (Task 6).

- [ ] **Step 1: Add delete with a real confirmation**

Per key row, a trailing "Delete" `RowMenuItem`-style button is overkill — use a small `spark-btn` with `color: var(--danger)`. Clicking sets `confirmDelete: string | null` (key name). When set, the row is replaced inline by a confirm strip:

```tsx
<div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderRadius: 8, border: "1px solid var(--danger)", background: "var(--danger-soft)" }}>
  <div style={{ flex: 1, fontSize: 12, color: "var(--ink)" }}>
    Delete <b>{key.name}</b> and its public key? Servers that trust this key will stop
    accepting logins with it — make sure you have another way in. This cannot be undone.
  </div>
  <button type="button" className="spark-btn" onClick={() => setConfirmDelete(null)}>Cancel</button>
  <button type="button" className="spark-btn" style={{ color: "var(--danger)" }}
    onClick={() => void doDelete(key.name)}>Delete key</button>
</div>
```

`doDelete`: `setBusy(true)` → `window.spark.sshKeys.delete(name)` → `setConfirmDelete(null)` + `refresh()`; errors through `ipcErrorText` into the tab's error line.

- [ ] **Step 2: Typecheck + functional check**

Run: `npm run typecheck:web` → PASS.
In the app: generate a throwaway key, delete it from the UI, confirm both files are gone from `~/.ssh` and the list refreshes. Confirm Cancel leaves files untouched.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/components/remote/SshKeysTab.tsx
git commit -m "feat: SSH key deletion with confirmation"
```

---

## Final verification (after all tasks)

- [ ] `npm run typecheck` — all three configs pass.
- [ ] `node scripts/test-ssh-keys.cjs` — passes.
- [ ] Full visual sweep in `npm run dev`: header `+` dropdown (3 items), right-click blank space, row menu inside/outside folders (identical glass), bottom-of-panel flip-up, SSH manager end-to-end (add host → test → browse → workspace created; generate key → copy → setup panel; import; delete).
- [ ] `git log --oneline` shows one commit per task; no unrelated dirty hunks were committed.
