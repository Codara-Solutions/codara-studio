// Unit tests for the notification-center store (src/main/notify/center-store.ts):
// mutations, persistence, mutes, the summary push and the launch-time
// clean-up. The module pulls in Electron, ../preferences-store and
// ../codara-home, so we esbuild-bundle it with those resolved to tiny
// headless stubs (one fake window records the summary pushes, preferences
// say osCues on, codara-home points at a throwaway temp dir per scenario).
// fs-atomic is pure node and bundles as-is, so the debounced atomic writer is
// exercised for real and we assert against the files it writes.
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

// Each bundle() is a fresh module instance reading globalThis.__centerHome,
// so every scenario gets its own temp home and never touches codaraHome().
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "notify-center-test-"));
let homeSeq = 0;
function freshHome() {
  homeSeq += 1;
  const dir = path.join(TMP_ROOT, `home-${homeSeq}`);
  fs.mkdirSync(dir);
  globalThis.__centerHome = dir;
  return dir;
}

globalThis.__centerPushes = [];

const stubPlugin = {
  name: "center-store-test-harness",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
    build.onResolve({ filter: /^electron$/ }, () => ({ path: "electron-stub", namespace: "stub" }));
    build.onResolve({ filter: /\/codara-home$/ }, () => ({ path: "codara-home-stub", namespace: "stub" }));
    build.onResolve({ filter: /\/preferences-store$/ }, () => ({ path: "preferences-stub", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, (args) => {
      if (args.path === "electron-stub") {
        return {
          contents: `
            export const app = { setBadgeCount() {}, getBadgeCount() { return 0; } };
            const win = {
              isDestroyed: () => false,
              webContents: { send: (channel, payload) => globalThis.__centerPushes.push({ channel, payload }) },
            };
            export const BrowserWindow = { getAllWindows: () => [win] };`,
          loader: "js",
        };
      }
      if (args.path === "codara-home-stub") {
        return { contents: `export const codaraHome = () => globalThis.__centerHome;`, loader: "js" };
      }
      return { contents: `export const getPreferenceCached = () => ({ osCues: true });`, loader: "js" };
    });
  },
};

let bundled = null;
async function bundle() {
  if (!bundled) {
    const out = await esbuild.build({
      entryPoints: [CENTER_TS],
      bundle: true,
      format: "cjs",
      platform: "node",
      write: false,
      plugins: [stubPlugin],
      logLevel: "silent",
    });
    bundled = out.outputFiles[0].text;
  }
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", "require", bundled)(mod, mod.exports, require);
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

const MIN = 60_000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

function entry(id, read, fields = {}) {
  return {
    id,
    kind: "run.complete",
    sourceKey: `run:r-${id}`,
    title: `Entry ${id}`,
    body: "body",
    tone: "success",
    target: { type: "run", runId: `r-${id}`, workspaceId: "w1" },
    createdAt: ago(10 * MIN),
    read: Boolean(read),
    ...fields,
  };
}

function event(id, fields = {}) {
  const { read: _read, ...rest } = entry(id, false, { createdAt: ago(0), ...fields });
  return rest;
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

async function mutations() {
  const home = freshHome();
  const file = path.join(home, "notifications.json");
  fs.writeFileSync(
    file,
    JSON.stringify([
      entry("c", false, { createdAt: ago(1 * MIN) }),
      entry("a", true, { createdAt: ago(2 * MIN) }),
      entry("b", false, { createdAt: ago(3 * MIN) }),
    ]),
  );
  const store = await bundle();

  await store.removeCenterEntry("a");
  await store.flushNotificationCenter();
  let live = await store.listCenterEntries();
  const persisted = readJson(file);
  check("removes the target entry from memory", live.map((e) => e.id).join(",") === "c,b");
  check("removal persists to notifications.json", persisted.map((e) => e.id).join(",") === "c,b");
  check("the file is written compact", !fs.readFileSync(file, "utf8").includes("\n"));

  let threw = false;
  try {
    await store.removeCenterEntry("does-not-exist");
  } catch {
    threw = true;
  }
  live = await store.listCenterEntries();
  check("no-op when id is absent (no throw)", !threw);
  check("absent-id removal leaves the list unchanged", live.map((e) => e.id).join(",") === "c,b");

  await store.setCenterRead(["b"], true);
  live = await store.listCenterEntries();
  check("mark read flips one row", live.find((e) => e.id === "b").read === true);
  await store.setCenterRead(["b"], false);
  live = await store.listCenterEntries();
  check("mark unread flips it back", live.find((e) => e.id === "b").read === false);

  const snapshot = await store.listCenterEntries();
  await store.clearCenter();
  check("clear empties the list", (await store.listCenterEntries()).length === 0);
  await store.restoreCenterEntries(snapshot);
  check(
    "undo restores the cleared rows in order",
    (await store.listCenterEntries()).map((e) => e.id).join(",") === "c,b",
  );

  const terminalBase = {
    sourceKey: "pane:p1",
    title: "Claude Code",
    body: "body",
    soundKind: "done",
    target: { type: "terminal", workspaceId: "w1", tabId: "t1", paneId: "p1" },
  };
  await store.recordToCenter(
    { ...terminalBase, id: "terminal-done", kind: "terminal.agent.done", tone: "success", createdAt: ago(0) },
    { read: false },
  );
  await store.recordToCenter(
    {
      ...terminalBase,
      id: "terminal-blocked",
      kind: "terminal.agent.needs-input",
      tone: "warning",
      soundKind: "needs-you",
      createdAt: ago(0),
    },
    { read: false },
  );
  live = await store.listCenterEntries();
  check(
    "terminal history keeps only the newest state per pane",
    live.filter((e) => e.sourceKey === "pane:p1").map((e) => e.id).join(",") === "terminal-blocked",
  );

  for (let i = 0; i < 5; i += 1) {
    await store.recordToCenter(event(`push-${i}`, { kind: "git.teammate-push", sourceKey: "github-push:acme/api" }), {
      read: false,
    });
  }
  live = await store.listCenterEntries();
  const pushes = live.filter((e) => e.sourceKey === "github-push:acme/api");
  check("repeated pushes fold into one row with a count", pushes.length === 1 && pushes[0].count === 5);

  const summary = await store.centerSummary();
  check("summary counts unread rows", summary.unread === 4);
  check("summary badge counts only open questions", summary.needsYou === 1);
  const pushed = globalThis.__centerPushes.filter((p) => p.channel === "notify:center-updated");
  check(
    "every change pushes the summary to the windows",
    pushed.length > 0 && pushed[pushed.length - 1].payload.needsYou === 1,
  );

  await store.settleCenterSource("pane:p1");
  check("settling the pane drops the badge", (await store.centerSummary()).needsYou === 0);
  await store.flushNotificationCenter();
}

async function recordBeforeLoad() {
  const home = freshHome();
  const file = path.join(home, "notifications.json");
  fs.writeFileSync(file, JSON.stringify([entry("old", false)]));
  const store = await bundle();
  // Nothing has awaited the load yet: the record must queue behind it.
  const pending = store.recordToCenter(event("fresh", { sourceKey: "run:fresh" }), { read: false });
  await store.flushNotificationCenter();
  await pending;
  const ids = readJson(file).map((e) => e.id).join(",");
  check("a record raised before the load lands beside the loaded rows", ids === "fresh,old");
}

async function corruptFile() {
  const home = freshHome();
  const file = path.join(home, "notifications.json");
  fs.writeFileSync(file, "[{not json");
  const store = await bundle();
  check("a corrupt history loads empty", (await store.listCenterEntries()).length === 0);
  const backups = fs.readdirSync(home).filter((name) => name.startsWith("notifications.json.corrupt-"));
  check("the corrupt file is kept as a backup", backups.length === 1);
  check(
    "the backup holds the original bytes",
    backups.length === 1 && fs.readFileSync(path.join(home, backups[0]), "utf8") === "[{not json",
  );
}

async function loadCleanup() {
  const home = freshHome();
  const file = path.join(home, "notifications.json");
  const pane = { type: "terminal", workspaceId: "w1", tabId: "t", paneId: "p" };
  fs.writeFileSync(
    file,
    JSON.stringify([
      entry("prompt", false, { kind: "terminal.agent.needs-input", sourceKey: "pane:p", target: pane }),
      entry("run-q", false, { kind: "run.blocked", sourceKey: "run:q" }),
      entry("gone-q", false, {
        kind: "run.blocked",
        sourceKey: "run:g",
        target: { type: "run", runId: "g", workspaceId: "w-deleted" },
      }),
      entry("ancient", false, { createdAt: ago(40 * 24 * 60 * MIN) }),
      { id: "broken", kind: "run.complete" },
      entry("dup-1", false, { sourceKey: "github-push:x", kind: "git.teammate-push", createdAt: ago(20 * MIN) }),
      entry("dup-2", false, { sourceKey: "github-push:x", kind: "git.teammate-push", createdAt: ago(30 * MIN) }),
    ]),
  );
  const store = await bundle();
  let live = await store.listCenterEntries();
  const byId = new Map(live.map((e) => [e.id, e]));
  check("a prompt from the previous session is settled at launch", byId.get("prompt").settled === true);
  check("a Cora question survives a restart open", byId.get("run-q").settled === undefined);
  check("rows past the age limit are pruned at launch", !byId.has("ancient"));
  check("invalid rows are dropped at launch", !byId.has("broken"));
  check("old duplicate rows coalesce at launch", byId.get("dup-1").count === 2 && !byId.has("dup-2"));

  await store.noteCenterWorkspaces(["w1"]);
  live = await store.listCenterEntries();
  check(
    "the first workspace list settles questions from deleted workspaces",
    live.find((e) => e.id === "gone-q").settled === true,
  );
  check("only the open Cora question counts toward the badge", (await store.centerSummary()).needsYou === 1);

  await store.noteCenterWorkspaces([]);
  check("an empty workspace list never wipes the history", (await store.listCenterEntries()).length === live.length);
  await store.noteCenterWorkspaces(["w2"]);
  live = await store.listCenterEntries();
  check("deleting a workspace removes its rows", live.every((e) => e.target.workspaceId !== "w1"));
  await store.flushNotificationCenter();
}

async function mutesPersist() {
  const home = freshHome();
  let store = await bundle();
  const pushEvent = event("p", { sourceKey: "github-push:acme/api", target: { type: "workspace", workspaceId: "w1" } });
  check("nothing is muted at first", store.isEventMuted(pushEvent) === false);
  await store.muteCenterSource("workspace:w1", "api", 60 * MIN);
  check("a workspace mute silences its events", store.isEventMuted(pushEvent) === true);
  check(
    "another workspace is unaffected",
    store.isEventMuted({ ...pushEvent, target: { type: "workspace", workspaceId: "w2" } }) === false,
  );
  check("the summary lists the mute", (await store.centerSummary()).mutes.length === 1);
  await store.flushNotificationCenter();
  check("mutes persist to their own file", readJson(path.join(home, "notification-mutes.json")).length === 1);

  store = await bundle();
  await store.loadNotificationCenter();
  check("a mute survives a restart", store.isEventMuted(pushEvent) === true);
  await store.unmuteCenterSource("workspace:w1");
  check("unmute lifts it", store.isEventMuted(pushEvent) === false);
  await store.flushNotificationCenter();
}

async function main() {
  await mutations();
  await recordBeforeLoad();
  await corruptFile();
  await loadCleanup();
  await mutesPersist();

  fs.rmSync(TMP_ROOT, { recursive: true, force: true });

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
