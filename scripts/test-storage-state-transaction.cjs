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

    // An agent worktree's creator survives a save, bounded and cleaned; a
    // malformed creator is dropped rather than trusted.
    const withCreators = await storage.updateState((current) => ({
      ...current,
      workspaces: [
        ...current.workspaces,
        {
          id: "ws-agent-copy",
          name: "Agent copy",
          cwd: "/tmp/agent-copy",
          color: "#2AA298",
          workers: [],
          copyBranch: {
            repoCwd: "/tmp/repo",
            branch: "agent/x",
            city: "agent-x",
            mode: "fork",
            createdAt: "2026-10-12T00:00:00.000Z",
            createdBy: { kind: "agent", client: "claude\u0007code", purpose: "p".repeat(500), extra: "dropped" },
          },
        },
        {
          id: "ws-bad-creator",
          name: "Bad creator",
          cwd: "/tmp/bad-creator",
          color: "#2AA298",
          workers: [],
          copyBranch: {
            repoCwd: "/tmp/repo",
            branch: "y",
            city: "y",
            createdAt: "2026-10-12T00:00:00.000Z",
            createdBy: { kind: "robot" },
          },
        },
      ],
    }));
    const agentCopy = withCreators.workspaces.find((workspace) => workspace.id === "ws-agent-copy");
    assert.equal(agentCopy.copyBranch.createdBy.kind, "agent");
    assert.equal(agentCopy.copyBranch.createdBy.client, "claude code");
    assert.equal(agentCopy.copyBranch.createdBy.purpose.length, 200);
    assert.equal("extra" in agentCopy.copyBranch.createdBy, false);
    const badCreator = withCreators.workspaces.find((workspace) => workspace.id === "ws-bad-creator");
    assert.equal("createdBy" in badCreator.copyBranch, false, "an unknown creator kind is dropped");

    // A renderer save that crossed a main-process workspace edit in flight
    // carries the older list. Written as is it would undo the edit on disk
    // until the renderer saved again; reconciled, the edit stands.
    const clone = (value) => JSON.parse(JSON.stringify(value));
    const readDisk = () => JSON.parse(fs.readFileSync(path.join(blockedHome, "spark-state.json"), "utf8"));
    const mainAdded = {
      id: "ws-main-added",
      name: "Main added",
      cwd: "/tmp/main-added",
      color: "#2AA298",
      workers: [],
    };
    let staleRenderer = clone(await storage.loadState());
    await storage.updateState((current) => ({
      ...current,
      workspaces: [...current.workspaces, mainAdded],
      workspaceRailOrder: [...(current.workspaceRailOrder ?? []), mainAdded.id],
    }));
    let saved = await storage.saveState(staleRenderer, { fromRenderer: true });
    assert.ok(saved.workspaces.some((workspace) => workspace.id === mainAdded.id), "a stale save keeps main's new workspace");
    assert.ok(saved.workspaceRailOrder.includes(mainAdded.id), "and its rail entry");
    assert.ok(readDisk().workspaces.some((workspace) => workspace.id === mainAdded.id), "on disk too");
    // The renderer's echo after state:changed agrees and clears the entry, so
    // a later delete by the user is not undone.
    await storage.saveState(saved, { fromRenderer: true });
    saved = await storage.saveState(
      {
        ...saved,
        workspaces: saved.workspaces.filter((workspace) => workspace.id !== mainAdded.id),
        workspaceRailOrder: saved.workspaceRailOrder.filter((id) => id !== mainAdded.id),
      },
      { fromRenderer: true },
    );
    assert.ok(!saved.workspaces.some((workspace) => workspace.id === mainAdded.id), "a user delete after agreement stands");

    // A workspace main removed stays removed, and an active one hands focus
    // to what main chose.
    await storage.updateState((current) => ({ ...current, activeWorkspaceId: "ws-agent-copy" }));
    staleRenderer = clone(await storage.loadState());
    await storage.updateState((current) => ({
      ...current,
      workspaces: current.workspaces.filter((workspace) => workspace.id !== "ws-agent-copy"),
      workspaceRailOrder: (current.workspaceRailOrder ?? []).filter((id) => id !== "ws-agent-copy"),
      activeWorkspaceId: "ws-durable",
    }));
    saved = await storage.saveState(staleRenderer, { fromRenderer: true });
    assert.ok(!saved.workspaces.some((workspace) => workspace.id === "ws-agent-copy"), "a stale save cannot resurrect a removed workspace");
    assert.equal(saved.activeWorkspaceId, "ws-durable");

    // Entries expire, and saves from main itself are never rewritten.
    staleRenderer = clone(await storage.loadState());
    await storage.updateState((current) => ({
      ...current,
      workspaces: [...current.workspaces, { ...mainAdded, id: "ws-expired" }],
    }));
    const realNow = Date.now;
    Date.now = () => realNow() + 31_000;
    try {
      saved = await storage.saveState(staleRenderer, { fromRenderer: true });
    } finally {
      Date.now = realNow;
    }
    assert.ok(!saved.workspaces.some((workspace) => workspace.id === "ws-expired"), "an edit older than 30 s is not reapplied");
    await storage.updateState((current) => ({
      ...current,
      workspaces: [...current.workspaces, { ...mainAdded, id: "ws-main-only" }],
    }));
    saved = await storage.saveState(staleRenderer);
    assert.ok(!saved.workspaces.some((workspace) => workspace.id === "ws-main-only"), "only renderer saves are reconciled");

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
