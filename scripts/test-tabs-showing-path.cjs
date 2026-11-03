// Which tabs hold a worktree that is about to be removed
// (src/renderer/src/tabs/tabsShowingPath.ts and savedLayoutFilePaths in
// useTabs.ts) and their real paths in main (src/main/window-held.ts). The
// window answers main's held probe with these: an editor tab
// of any workspace on a file inside the folder keeps the folder, because its
// buffer may hold unsaved edits that no terminal, run or process list shows.
//
//   node scripts/test-tabs-showing-path.cjs

const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");

const harnessPlugin = {
  name: "tabs-showing-path-harness",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
    build.onResolve({ filter: /^react$/ }, (args) => ({ path: args.path, namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents:
        "export const useCallback = (fn) => fn;\n" +
        "export const useEffect = () => {};\n" +
        "export const useLayoutEffect = () => {};\n" +
        "export const useMemo = (fn) => fn();\n" +
        "export const useRef = (v) => ({ current: v });\n" +
        "export const useState = (v) => [typeof v === 'function' ? v() : v, () => {}];\n",
      loader: "js",
    }));
  },
};

async function main() {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-tabs-showing-path-"));
  try {
    const helperOut = path.join(outdir, "tabsShowingPath.cjs");
    const useTabsOut = path.join(outdir, "useTabs.cjs");
    for (const [entry, outfile] of [
      [path.join(ROOT, "src", "renderer", "src", "tabs", "tabsShowingPath.ts"), helperOut],
      [path.join(ROOT, "src", "renderer", "src", "tabs", "useTabs.ts"), useTabsOut],
    ]) {
      await esbuild.build({ entryPoints: [entry], bundle: true, platform: "node", format: "cjs", outfile, plugins: [harnessPlugin], logLevel: "silent" });
    }
    const { pathIsInside, tabsShowPathInside } = require(helperOut);

    const tree = "/home/u/.codarastudio/worktrees/repo/fix-login";
    const editor = (file) => ({ id: `e-${file}`, kind: "editor", title: path.basename(file), path: file, entry: { path: file, name: path.basename(file), isDir: false }, dirty: true });

    assert.equal(pathIsInside(`${tree}/src/a.ts`, [tree]), true);
    assert.equal(pathIsInside(tree, [tree]), true, "the folder itself");
    assert.equal(pathIsInside(`${tree}/`, [`${tree}/`]), true, "trailing slashes");
    assert.equal(pathIsInside(`${tree}-2/src/a.ts`, [tree]), false, "a sibling with the same prefix is not inside");
    assert.equal(pathIsInside("/", ["/"]), false, "the root never matches everything");
    assert.equal(pathIsInside("C:\\Users\\u\\wt\\a.ts", ["c:/users/u/wt"]), true, "Windows paths, either spelling");
    assert.equal(pathIsInside("/real/fix-login/a.ts", [tree, "/real/fix-login"]), true, "the real path counts too");

    assert.equal(tabsShowPathInside([editor(`${tree}/src/a.ts`)], [tree]), true, "an editor tab inside holds it");
    assert.equal(tabsShowPathInside([editor("/elsewhere/a.ts")], [tree]), false);
    assert.equal(tabsShowPathInside([editor(`${tree}/src/a.ts`)], []), false, "no folders asked, nothing held by path");
    assert.equal(
      tabsShowPathInside([{ id: "p", kind: "preview", title: "page", url: `file://${tree}/out/index.html` }], [tree]),
      true,
      "a preview of a file inside holds it",
    );
    assert.equal(tabsShowPathInside([{ id: "p", kind: "preview", title: "dev", url: "http://localhost:3000" }], [tree]), false);
    assert.equal(
      tabsShowPathInside([{ id: "t", kind: "terminal", title: "shell", root: { kind: "leaf", paneId: "x", cwd: tree }, activePaneId: "x" }], [tree]),
      false,
      "terminals are main's to count",
    );
    assert.equal(tabsShowPathInside([null, { kind: "editor" }], [tree]), false, "malformed tabs are skipped");

    const { tabFilePaths } = require(helperOut);
    assert.deepEqual(
      tabFilePaths([editor(`${tree}/a.ts`), { id: "p", kind: "preview", title: "page", url: "file:///srv/site/index%20page.html" }, { id: "c", kind: "chat", title: "Cora" }]),
      [`${tree}/a.ts`, "/srv/site/index page.html"],
      "editors and file previews, as the tabs spell them",
    );

    const store = new Map();
    global.window = { localStorage: { getItem: (key) => (store.has(key) ? store.get(key) : null), setItem: (key, value) => store.set(key, value) } };
    const { savedLayoutFilePaths } = require(useTabsOut);
    store.set("spark.tabs:ws-other", JSON.stringify({ v: 7, activeId: null, tabs: [editor(`${tree}/notes.md`)] }));
    assert.deepEqual(savedLayoutFilePaths("ws-other"), [`${tree}/notes.md`], "a saved editor tab of a workspace not opened yet");
    assert.deepEqual(savedLayoutFilePaths("ws-none"), [], "nothing saved");
    store.set("spark.tabs:ws-broken", "{not json");
    assert.deepEqual(savedLayoutFilePaths("ws-broken"), [], "a layout that cannot be read restores no tabs");
    store.set("spark.tabs:ws-old", JSON.stringify({ v: 3, activeId: null, tabs: [editor(`${tree}/notes.md`)] }));
    assert.deepEqual(savedLayoutFilePaths("ws-old"), [], "nor does one of a version it drops");
    console.log("tabs-showing-path: all checks passed");
  } finally {
    fs.rmSync(outdir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
