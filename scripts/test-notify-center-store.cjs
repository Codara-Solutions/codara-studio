// Unit tests for the notification-center store's mutation ops, focused on
// removeCenterEntry (src/main/notify/center-store.ts). The module pulls in
// Electron `app`, ./deliver, ../preferences-store and ./spark-home, so — like
// the policy harness — we esbuild-bundle it with those four resolved to tiny
// headless stubs (Electron app is a no-op badge sink, deliver has no window,
// preferences say osCues on, spark-home points at a throwaway temp dir).
// fs-atomic is pure node and bundles as-is, so the debounced atomic writer is
// exercised for real and we assert against the persisted notifications.json.
//
//   node scripts/test-notify-center-store.cjs
//
// Exits non-zero on any failed assertion.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARED_DIR = path.join(ROOT, "src", "shared");
const CENTER_TS = path.join(ROOT, "src", "main", "notify", "center-store.ts");

// A fresh temp home per run so the store reads/writes an isolated
// notifications.json and never touches the real sparkHome().
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "notify-center-test-"));
const CENTER_FILE = path.join(TMP_HOME, "notifications.json");

const stubPlugin = {
  name: "center-store-test-harness",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
    // Electron `app`: only setBadgeCount is touched (darwin badge mirror).
    build.onResolve({ filter: /^electron$/ }, () => ({
      path: "electron-stub",
      namespace: "stub",
    }));
    build.onResolve({ filter: /\/spark-home$/ }, () => ({
      path: "spark-home-stub",
      namespace: "stub",
    }));
    build.onResolve({ filter: /\/preferences-store$/ }, () => ({
      path: "preferences-stub",
      namespace: "stub",
    }));
    build.onResolve({ filter: /\/deliver$/ }, () => ({
      path: "deliver-stub",
      namespace: "stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => {
      if (args.path === "electron-stub") {
        return {
          contents: `export const app = { setBadgeCount() {}, getBadgeCount() { return 0; } };`,
          loader: "js",
        };
      }
      if (args.path === "spark-home-stub") {
        return { contents: `export const sparkHome = () => ${JSON.stringify(TMP_HOME)};`, loader: "js" };
      }
      if (args.path === "preferences-stub") {
        return {
          contents: `export const getPreferenceCached = () => ({ osCues: true });`,
          loader: "js",
        };
      }
      // deliver-stub: no active window in headless, so the renderer push
      // silently no-ops (matches production best-effort behaviour).
      return { contents: `export const activeWindow = () => null;`, loader: "js" };
    });
  },
};

async function bundle() {
  const out = await esbuild.build({
    entryPoints: [CENTER_TS],
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
    plugins: [stubPlugin],
    logLevel: "silent",
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", "require", out.outputFiles[0].text)(
    mod,
    mod.exports,
    require,
  );
  return mod.exports;
}

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  PASS ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}`);
  }
}

function entry(id, read) {
  return {
    id,
    kind: "run.complete",
    title: `Entry ${id}`,
    body: "body",
    tone: "success",
    target: { type: "run", runId: `r-${id}`, workspaceId: "w1" },
    createdAt: "2026-07-04T00:00:00.000Z",
    read: Boolean(read),
  };
}

async function main() {
  // Seed a store with three entries: b unread, a read, c unread.
  fs.writeFileSync(
    CENTER_FILE,
    JSON.stringify([entry("c", false), entry("a", true), entry("b", false)], null, 2),
  );

  const store = await bundle();

  // 1. Remove the middle (read) entry, then flush the debounced writer and
  //    assert it's gone from both memory and the persisted file.
  await store.removeCenterEntry("a");
  await store.flushNotificationCenter();
  let live = await store.listCenterEntries();
  const persisted = JSON.parse(fs.readFileSync(CENTER_FILE, "utf8"));
  check("removes the target entry from memory", live.map((e) => e.id).join(",") === "c,b");
  check("removal persists to notifications.json", persisted.map((e) => e.id).join(",") === "c,b");
  check("sibling entries keep their order/flags", live[0].id === "c" && live[1].id === "b");

  // 2. Removing an id that's already gone is a race-safe no-op (no throw, no
  //    mutation) — models auto-expiry / a double removal.
  let threw = false;
  try {
    await store.removeCenterEntry("does-not-exist");
  } catch {
    threw = true;
  }
  live = await store.listCenterEntries();
  check("no-op when id is absent (no throw)", !threw);
  check("absent-id removal leaves the list unchanged", live.map((e) => e.id).join(",") === "c,b");

  // 3. Removing an unread entry drops the unread tally (badge/summary source).
  const unreadBefore = (await store.listCenterEntries()).filter((e) => !e.read).length;
  await store.removeCenterEntry("b");
  await store.flushNotificationCenter();
  const unreadAfter = (await store.listCenterEntries()).filter((e) => !e.read).length;
  check("removing an unread entry lowers the unread count", unreadBefore === 2 && unreadAfter === 1);

  // 4. Manual terminal states coalesce per pane so one busy agent cannot fill
  //    the center, and a newer state replaces stale actionable copy.
  const terminalBase = {
    sourceKey: "pane:p1",
    title: "Claude Code",
    body: "body",
    soundKind: "done",
    target: { type: "terminal", workspaceId: "w1", tabId: "t1", paneId: "p1" },
  };
  await store.recordToCenter(
    {
      ...terminalBase,
      id: "terminal-done",
      kind: "terminal.agent.done",
      tone: "success",
      createdAt: "2026-07-04T00:01:00.000Z",
    },
    { read: false },
  );
  await store.recordToCenter(
    {
      ...terminalBase,
      id: "terminal-blocked",
      kind: "terminal.agent.needs-input",
      tone: "warning",
      soundKind: "needs-you",
      createdAt: "2026-07-04T00:02:00.000Z",
    },
    { read: false },
  );
  live = await store.listCenterEntries();
  check(
    "terminal history keeps only the newest state per pane",
    live.filter((e) => e.sourceKey === "pane:p1").map((e) => e.id).join(",") ===
      "terminal-blocked",
  );

  fs.rmSync(TMP_HOME, { recursive: true, force: true });

  if (failures > 0) {
    console.log(`\n${failures} center-store case(s) FAILED.`);
    process.exit(1);
  }
  console.log("\nAll center-store cases PASSED.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
