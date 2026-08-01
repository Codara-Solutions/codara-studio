// A failed atomic state write must not publish speculative workspaces through
// storage's in-memory cache or state-saved listeners. The next queued save must
// still work, proving that one disk failure does not poison the write chain.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codara-state-transaction-"));
  const blockedHome = path.join(tempRoot, "blocked-home");
  const cacheDir = path.join(ROOT, "node_modules", ".cache");
  const outfile = path.join(cacheDir, `storage-state-transaction-${process.pid}.cjs`);
  const previousHome = process.env.CODARA_HOME_DIR;
  const previousSkipMigration = process.env.SPARK_SKIP_LEGACY_MIGRATION;
  fs.mkdirSync(cacheDir, { recursive: true });
  // A regular file cannot contain spark-state.json, so writeFileAtomic fails
  // deterministically with ENOTDIR.
  fs.writeFileSync(blockedHome, "not a directory", "utf8");
  process.env.CODARA_HOME_DIR = blockedHome;
  process.env.SPARK_SKIP_LEGACY_MIGRATION = "1";

  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    await esbuild.build({
      entryPoints: [path.join(ROOT, "src", "main", "storage.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile,
      alias: { "@shared": path.join(ROOT, "src", "shared") },
      external: ["electron"],
      logLevel: "silent",
    });
    delete require.cache[outfile];
    const storage = require(outfile);

    const initial = await storage.loadState();
    const speculative = {
      workspaces: [
        {
          id: "ws-speculative",
          name: "Speculative",
          cwd: "/tmp/speculative",
          color: "#2AA298",
          workers: [],
        },
      ],
      workspaceGroups: [],
      workspaceRailOrder: ["ws-speculative"],
      activeWorkspaceId: "ws-speculative",
    };
    const notifications = [];
    storage.onStateSaved((state) => notifications.push(state));

    await assert.rejects(storage.saveState(speculative));
    assert.deepEqual(
      await storage.loadState(),
      initial,
      "a failed disk write must leave loadState on the last durable cache",
    );
    assert.equal(
      notifications.length,
      0,
      "a failed disk write must not notify state-saved subscribers",
    );

    fs.unlinkSync(blockedHome);
    fs.mkdirSync(blockedHome);
    const durable = {
      ...speculative,
      workspaces: [{ ...speculative.workspaces[0], id: "ws-durable", name: "Durable" }],
      workspaceRailOrder: ["ws-durable"],
      activeWorkspaceId: "ws-durable",
    };
    await storage.saveState(durable);
    assert.deepEqual(await storage.loadState(), durable);
    assert.equal(notifications.length, 1, "the next queued save still publishes once");
    assert.deepEqual(notifications[0], durable);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(blockedHome, "spark-state.json"), "utf8")),
      durable,
      "the successful queued snapshot is the one on disk",
    );

    let releaseFirstUpdate;
    let markFirstEntered;
    const firstEntered = new Promise((resolve) => {
      markFirstEntered = resolve;
    });
    const firstGate = new Promise((resolve) => {
      releaseFirstUpdate = resolve;
    });
    const firstUpdate = storage.updateState(async (current) => {
      markFirstEntered();
      await firstGate;
      return {
        ...current,
        workspaces: [
          ...current.workspaces,
          {
            id: "ws-atomic-a",
            name: "Atomic A",
            cwd: "/tmp/atomic-a",
            color: "#2AA298",
            workers: [],
          },
        ],
      };
    });
    await firstEntered;
    const secondUpdate = storage.updateState((current) => {
      assert.ok(
        current.workspaces.some((workspace) => workspace.id === "ws-atomic-a"),
        "a queued updater sees the preceding updater's durable snapshot",
      );
      return {
        ...current,
        workspaces: [
          ...current.workspaces,
          {
            id: "ws-atomic-b",
            name: "Atomic B",
            cwd: "/tmp/atomic-b",
            color: "#2AA298",
            workers: [],
          },
        ],
      };
    });
    releaseFirstUpdate();
    await Promise.all([firstUpdate, secondUpdate]);
    const afterAtomicUpdates = await storage.loadState();
    assert.ok(afterAtomicUpdates.workspaces.some((workspace) => workspace.id === "ws-atomic-a"));
    assert.ok(afterAtomicUpdates.workspaces.some((workspace) => workspace.id === "ws-atomic-b"));
    assert.equal(notifications.length, 3, "each durable atomic update publishes exactly once");

    await assert.rejects(
      storage.updateState((current) => {
        current.workspaces.push({
          id: "ws-leaked",
          name: "Must not leak",
          cwd: "/tmp/leaked",
          color: "#2AA298",
          workers: [],
        });
        throw new Error("updater failed");
      }),
    );
    assert.equal(
      (await storage.loadState()).workspaces.some((workspace) => workspace.id === "ws-leaked"),
      false,
      "a throwing updater cannot mutate the durable cache by reference",
    );

    console.log("All storage state transaction checks passed.");
  } finally {
    console.error = originalConsoleError;
    if (previousHome === undefined) delete process.env.CODARA_HOME_DIR;
    else process.env.CODARA_HOME_DIR = previousHome;
    if (previousSkipMigration === undefined) delete process.env.SPARK_SKIP_LEGACY_MIGRATION;
    else process.env.SPARK_SKIP_LEGACY_MIGRATION = previousSkipMigration;
    fs.rmSync(outfile, { force: true });
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
