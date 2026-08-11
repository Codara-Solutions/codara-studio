// Harness for src/main/remote-access/: the pairing window (expiry, single
// use), the paired-device store (persistence, revocation, corrupt-file
// behavior), the firewall decision, RPC framing (length prefix, oversize
// rejection), and the RpcSession state machine over a fake duplex.
//
//   node scripts/test-remote-access.cjs
//
// The QR payload is additionally checked against the REAL phone parser
// (codara-mobile src/lib/remote/pairing-payload.ts) when that repo is
// checked out next to this one; interop with that parser is a hard
// contract, so a payload change that breaks the phone fails here first.
// No live relay, no sockets: everything below is in-process.

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const net = require("node:net");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const MOBILE_PARSER = path.resolve(
  ROOT,
  "..",
  "codara-mobile",
  "src",
  "lib",
  "remote",
  "pairing-payload.ts",
);
const MOBILE_RPC_TYPES = path.resolve(
  ROOT,
  "..",
  "codara-mobile",
  "src",
  "lib",
  "remote",
  "types.ts",
);
const MOBILE_STABLE_PORT = path.resolve(
  ROOT,
  "..",
  "codara-mobile",
  "worklet",
  "lib",
  "stable-port.js",
);

async function bundle(entry, outName) {
  const cacheDir = path.join(ROOT, "node_modules", ".cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const outfile = path.join(cacheDir, outName);
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    // Native addons must load from their installed package paths rather than
    // from inside the generated cache bundle, where require.addon cannot find
    // their prebuilds.
    external: ["sodium-native", "@hyperswarm/secret-stream", "ws"],
  });
  delete require.cache[outfile];
  return require(outfile);
}

let failures = 0;
const check = (name, cond, detail) => {
  if (!cond) {
    failures += 1;
    if (detail !== undefined)
      console.log(`     got: ${JSON.stringify(detail)}`);
  }
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

async function main() {
  const pairing = await bundle(
    path.join(ROOT, "src", "main", "remote-access", "pairing.ts"),
    "remote-access-pairing-test.cjs",
  );
  const rpc = await bundle(
    path.join(ROOT, "src", "main", "remote-access", "rpc.ts"),
    "remote-access-rpc-test.cjs",
  );
  const boardProjection = await bundle(
    path.join(
      ROOT,
      "src",
      "main",
      "remote-access",
      "board-projection.ts",
    ),
    "remote-access-board-projection-test.cjs",
  );
  {
    const empty = boardProjection.projectRemoteBoardRead({
      revision: 0,
      cards: [],
    });
    const sameEmpty = boardProjection.projectRemoteBoardRead({
      revision: 0,
      cards: [],
    });
    const changed = boardProjection.projectRemoteBoardRead({
      revision: 1,
      cards: [],
    });
    check(
      "bounded board projection gives an empty board a stable bounded revision",
      empty.revision === sameEmpty.revision &&
        empty.revision.length > 0 &&
        empty.revision.length <= 128 &&
        empty.board.cards.length === 0,
      { empty, sameEmpty },
    );
    check(
      "bounded board projection revision changes with the projected board",
      changed.revision !== empty.revision,
      { empty: empty.revision, changed: changed.revision },
    );
  }
  const workerTerminalControls = await bundle(
    path.join(
      ROOT,
      "src",
      "main",
      "remote-access",
      "worker-terminal-controls.ts",
    ),
    "worker-terminal-controls-test.cjs",
  );
  const identity = await bundle(
    path.join(ROOT, "src", "main", "remote-access", "identity.ts"),
    "remote-access-identity-test.cjs",
  );
  const localPolicy = await bundle(
    path.join(ROOT, "src", "main", "remote-access", "local-policy.ts"),
    "remote-access-local-policy-test.cjs",
  );
  const fileMutations = await bundle(
    path.join(ROOT, "src", "main", "remote-access", "file-mutations.ts"),
    "remote-access-file-mutations-test.cjs",
  );
  const imageUpload = await bundle(
    path.join(ROOT, "src", "main", "remote-access", "image-upload.ts"),
    "remote-access-image-upload-test.cjs",
  );
  const coraPolicy = await bundle(
    path.join(ROOT, "src", "main", "remote-access", "cora-policy.ts"),
    "remote-access-cora-policy-test.cjs",
  );
  const coraSendReceipts = await bundle(
    path.join(
      ROOT,
      "src",
      "main",
      "remote-access",
      "cora-send-receipts.ts",
    ),
    "remote-access-cora-send-receipts-test.cjs",
  );
  const coraMessagePolicy = await bundle(
    path.join(
      ROOT,
      "src",
      "main",
      "remote-access",
      "cora-message-policy.ts",
    ),
    "remote-access-cora-message-policy-test.cjs",
  );
  const coraHistoryDelta = await bundle(
    path.join(
      ROOT,
      "src",
      "main",
      "remote-access",
      "cora-history-delta.ts",
    ),
    "remote-access-cora-history-delta-test.cjs",
  );
  {
    const history = Array.from({ length: 50 }, (_, index) => ({
      id: `run-${index}`,
      workspaceId: "workspace-a",
      title: `Conversation ${index} ${"x".repeat(80)}`,
      status: "running",
      createdAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
      updatedAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
      messageCount: index,
      lastMessage: `message ${index} ${"y".repeat(120)}`,
      activeWorkers: 0,
    }));
    const cache = new coraHistoryDelta.CoraHistoryDeltaCache();
    const full = cache.project({ workspaceId: "workspace-a", runs: history });
    const unchanged = cache.project({
      workspaceId: "workspace-a",
      runs: history,
      ifRevision: full.revision,
      deltaVersion: 1,
    });
    const changedHistory = history.map((run, index) =>
      index === 17 ? { ...run, status: "blocked", activeWorkers: 1 } : run,
    );
    const changed = cache.project({
      workspaceId: "workspace-a",
      runs: changedHistory,
      ifRevision: full.revision,
      deltaVersion: 1,
    });
    const materialized = new Map(full.runs.map((run) => [run.id, run]));
    for (const run of changed.historyDelta?.upserts ?? []) {
      materialized.set(run.id, run);
    }
    const reconstructed = changed.historyDelta?.order.map((id) =>
      materialized.get(id),
    );
    check(
      "Cora history delta reconstructs the exact changed full projection",
      unchanged.notModified === true &&
        changed.historyDelta?.baseRevision === full.revision &&
        changed.historyDelta?.upserts.length === 1 &&
        JSON.stringify(reconstructed) === JSON.stringify(changedHistory) &&
        Buffer.byteLength(JSON.stringify(changed), "utf8") <
          Buffer.byteLength(JSON.stringify({ runs: changedHistory }), "utf8"),
      { unchanged, changed },
    );
    const unknownBase = cache.project({
      workspaceId: "workspace-a",
      runs: changedHistory,
      ifRevision: "not-retained",
      deltaVersion: 1,
    });
    const crossWorkspace = cache.project({
      workspaceId: "workspace-b",
      runs: changedHistory.map((run) => ({
        ...run,
        workspaceId: "workspace-b",
      })),
      ifRevision: full.revision,
      deltaVersion: 1,
    });
    check(
      "unknown and cross-workspace Cora history bases fall back to full",
      Array.isArray(unknownBase.runs) && Array.isArray(crossWorkspace.runs),
      { unknownBase, crossWorkspace },
    );
    for (let index = 0; index < 30; index += 1) {
      cache.project({
        workspaceId: `bounded-${index}`,
        runs: [
          {
            ...history[0],
            id: `bounded-run-${index}`,
            workspaceId: `bounded-${index}`,
          },
        ],
      });
    }
    check(
      "Cora history retained bases have bounded workspace and byte cost",
      cache.workspaceCountForTest() <= 24 &&
        cache.retainedBytesForTest() <= 4 * 1024 * 1024,
      {
        workspaces: cache.workspaceCountForTest(),
        bytes: cache.retainedBytesForTest(),
      },
    );
  }
  {
    const exactAscii = "a".repeat(coraMessagePolicy.CORA_MESSAGE_MAX_BYTES);
    const exactEmoji = "😀".repeat(
      coraMessagePolicy.CORA_MESSAGE_MAX_BYTES / 4,
    );
    check(
      "Cora message policy trims then accepts exact 16 KiB UTF-8 boundaries",
      coraMessagePolicy.normalizeCoraMessage(`  ${exactAscii}  `) ===
        exactAscii &&
        coraMessagePolicy.normalizeCoraMessage(exactEmoji) === exactEmoji,
    );
    for (const oversized of [
      `${exactAscii}a`,
      `${exactEmoji}😀`,
      "界".repeat(Math.floor(coraMessagePolicy.CORA_MESSAGE_MAX_BYTES / 3) + 1),
    ]) {
      let error;
      try {
        coraMessagePolicy.normalizeCoraMessage(oversized);
      } catch (cause) {
        error = cause;
      }
      check(
        "Cora message policy rejects over-limit UTF-8 input without truncation",
        error?.code === "CORA_MESSAGE_TOO_LARGE" &&
          error.actualBytes > coraMessagePolicy.CORA_MESSAGE_MAX_BYTES,
        error,
      );
    }
  }
  {
    const selected = coraPolicy.selectRemoteConversationRuns(
      [
        { id: "run-chat-1" },
        { id: "run-automation", automationId: "automation-1" },
        { id: "run-chat-2" },
      ],
      2,
    );
    check(
      "Cora history excludes automation runs before applying its page limit",
      selected.map((run) => run.id).join(",") === "run-chat-1,run-chat-2",
      selected,
    );
  }
  const fleetOverview = await bundle(
    path.join(ROOT, "src", "main", "remote-access", "fleet-overview.ts"),
    "remote-access-fleet-overview-test.cjs",
  );
  const subscriptionProfiles = await bundle(
    path.join(
      ROOT,
      "src",
      "main",
      "remote-access",
      "subscription-profile-projection.ts",
    ),
    "remote-access-subscription-profile-projection-test.cjs",
  );
  const nativeCliAccounts = await bundle(
    path.join(
      ROOT,
      "src",
      "main",
      "remote-access",
      "native-cli-account-projection.ts",
    ),
    "remote-access-native-cli-account-projection-test.cjs",
  );
  {
    const profileId = "11111111-1111-4111-8111-111111111111";
    const refreshableId = "22222222-2222-4222-8222-222222222222";
    const unavailableId = "33333333-3333-4333-8333-333333333333";
    const inspection = {
      snapshot: {
        profiles: [
          {
            id: profileId,
            provider: "openai-codex",
            label: "Codex work",
            identityFingerprint: "must-not-cross-remote-boundary",
            // The Settings card shows this address; a phone never does.
            accountEmail: "codex-user@must-not-cross.example",
          },
          {
            id: refreshableId,
            provider: "anthropic",
            label: "Claude refreshable",
          },
          {
            id: unavailableId,
            provider: "anthropic",
            label: "Claude unavailable",
          },
        ],
        defaults: {
          "openai-codex": profileId,
          anthropic: refreshableId,
        },
      },
      statuses: [
        {
          profileId,
          connected: true,
          expired: false,
          authFile: "/private/pi-agent/accounts/profile/auth.json",
        },
        {
          profileId: refreshableId,
          connected: true,
          expired: true,
          canRefresh: true,
          error: "refresh-secret and /private/auth/path",
          accountEmail: "claude-user@must-not-cross.example",
          accountFingerprint: "must-not-cross-remote-boundary",
        },
        {
          profileId: unavailableId,
          connected: false,
          expired: false,
        },
      ],
    };
    const cached = [
      {
        profileId,
        provider: "openai-codex",
        label: "Codex work",
        isDefault: true,
        status: "ok",
        checkedAt: "2026-07-31T08:00:00.000Z",
        windows: [
          {
            id: "short",
            label: "5-hour",
            scope: { kind: "general" },
            usedPercent: 20,
            remainingPercent: 80,
          },
          {
            id: "code-review",
            label: "Code review 7-day",
            scope: { kind: "code_review" },
            usedPercent: 100,
            remainingPercent: 0,
          },
        ],
        generalLimitReached: false,
        limitReached: true,
        message: "raw provider error must stay local",
        accountId: "vendor-account-id",
        token: "access-secret",
      },
      {
        profileId: refreshableId,
        provider: "anthropic",
        label: "Claude refreshable",
        isDefault: true,
        status: "ok",
        checkedAt: "2026-07-31T08:00:00.000Z",
        windows: [
          {
            id: "short",
            label: "5-hour",
            usedPercent: 10,
            remainingPercent: 90,
          },
        ],
        limitReached: false,
      },
    ];
    const projected = subscriptionProfiles.projectRemoteSubscriptionProfiles(
      inspection,
      cached,
    );
    check(
      "remote subscription usage ignores a dedicated code-review limit for normal chat",
      projected.find((entry) => entry.id === profileId)?.status ===
        "configured" &&
        projected.find((entry) => entry.id === profileId)?.usage
          ?.remainingPercent === 80 &&
        projected.find((entry) => entry.id === profileId)?.usage
          ?.limitReached === false,
      projected,
    );
    check(
      "expired-but-refreshable subscription credentials remain selectable",
      projected.find((entry) => entry.id === refreshableId)?.status ===
        "configured" &&
        projected.find((entry) => entry.id === refreshableId)?.usage
          ?.remainingPercent === 90,
      projected,
    );
    check(
      "remote subscription profiles omit cached quota for unavailable credentials",
      projected.find((entry) => entry.id === unavailableId)?.status ===
        "unavailable" &&
        projected.find((entry) => entry.id === unavailableId)?.usage ===
          undefined,
      projected,
    );
    const serialized = JSON.stringify(projected);
    check(
      "remote subscription projection allowlists fields and leaks no identity, path, token, or raw error",
      !serialized.includes("must-not-cross") &&
        !serialized.includes("@") &&
        !serialized.includes("accountEmail") &&
        !serialized.includes("/private/") &&
        !serialized.includes("refresh-secret") &&
        !serialized.includes("vendor-account") &&
        !serialized.includes("access-secret") &&
        !serialized.includes("raw provider error"),
      projected,
    );
    const staleOrFailed =
      subscriptionProfiles.projectRemoteSubscriptionProfiles(inspection, [
        {
          ...cached[0],
          status: "error",
          windows: [
            { id: "bad", label: "bad", usedPercent: 0, remainingPercent: 100 },
          ],
        },
      ]);
    check(
      "remote subscription projection ignores non-ok cached usage",
      staleOrFailed.find((profile) => profile.id === profileId)?.usage ===
        undefined,
      staleOrFailed,
    );
  }
  {
    const projected = nativeCliAccounts.projectRemoteNativeCliAccounts({
      runtimes: [
        {
          runtime: "claude",
          defaultProfileId: "personal",
          profiles: [
            {
              runtime: "claude",
              id: "personal",
              label: "Claude personal",
              managed: false,
              isDefault: true,
              connected: true,
              inUse: true,
              status: "connected",
              configDir: "/must-not-cross",
              token: "must-not-cross",
              // Local Settings shows the account's address and pairing digest;
              // the phone projection must drop both.
              email: "claude-user@must-not-cross.example",
              accountFingerprint: "must-not-cross-remote-boundary",
            },
          ],
        },
        {
          runtime: "codex",
          defaultProfileId: "11111111-1111-4111-8111-111111111111",
          profiles: [
            {
              runtime: "codex",
              id: "11111111-1111-4111-8111-111111111111",
              label: "Codex Max",
              managed: true,
              isDefault: true,
              connected: false,
              inUse: false,
              status: "unsafe",
              homeDir: "/must-not-cross",
              env: { OPENAI_API_KEY: "must-not-cross" },
              email: "codex-user@must-not-cross.example",
              accountFingerprint: "must-not-cross-remote-boundary",
            },
          ],
        },
      ],
    });
    const serialized = JSON.stringify(projected);
    check(
      "remote native CLI account projection exposes only opaque routing metadata",
      projected[0]?.runtime === "claude" &&
        projected[0]?.status === "connected" &&
        projected[1]?.runtime === "codex" &&
        projected[1]?.status === "unavailable" &&
        !serialized.includes("/must-not-cross") &&
        !serialized.includes("OPENAI_API_KEY") &&
        !serialized.includes("token") &&
        !serialized.includes("@") &&
        !serialized.includes("email") &&
        !serialized.includes("accountFingerprint") &&
        !serialized.includes("inUse"),
      projected,
    );
  }
  {
    const workspaces = [
      {
        id: "ws-1",
        name: "Studio",
        path: "/private/studio",
        color: "#123456",
        branch: "feature/mobile",
      },
      {
        id: "ws-2",
        name: "Website",
        path: "/private/website",
        color: "#abcdef",
      },
    ];
    const attempt = (id, status, overrides = {}) => ({
      id,
      status,
      workerTaskId: `task-${id}`,
      attemptNumber: 1,
      runtime: "claude",
      ...overrides,
    });
    const runs = [
      {
        id: "chat-old",
        workspaceId: "ws-1",
        status: "running",
        createdAt: "2026-07-30T08:00:00.000Z",
        updatedAt: "2026-07-30T08:10:00.000Z",
        workerAttempts: [
          attempt("active-1", "running", {
            model: "claude-opus-5",
            runtimeState: "working",
            runtimeActivity: "  Read src/main/remote-access/rpc.ts  ",
            startedAt: "2026-07-30T08:01:00.000Z",
          }),
          attempt("settled-1", "succeeded"),
        ],
        workerTasks: [
          { id: "task-active-1", title: "Audit remote transport" },
          { id: "task-settled-1", title: "Finished task" },
        ],
      },
      {
        id: "chat-latest",
        workspaceId: "ws-1",
        status: "blocked",
        createdAt: "2026-07-30T08:30:00.000Z",
        updatedAt: "2026-07-30T09:00:00.000Z",
        workerAttempts: [attempt("active-2", "finishing")],
        workerTasks: [{ id: "task-active-2", title: "Verify mobile cache" }],
      },
      {
        id: "automation-newest",
        workspaceId: "ws-1",
        automationId: "loom-1",
        status: "running",
        createdAt: "2026-07-30T09:30:00.000Z",
        updatedAt: "2026-07-30T10:00:00.000Z",
        workerAttempts: [
          attempt("loom-worker-1", "running"),
          attempt("loom-worker-2", "launching"),
        ],
        workerTasks: [
          { id: "task-loom-worker-1", title: "Automation pass" },
          { id: "task-loom-worker-2", title: "Automation verifier" },
        ],
      },
      {
        id: "chat-other",
        workspaceId: "ws-2",
        status: "complete",
        createdAt: "2026-07-30T07:00:00.000Z",
        updatedAt: "2026-07-30T07:30:00.000Z",
        workerAttempts: [],
        workerTasks: [],
      },
    ];
    const automations = [
      {
        id: "loom-1",
        name: "Nightly audit",
        input: { workspaceId: "ws-1" },
        state: { status: "running" },
      },
      { input: { workspaceId: "ws-1" }, state: { status: "blocked" } },
      { input: { workspaceId: "ws-1" }, state: { status: "paused" } },
      { input: { workspaceId: "ws-2" }, state: { status: "idle" } },
    ];
    const projection = fleetOverview.projectRemoteFleetOverview(
      workspaces,
      runs,
      automations,
    );
    check(
      "fleet projection excludes automation runs from every conversation aggregate",
      projection.workspaces[0]?.conversationCount === 2 &&
        projection.workspaces[0]?.latestConversation?.status === "blocked" &&
        projection.workspaces[0]?.latestConversation?.updatedAt ===
          "2026-07-30T09:00:00.000Z" &&
        projection.workspaces[0]?.activeConversationWorkers === 2,
      projection,
    );
    check(
      "fleet projection carries compact workspace identity and active automation counts",
      projection.workspaces[0]?.id === "ws-1" &&
        projection.workspaces[0]?.name === "Studio" &&
        projection.workspaces[0]?.color === "#123456" &&
        projection.workspaces[0]?.branch === "feature/mobile" &&
        projection.workspaces[0]?.activeAutomations === 2 &&
        !JSON.stringify(projection).includes("/private/"),
      projection,
    );
    check(
      "fleet projection exposes a path-free live agent roster across chats and automations",
      projection.agents.length === 4 &&
        projection.agents.some(
          (agent) =>
            agent.id === "active-1" &&
            agent.title === "Audit remote transport" &&
            agent.runtime === "claude" &&
            agent.model === "claude-opus-5" &&
            agent.runtimeState === "working" &&
            agent.runtimeActivity === "Read src/main/remote-access/rpc.ts" &&
            agent.automated !== true,
        ) &&
        projection.agents.some(
          (agent) =>
            agent.id === "loom-worker-1" &&
            agent.automated === true &&
            agent.automationId === "loom-1" &&
            agent.automationName === "Nightly audit",
        ) &&
        !JSON.stringify(projection.agents).includes("/private/"),
      projection.agents,
    );
    const oneRow = fleetOverview.projectRemoteFleetOverview(
      workspaces,
      runs,
      automations,
      { maxRows: 1 },
    );
    check(
      "fleet projection obeys its explicit row cap",
      oneRow.workspaces.length === 1 && oneRow.workspaces[0]?.id === "ws-1",
      oneRow,
    );
    const oneAgent = fleetOverview.projectRemoteFleetOverview(
      workspaces,
      runs,
      automations,
      { maxAgents: 1 },
    );
    check(
      "fleet projection obeys its explicit agent cap",
      oneAgent.agents.length === 1,
      oneAgent,
    );
    const hundredPlusAttempts = Array.from({ length: 120 }, (_, index) =>
      attempt(`scale-${index + 1}`, "running", {
        runtime: index % 2 ? "codex" : "claude",
      }),
    );
    const hundredPlus = fleetOverview.projectRemoteFleetOverview(
      workspaces,
      [
        {
          id: "scale-run",
          workspaceId: "ws-1",
          status: "running",
          createdAt: "2026-07-30T10:00:00.000Z",
          updatedAt: "2026-07-30T10:01:00.000Z",
          workerAttempts: hundredPlusAttempts,
          workerTasks: hundredPlusAttempts.map((entry, index) => ({
            id: entry.workerTaskId,
            title: `Scale worker ${index + 1}`,
          })),
        },
      ],
      [],
    );
    check(
      "fleet projection can supervise more than one hundred active agents in one bounded snapshot",
      hundredPlus.agents.length === 120 &&
        Buffer.byteLength(JSON.stringify(hundredPlus), "utf8") <=
          fleetOverview.REMOTE_FLEET_BUDGET_BYTES,
      {
        agents: hundredPlus.agents.length,
        bytes: Buffer.byteLength(JSON.stringify(hundredPlus), "utf8"),
      },
    );
    const emptyBytes = Buffer.byteLength(
      JSON.stringify({ workspaces: [] }),
      "utf8",
    );
    const byteBounded = fleetOverview.projectRemoteFleetOverview(
      workspaces,
      runs,
      automations,
      { maxBytes: emptyBytes + 1 },
    );
    check(
      "fleet projection applies a byte budget before adding a row",
      byteBounded.workspaces.length === 0,
      byteBounded,
    );
  }
  const stablePort = await bundle(
    path.join(ROOT, "src", "main", "remote-access", "stable-port.ts"),
    "remote-access-stable-port-test.cjs",
  );
  const remoteAccess = await bundle(
    path.join(ROOT, "src", "main", "remote-access", "index.ts"),
    "remote-access-lifecycle-test.cjs",
  );
  const remoteIndexSource = fs.readFileSync(
    path.join(ROOT, "src", "main", "remote-access", "index.ts"),
    "utf8",
  );
  const productionSource = fs.readFileSync(
    path.join(ROOT, "src", "main", "remote-access", "production.ts"),
    "utf8",
  );
  const runStoreSource = fs.readFileSync(
    path.join(ROOT, "src", "main", "orchestration", "run-store.ts"),
    "utf8",
  );
  const rpcSource = fs.readFileSync(
    path.join(ROOT, "src", "main", "remote-access", "rpc.ts"),
    "utf8",
  );
  check(
    "production coalesces journal invalidations without delaying semantic notifications",
    productionSource.includes(
      "createCoraChangedCoalescer<RemoteCoraChangedEvent>",
    ) &&
      productionSource.includes("changedCoalescer.push(changed)") &&
      /changedCoalescer\.push\(changed\);\s*void \(async \(\) => \{\s*const notification/.test(
        productionSource,
      ),
  );
  {
    const broadcastDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "codara-remote-cora-changed-"),
    );
    try {
      const service = new remoteAccess.RemoteAccessService({
        remoteDir: broadcastDir,
        deviceName: "Cora Changed Test Studio",
        appVersion: "test",
        listWorkspaces: async () => [],
        createTerminal: async () => {
          throw new Error("not used");
        },
        log: () => {},
      });
      const provenEvents = [];
      const secondProvenEvents = [];
      const unprovenEvents = [];
      service.sessions.set(
        "device-1",
        new Set([
          {
            isProven: () => true,
            pushCoraChanged: (event) => provenEvents.push(event),
          },
          {
            isProven: () => false,
            pushCoraChanged: (event) => unprovenEvents.push(event),
          },
        ]),
      );
      service.sessions.set(
        "device-2",
        new Set([
          {
            isProven: () => true,
            pushCoraChanged: (event) => secondProvenEvents.push(event),
          },
        ]),
      );
      const changed = { workspaceId: "ws-1", runId: "run-1", sequence: 42 };
      service.broadcastCoraChanged(changed);
      check(
        "Cora invalidation broadcasts only tiny metadata to every proven session",
        provenEvents.length === 1 &&
          secondProvenEvents.length === 1 &&
          unprovenEvents.length === 0 &&
          JSON.stringify(provenEvents[0]) === JSON.stringify(changed) &&
          JSON.stringify(secondProvenEvents[0]) === JSON.stringify(changed),
        { provenEvents, secondProvenEvents, unprovenEvents },
      );
    } finally {
      fs.rmSync(broadcastDir, { recursive: true, force: true });
    }
  }
  {
    const promotionDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "codara-remote-session-promotion-"),
    );
    try {
      const service = new remoteAccess.RemoteAccessService({
        remoteDir: promotionDir,
        deviceName: "Session Promotion Test Studio",
        appVersion: "test",
        listWorkspaces: async () => [],
        createTerminal: async () => {
          throw new Error("not used");
        },
        log: () => {},
      });
      const destroyed = [];
      const oldProven = {
        isProven: () => true,
        destroy: () => destroyed.push("old-proven"),
      };
      const oldUnproven = {
        isProven: () => false,
        destroy: () => destroyed.push("old-unproven"),
      };
      const current = {
        isProven: () => true,
        destroy: () => destroyed.push("current"),
      };
      service.sessions.set(
        "same-phone",
        new Set([oldProven, oldUnproven, current]),
      );
      service.promoteSession("same-phone", current);
      check(
        "the newest proven phone session fences every older socket",
        service.sessionCountFor("same-phone") === 1 &&
          service.sessions.get("same-phone").has(current) &&
          destroyed.includes("old-proven") &&
          destroyed.includes("old-unproven") &&
          !destroyed.includes("current"),
        { destroyed },
      );

      const healthy = {
        isProven: () => true,
        destroy: () => destroyed.push("healthy"),
      };
      const replay = {
        isProven: () => false,
        destroy: () => destroyed.push("replay"),
      };
      service.sessions.set("replay-phone", new Set([healthy, replay]));
      service.promoteSession("replay-phone", replay);
      check(
        "an unproven replay cannot evict a healthy phone session",
        service.sessionCountFor("replay-phone") === 2 &&
          !destroyed.includes("healthy"),
        { destroyed },
      );
    } finally {
      fs.rmSync(promotionDir, { recursive: true, force: true });
    }
  }
  const rendererTerminalRpcSource = fs.readFileSync(
    path.join(
      ROOT,
      "src",
      "renderer",
      "src",
      "components",
      "Terminal",
      "terminalRpc.ts",
    ),
    "utf8",
  );
  const terminalSessionSource = fs.readFileSync(
    path.join(
      ROOT,
      "src",
      "renderer",
      "src",
      "components",
      "Terminal",
      "useTerminalSession.ts",
    ),
    "utf8",
  );
  const ptyManagerSource = fs.readFileSync(
    path.join(ROOT, "src", "main", "pty-manager.ts"),
    "utf8",
  );
  check(
    "phone-origin terminal geometry reaches both the Studio xterm and PTY",
    productionSource.includes("initialCols: request.cols") &&
      productionSource.includes("initialRows: request.rows") &&
      productionSource.includes('"resize"') &&
      productionSource.includes("pty.resize(result.paneId, cols, rows)") &&
      rpcSource.includes("await terminal.resize(cols, rows)") &&
      rendererTerminalRpcSource.includes(
        "setExternalTerminalSize(paneId, cols, rows)",
      ) &&
      terminalSessionSource.includes(
        "term.resize(externalGrid.cols, externalGrid.rows)",
      ) &&
      ptyManagerSource.includes("if (!opts.preserveSizeOnAttach)"),
  );
  check(
    "remote files.list applies Studio's generated-directory filter",
    productionSource.includes("isStudioExplorerIgnoredDirectory(entry.name)"),
  );
  check(
    "remote file reads refuse a final-component symlink swap",
    productionSource.includes("fsConstants.O_NOFOLLOW"),
  );
  {
    const exitNotify = productionSource.indexOf("request.onExit();");
    const exitTabClose = productionSource.indexOf(
      'requestTerminalOp("destroy"',
      exitNotify,
    );
    check(
      "natural terminal exit notifies the phone before closing its desktop tab",
      exitNotify >= 0 &&
        exitTabClose > exitNotify &&
        exitTabClose - exitNotify < 500,
      { exitNotify, exitTabClose },
    );
  }
  check(
    "the phone can never name the files a session delete touches",
    // RemoteWorkerSessionInfo deliberately omits cwd and transcriptPath, so the
    // delete has to rebuild both from the computer's own workspace listing.
    !/export interface RemoteWorkerSessionInfo \{[^}]*(cwd|transcriptPath)/.test(
      rpcSource,
    ) &&
      productionSource.includes(
        "const sessions = await listLocalWorkerSessions(input.runtime, root)",
      ) &&
      productionSource.includes("cwd: match.cwd") &&
      productionSource.includes("transcriptPath: match.transcriptPath"),
  );
  check(
    "a phone board write goes through the guarded user path at the revision it read",
    productionSource.includes("if (current.revision !== input.baseRevision)") &&
      productionSource.includes("baseRevision: current.revision") &&
      productionSource.includes("workspaceCwd: root"),
  );
  check(
    "queueing is refused on an automation's chat, where the nudge never runs",
    // board-nudge drops any run carrying an automationId, so the queue lane
    // there would be a promise nothing keeps. The phone hides the action; the
    // server must not accept it either.
    /if\s*\(run\.automationId\)\s*\{/.test(productionSource) &&
      productionSource.includes("cannot be queued from the phone") &&
      // and the phone is told which runs those are
      productionSource.includes(
        'requireRemoteCoraIdentity(run.automationId, "run.automationId")',
      ) &&
      /\.\.\.\(automationId\s*\?\s*\{\s*automated:\s*true,\s*automationId\s*\}\s*:\s*\{\}\)/s.test(
        productionSource,
      ),
  );
  check(
    "run summary carries the owning automation's identity, gated on automationId",
    // automationName/iteration come from the scheduler join and must be
    // impossible on a plain chat: every spread is guarded by run.automationId.
    productionSource.includes(
      "automationName: truncateUtf8(automation.name, 200)",
    ) &&
      productionSource.includes("...(automationId && automation?.name") &&
      productionSource.includes("Number.isSafeInteger(automationIteration)") &&
      productionSource.includes("{ iteration: automationIteration }"),
  );
  check(
    "automation rows carry a summary-level model chip, attempt model over task hint",
    /\[\.\.\.run\.workerAttempts\]\.reverse\(\)\.find\(\(attempt\)\s*=>\s*attempt\.model\)\s*\?\.\s*model/s.test(
      productionSource,
    ) &&
      /\[\.\.\.run\.workerTasks\]\.reverse\(\)\.find\(\(task\)\s*=>\s*task\.modelHint\)\s*\?\.\s*modelHint/s.test(
        productionSource,
      ) &&
      /typeof displayedModel === "string"\s*&&\s*displayedModel\s*\?\s*\{\s*model:\s*truncateUtf8\(displayedModel,\s*120\)\s*\}\s*:\s*\{\}/s.test(
        productionSource,
      ),
  );
  check(
    "the automation join reads the job store once per listing, not once per run",
    productionSource.includes("sliced.some((run) => run.automationId)") &&
      productionSource.includes("buildAutomationJoin(await listJobs()"),
  );
  {
    const fleetReader =
      productionSource.match(
        /async function getFleetOverviewForRemote\(\)[\s\S]*?\n\}/,
      )?.[0] ?? "";
    const occurrences = (needle) => fleetReader.split(needle).length - 1;
    check(
      "fleet overview reads workspaces, runs and automations once each",
      occurrences("listWorkspacesForRemote()") === 1 &&
        occurrences("listRuns()") === 1 &&
        occurrences("listJobs()") === 1 &&
        fleetReader.includes(
          "projectRemoteFleetOverview(workspaces, runs, automations)",
        ),
      fleetReader,
    );
  }
  check(
    "remote costUsd is measured spend only and the estimate travels apart",
    // costUsd = totalCostUsd + measuredWorkerCostUsd; estimatedWorkerCostUsd
    // may only ever appear as estimatedCostUsd. The old combined sum
    // (totalCostUsd + estimatedWorkerCostUsd) must be gone.
    productionSource.includes(
      "(run.totalCostUsd ?? 0) + (run.measuredWorkerCostUsd ?? 0)",
    ) &&
      productionSource.includes(
        "...(estimatedCostUsd ? { estimatedCostUsd } : {})",
      ) &&
      !productionSource.includes(
        "(run.totalCostUsd ?? 0) + (run.estimatedWorkerCostUsd ?? 0)",
      ),
  );
  check(
    "automation spend splits measured spentUsd from the estimate remainder",
    productionSource.includes(
      "usdRemainder(job.state.spentUsd, measuredSpentUsd)",
    ) &&
      productionSource.includes(
        "...(measuredSpentUsd ? { spentUsd: measuredSpentUsd } : {})",
      ) &&
      productionSource.includes(
        "...(estimatedSpentUsd ? { estimatedSpentUsd } : {})",
      ) &&
      productionSource.includes(
        "...(record.measuredCostUsd ? { costUsd: record.measuredCostUsd } : {})",
      ),
  );
  check(
    "remote worker rows fall back to the task's model hint and carry effort/runtimeState",
    productionSource.includes("attempt.model || task?.modelHint") &&
      /typeof task\?\.effortHint === "string"\s*&&\s*task\.effortHint\s*\?\s*\{\s*effort:\s*truncateUtf8\(task\.effortHint,\s*40\)\s*\}\s*:\s*\{\}/s.test(
        productionSource,
      ) &&
      /\{\s*runtimeState:\s*truncateUtf8\(attempt\.runtimeState,\s*200\)\s*\}/s.test(
        productionSource,
      ),
  );
  check(
    "remote worker rows carry a trimmed, bounded live activity readout",
    /\{\s*runtimeActivity:\s*truncateUtf8\(attempt\.runtimeActivity\.trim\(\),\s*120\)\s*\}/s.test(
      productionSource,
    ) &&
      rpcSource.includes("runtimeActivity?: string;"),
  );
  {
    const liveRunProjection = productionSource.slice(
      productionSource.indexOf("async function toRemoteAutomationLiveRun("),
      productionSource.indexOf("// The loom's detail:"),
    );
    const liveRunContract = rpcSource.slice(
      rpcSource.indexOf("export interface RemoteAutomationLiveRun"),
      rpcSource.indexOf("export interface RemoteAutomationDetail"),
    );
    check(
      "automation detail projects a message-free live run graph and shared worker roster",
      liveRunProjection.includes("id: run.id") &&
        liveRunProjection.includes("status: run.status") &&
        liveRunProjection.includes("workers: toRemoteRunWorkers(run)") &&
        liveRunProjection.includes("steps: plan.steps") &&
        liveRunProjection.includes("currentStepId: run.currentStepId") &&
        !liveRunProjection.includes("messages") &&
        !liveRunProjection.includes("toRemoteRun(") &&
        liveRunContract.includes("id: string") &&
        liveRunContract.includes("status: RemoteCoraRunStatus") &&
        liveRunContract.includes("workers: RemoteCoraWorker[]") &&
        liveRunContract.includes("steps?: RemoteCoraStep[]") &&
        !liveRunContract.includes("messages"),
      { liveRunProjection, liveRunContract },
    );
    check(
      "the shared remote worker roster is capped by count and serialized bytes",
      productionSource.includes("const MAX_CORA_RUN_WORKERS = 12") &&
        productionSource.includes(
          "const CORA_WORKER_ROSTER_MAX_BYTES = 16 * 1024",
        ) &&
        productionSource.includes(".slice(0, MAX_CORA_RUN_WORKERS)") &&
        productionSource.includes(
          'Buffer.byteLength(JSON.stringify(worker), "utf8") + 1',
        ) &&
        productionSource.includes(
          "usedBytes + bytes > CORA_WORKER_ROSTER_MAX_BYTES",
        ),
    );
  }
  check(
    "concurrent session deletes serialize per runtime, not per session",
    // Two deletes of different sessions still rewrite the same provider
    // history file, so a per-session key would let one clobber the other.
    productionSource.includes(
      'JSON.stringify(["workerSession.delete", input.workspaceId, input.runtime])',
    ),
  );
  check(
    "remote run detail reports plan progress over the WHOLE plan, not the capped list",
    productionSource.includes("stepsTotal: plan.total") &&
      productionSource.includes("stepsFinished: plan.finished") &&
      productionSource.includes("MAX_CORA_RUN_STEPS"),
  );
  check(
    "production serializes and persistently indexes Cora retry keys without scanning every run",
    productionSource.includes("coraRunMutations.run") &&
      productionSource.includes("receipts.resolve(receiptInput, getRun)") &&
      productionSource.includes("listRecentRunsForRetryRepair()") &&
      productionSource.includes("receipts.record(receiptInput, run.id)") &&
      productionSource.includes("if (!retry && repair.truncated)") &&
      runStoreSource.includes("const RUN_RETRY_REPAIR_READ_LIMIT = 64") &&
      runStoreSource.includes("candidates.length > recent.length") &&
      !productionSource.includes(
        "findRemoteCoraRetry(await listRuns(workspace.id)",
      ),
  );
  check(
    "run retention and explicit deletion remove compact Cora send routes",
    runStoreSource.includes("for (const listener of runDeletedListeners)") &&
      productionSource.includes("onRunDeleted(async ({ workspaceId, runId })") &&
      productionSource.includes(".removeRun(workspaceId, runId)"),
  );
  check(
    "Cora deletion is replay-safe across lost replies",
    productionSource.includes("const run = await getRun(input.runId)") &&
      productionSource.includes(
        "if (!run || run.workspaceId !== input.workspaceId) return",
      ) &&
      remoteIndexSource.includes("method: string") &&
      remoteIndexSource.includes('"cora.delete"') &&
      remoteIndexSource.includes("ledger.execute("),
  );
  check(
    "per-chat Cora account switching is removed while sanitized listing survives",
    !remoteIndexSource.includes('"cora.account.select"') &&
      !remoteIndexSource.includes('"cora.nativeCliAccount.select"') &&
      !productionSource.includes("chatAccountProfileId: profile.id") &&
      !productionSource.includes("selectCoraAccountForRemote") &&
      productionSource.includes("projectRemoteSubscriptionProfiles(") &&
      productionSource.includes("inspectPiAccountProfileAuthStore()") &&
      productionSource.includes("inspectCachedPiSubscriptionUsageProfiles()"),
  );
  check(
    "Explorer moves use the authenticated device mutation ledger",
    remoteIndexSource.includes('"files.move"') &&
      remoteIndexSource.includes("input.requestId") &&
      remoteIndexSource.includes("callerNamespace") &&
      remoteIndexSource.includes("ledger.execute("),
  );
  check(
    "GitHub mutations resolve local workspaces and use the authenticated device mutation ledger",
      productionSource.includes("getGitHubStatusForRemote") &&
      productionSource.includes("publishGitHubForRemote") &&
      productionSource.includes("markGitHubReadyForRemote") &&
      productionSource.includes("mergeGitHubForRemote") &&
      productionSource.includes("startGitHubIssueForRemote") &&
      productionSource.includes("startGitHubPullRequestForRemote") &&
      productionSource.includes("startGitHubIssueWorkspace(input)") &&
      productionSource.includes("startGitHubPullRequestWorkspace(input)") &&
      productionSource.includes("requireLocalWorkspace(workspaceId)") &&
      productionSource.includes("requireLocalWorkspace(input.workspaceId)") &&
      remoteIndexSource.includes('"github.publish"') &&
      remoteIndexSource.includes('"github.ready"') &&
      remoteIndexSource.includes('"github.merge"') &&
      remoteIndexSource.includes('"github.issue.start"') &&
      remoteIndexSource.includes('"github.pullRequest.start"') &&
      remoteIndexSource.includes("input.requestId") &&
      remoteIndexSource.includes("keyB64") &&
      remoteIndexSource.includes("ledger.execute("),
  );
  check(
    "production listener uses identity-derived candidates unless an exact test port is present",
    remoteIndexSource.includes("this.deps.port !== undefined") &&
      /portCandidates:\s*stableRemoteAccessPortCandidates\(\s*this\.identity\.publicKey,\s*\)/s.test(
        remoteIndexSource,
      ),
  );
  check(
    "the listener advances candidates only for an occupied bind",
    remoteIndexSource.includes("portCandidates:") &&
      fs
        .readFileSync(
          path.join(ROOT, "src", "main", "remote-access", "listener.ts"),
          "utf8",
        )
        .includes('code !== "EADDRINUSE"'),
  );
  check(
    "an explicit test port of zero is not mistaken for an absent override",
    remoteIndexSource.includes("this.deps.port !== undefined"),
  );
  {
    const keys = [
      Buffer.alloc(32, 0),
      Buffer.alloc(32, 7),
      Buffer.from(Array.from({ length: 32 }, (_, index) => index)),
      Buffer.from(Array.from({ length: 32 }, (_, index) => 255 - index)),
    ];
    check(
      "identity-derived listener candidates are bounded, complete, and distinct",
      keys.every((key) => {
        const ports = stablePort.stableRemoteAccessPortCandidates(key);
        return (
          ports.length === stablePort.REMOTE_ACCESS_PORT_CANDIDATE_COUNT &&
          new Set(ports).size === ports.length &&
          ports.every(
            (port) =>
              port >= stablePort.REMOTE_ACCESS_PORT_MIN &&
              port <
                stablePort.REMOTE_ACCESS_PORT_MIN +
                  stablePort.REMOTE_ACCESS_PORT_SPAN,
          )
        );
      }),
      keys.map((key) => stablePort.stableRemoteAccessPortCandidates(key)),
    );
    if (fs.existsSync(MOBILE_STABLE_PORT)) {
      delete require.cache[MOBILE_STABLE_PORT];
      const mobileStablePort = require(MOBILE_STABLE_PORT);
      check(
        "desktop and phone derive the same ordered restart candidates from every pinned key",
        keys.every(
          (key) =>
            JSON.stringify(stablePort.stableRemoteAccessPortCandidates(key)) ===
            JSON.stringify(
              mobileStablePort.stableRemoteAccessPortCandidates(
                key.toString("base64"),
              ),
            ),
        ),
      );
    } else {
      console.log(
        "SKIP mobile restart-port parity (codara-mobile checkout not found)",
      );
    }
  }
  {
    // The real service lifecycle (with relay disabled and loopback-only) must
    // release and rebind the same derived port. This is the exact sequence a
    // stopped/restarted `npm run dev` process performs.
    const restartDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "codara-remote-restart-"),
    );
    const restartDeps = {
      remoteDir: restartDir,
      deviceName: "Restart Test Studio",
      appVersion: "test",
      host: "127.0.0.1",
      relayUrl: false,
      listWorkspaces: async () => [],
      createTerminal: async () => {
        throw new Error("not used");
      },
      log: () => {},
    };
    const service = new remoteAccess.RemoteAccessService(restartDeps);
    let restartedService = null;
    try {
      await service.setEnabled(true);
      const firstPort = service.getStatus().port;
      const key = identity.loadOrCreateIdentity(restartDir).publicKey;
      const candidates = stablePort.stableRemoteAccessPortCandidates(key);
      await service.setEnabled(false);
      // A fresh service instance reloads the key from disk like a new Electron
      // process; this is stronger than toggling one in-memory singleton.
      restartedService = new remoteAccess.RemoteAccessService(restartDeps);
      await restartedService.setEnabled(true);
      const secondPort = restartedService.getStatus().port;
      check(
        "a fresh desktop process rebinds the paired phone's exact stable candidate",
        firstPort === candidates[0] &&
          secondPort === firstPort &&
          restartedService.getStatus().state === "reachable",
        { firstPort, secondPort, state: restartedService.getStatus().state },
      );
    } finally {
      await service.setEnabled(false);
      if (restartedService) await restartedService.setEnabled(false);
      fs.rmSync(restartDir, { recursive: true, force: true });
    }
  }
  {
    // Occupy candidate zero like an unrelated dev server or an ephemeral
    // socket could. A production service must remain reachable on the next
    // deterministic candidate; the phone derives the same ordered set.
    const fallbackDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "codara-remote-fallback-"),
    );
    const key = identity.loadOrCreateIdentity(fallbackDir).publicKey;
    const candidates = stablePort.stableRemoteAccessPortCandidates(key);
    const blocker = net.createServer();
    const logs = [];
    let fallbackService = null;
    try {
      await new Promise((resolve, reject) => {
        blocker.once("error", reject);
        blocker.listen(candidates[0], "127.0.0.1", resolve);
      });
      fallbackService = new remoteAccess.RemoteAccessService({
        remoteDir: fallbackDir,
        deviceName: "Fallback Test Studio",
        appVersion: "test",
        host: "127.0.0.1",
        relayUrl: false,
        listWorkspaces: async () => [],
        createTerminal: async () => {
          throw new Error("not used");
        },
        log: (line) => logs.push(line),
      });
      await fallbackService.setEnabled(true);
      const actual = fallbackService.getStatus().port;
      check(
        "an occupied first stable candidate advances the production service",
        fallbackService.getStatus().state === "reachable" &&
          actual !== candidates[0] &&
          candidates.slice(1).includes(actual),
        { actual, candidates, state: fallbackService.getStatus().state },
      );
      check(
        "the occupied-candidate fallback is visible in local diagnostics",
        logs.some((line) => line.includes("trying the next stable candidate")),
        logs,
      );
    } finally {
      if (fallbackService) await fallbackService.setEnabled(false);
      await new Promise((resolve) => blocker.close(resolve));
      fs.rmSync(fallbackDir, { recursive: true, force: true });
    }
  }
  {
    const zeroDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "codara-remote-zero-port-"),
    );
    const zeroService = new remoteAccess.RemoteAccessService({
      remoteDir: zeroDir,
      deviceName: "Zero Port Test Studio",
      appVersion: "test",
      host: "127.0.0.1",
      port: 0,
      relayUrl: false,
      listWorkspaces: async () => [],
      createTerminal: async () => {
        throw new Error("not used");
      },
      log: () => {},
    });
    try {
      await zeroService.setEnabled(true);
      check(
        "an explicit zero test port still asks the OS for an available port",
        zeroService.getStatus().state === "reachable" &&
          typeof zeroService.getStatus().port === "number" &&
          zeroService.getStatus().port > 0,
        zeroService.getStatus(),
      );
    } finally {
      await zeroService.setEnabled(false);
      fs.rmSync(zeroDir, { recursive: true, force: true });
    }
  }
  if (fs.existsSync(MOBILE_RPC_TYPES)) {
    const mobileTypesSource = fs.readFileSync(MOBILE_RPC_TYPES, "utf8");
    const interfaceKeys = (source, name) => {
      const body =
        source.match(
          new RegExp(`export interface ${name} \\{([\\s\\S]*?)^\\}`, "m"),
        )?.[1] ?? "";
      // RpcMethods/RpcEvents are formatted with two-space top-level members.
      // Matching arbitrary whitespace also captures nested `params`/`result`
      // fields as fake RPC methods as soon as Prettier wraps a member.
      return [
        ...body.matchAll(/^ {2}(?:'([^']+)'|([A-Za-z][A-Za-z0-9]*))\s*:/gm),
      ]
        .map((match) => match[1] || match[2])
        .sort();
    };
    const mobileMethods = interfaceKeys(mobileTypesSource, "RpcMethods");
    const desktopMethods = [...rpcSource.matchAll(/^\s*case "([^"]+)":/gm)]
      .map((match) => match[1])
      .sort();
    const mobileEvents = interfaceKeys(mobileTypesSource, "RpcEvents");
    check(
      "desktop dispatch implements every live mobile RPC method and no extras",
      mobileMethods.length > 0 &&
        JSON.stringify(desktopMethods) === JSON.stringify(mobileMethods),
      { desktopMethods, mobileMethods },
    );
    check(
      "desktop emits every live mobile RPC event",
      mobileEvents.length > 0 &&
        mobileEvents.every((event) =>
          rpcSource.includes(`pushEvent("${event}"`),
        ),
      mobileEvents,
    );
    check(
      "desktop and mobile negotiate the same RPC protocol version",
      rpc.RPC_PROTOCOL_VERSION ===
        Number(
          mobileTypesSource.match(/RPC_PROTOCOL_VERSION\s*=\s*(\d+)/)?.[1],
        ),
    );
  } else {
    console.log(
      "SKIP mobile RPC contract parity (codara-mobile checkout not found)",
    );
  }

  /* ---- pairing window: expiry and single use ---------------------------- */

  const T0 = 1_700_000_000_000;
  const win = new pairing.PairingWindow(T0);
  const secret = Buffer.from(win.secretB64(), "base64");
  check("pairing secret is 32 bytes", secret.length === 32);
  check(
    "pairing window expires exactly at ttl",
    win.expiresAt === T0 + 2 * 60 * 1000,
  );
  check(
    "wrong secret is refused",
    win.consume(Buffer.alloc(32, 7), T0 + 1000) === false,
  );
  check(
    "wrong-length proof is refused",
    win.consume(secret.subarray(0, 16), T0 + 1000) === false,
  );
  check("a refused proof does not consume the window", win.isUsed() === false);
  check("correct secret is accepted", win.consume(secret, T0 + 1000) === true);
  check("the window is single use", win.consume(secret, T0 + 1001) === false);

  const expired = new pairing.PairingWindow(T0);
  const expiredSecret = Buffer.from(expired.secretB64(), "base64");
  check(
    "an expired window refuses the correct secret",
    expired.consume(expiredSecret, T0 + 2 * 60 * 1000) === false,
  );
  check(
    "expiry boundary: one ms before the deadline still works",
    new pairing.PairingWindow(T0).isExpired(T0 + 2 * 60 * 1000 - 1) === false,
  );

  /* ---- QR payload against the real phone parser ------------------------- */

  const qrWin = new pairing.PairingWindow(T0);
  const identityKey = Buffer.alloc(32, 3);
  const qr = pairing.buildQrPayloadString({
    publicKeyB64: identityKey.toString("base64"),
    addrs: ["192.168.1.20", "127.0.0.1"],
    port: 40123,
    window: qrWin,
    name: "Etienne's Studio \u001b[31m",
    now: T0,
  });
  const parsedQr = JSON.parse(qr);
  check("qr: v is 1", parsedQr.v === 1);
  check(
    "qr: pk is canonical padded base64 of 32 bytes",
    parsedQr.pk === identityKey.toString("base64"),
  );
  check("qr: iat is included", parsedQr.iat === T0);
  check(
    "qr: secret decodes to 32 bytes",
    Buffer.from(parsedQr.secret, "base64").length === 32,
  );
  check("qr: name is control-stripped", !/[\u0000-\u001f]/.test(parsedQr.name));

  if (fs.existsSync(MOBILE_PARSER)) {
    const mobile = await bundle(
      MOBILE_PARSER,
      "remote-access-mobile-parser-test.cjs",
    );
    const accepted = mobile.parsePairingPayload(qr, T0 + 30_000);
    check("phone parser accepts our payload", accepted.ok === true, accepted);
    if (accepted.ok) {
      check(
        "phone parser keeps our canonical pk",
        accepted.payload.pk === parsedQr.pk,
      );
      check(
        "phone parser keeps our addrs",
        accepted.payload.addrs.length === 2,
      );
    }
    const stale = mobile.parsePairingPayload(qr, T0 + 2 * 60 * 1000 + 1);
    check(
      "phone parser expires our payload after 2 minutes",
      stale.ok === false && stale.code === "expired",
      stale,
    );
  } else {
    console.log("SKIP phone-parser interop (codara-mobile checkout not found)");
  }

  /* ---- pairing address classification (item 8a) ------------------------- */

  // Pairing accepts a peer only from a local address; lanAddresses only
  // advertises the same, so the "same network" property is enforced, not
  // just claimed.
  check(
    "loopback is local",
    pairing.isPrivateOrLocalAddress("127.0.0.1") === true,
  );
  check("10/8 is local", pairing.isPrivateOrLocalAddress("10.4.5.6") === true);
  check(
    "172.16/12 is local",
    pairing.isPrivateOrLocalAddress("172.20.1.1") === true,
  );
  check(
    "172.32 is NOT local",
    pairing.isPrivateOrLocalAddress("172.32.0.1") === false,
  );
  check(
    "192.168/16 is local",
    pairing.isPrivateOrLocalAddress("192.168.1.24") === true,
  );
  check(
    "169.254/16 link-local is local",
    pairing.isPrivateOrLocalAddress("169.254.10.10") === true,
  );
  check(
    "a public IPv4 is NOT local",
    pairing.isPrivateOrLocalAddress("8.8.8.8") === false,
  );
  check(
    "a routable IPv4 is NOT local",
    pairing.isPrivateOrLocalAddress("203.0.113.7") === false,
  );
  check(
    "IPv4-mapped loopback is local",
    pairing.isPrivateOrLocalAddress("::ffff:127.0.0.1") === true,
  );
  check(
    "IPv4-mapped public is NOT local",
    pairing.isPrivateOrLocalAddress("::ffff:8.8.8.8") === false,
  );
  check(
    "IPv6 loopback is local",
    pairing.isPrivateOrLocalAddress("::1") === true,
  );
  check(
    "IPv6 link-local is local",
    pairing.isPrivateOrLocalAddress("fe80::1%en0") === true,
  );
  check(
    "IPv6 unique-local is local",
    pairing.isPrivateOrLocalAddress("fd00::1234") === true,
  );
  check(
    "public IPv6 is NOT local",
    pairing.isPrivateOrLocalAddress("2606:4700:4700::1111") === false,
  );
  check(
    "empty/undefined address is NOT local",
    pairing.isPrivateOrLocalAddress(undefined) === false,
  );
  check(
    "lanAddresses advertises only local addresses",
    pairing
      .lanAddresses()
      .every((addr) => pairing.isPrivateOrLocalAddress(addr)),
    pairing.lanAddresses(),
  );

  // The key fingerprint the desktop shows matches the phone's short form
  // (leading eight bytes, uppercase hex, groups of four).
  {
    const key = Buffer.alloc(32);
    key.set([0x7f, 0x3a, 0x91, 0xc2, 0x5e, 0x08, 0x4b, 0x6d]);
    check(
      "key fingerprint matches the phone confirm-screen format",
      identity.keyFingerprint(key.toString("base64")) === "7F3A 91C2 5E08 4B6D",
      identity.keyFingerprint(key.toString("base64")),
    );
  }

  /* ---- paired-device store ---------------------------------------------- */

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-remote-test-"));
  try {
    const store = new pairing.PairedDeviceStore(dir);
    const keyA = Buffer.alloc(32, 1);
    const keyB = Buffer.alloc(32, 2);
    check("empty store authorizes nothing", store.isAuthorized(keyA) === false);

    store.addDevice(keyA, "Phone A", T0);
    check("paired key is authorized", store.isAuthorized(keyA) === true);
    check("unknown key is rejected", store.isAuthorized(keyB) === false);
    check(
      "wrong-length key is rejected",
      pairing.isAuthorizedKey(Buffer.alloc(16, 1), store.list()) === false,
    );

    // Persistence: a new store over the same dir sees the same devices.
    const reread = new pairing.PairedDeviceStore(dir);
    check(
      "devices persist across store instances",
      reread.isAuthorized(keyA) === true,
    );
    check(
      "persisted record keeps name and addedAt",
      (() => {
        const record = reread.list()[0];
        return record.name === "Phone A" && record.addedAt === T0;
      })(),
    );

    if (process.platform !== "win32") {
      const mode =
        fs.statSync(path.join(dir, "paired-devices.json")).mode & 0o777;
      check("paired-devices.json is 0600", mode === 0o600, mode.toString(8));
    }

    // Re-pairing the same key updates in place instead of duplicating.
    store.addDevice(keyA, "Phone A renamed", T0 + 5);
    check("re-pair does not duplicate", store.list().length === 1);
    check(
      "re-pair updates the name",
      store.list()[0].name === "Phone A renamed",
    );
    check("re-pair keeps the original addedAt", store.list()[0].addedAt === T0);

    // Revocation: key gone, persisted, and the firewall refuses it again.
    store.addDevice(keyB, "Phone B", T0 + 10);
    check(
      "revoke reports removal",
      (await store.revokeDevice(keyA.toString("base64"))) === true,
    );
    check("revoked key is rejected", store.isAuthorized(keyA) === false);
    check("other devices survive a revoke", store.isAuthorized(keyB) === true);
    check(
      "revoke persists",
      new pairing.PairedDeviceStore(dir).isAuthorized(keyA) === false,
    );
    check(
      "revoking an unknown key is a no-op",
      (await store.revokeDevice(keyA.toString("base64"))) === false,
    );

    // A corrupt trust store fails closed: nobody is authorized.
    fs.writeFileSync(path.join(dir, "paired-devices.json"), "{not json");
    const corrupt = new pairing.PairedDeviceStore(dir);
    check(
      "corrupt device file authorizes nothing",
      corrupt.isAuthorized(keyB) === false,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /* ---- local filesystem policy ----------------------------------------- */

  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codara-remote-root-"));
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), "codara-remote-outside-"),
    );
    try {
      fs.mkdirSync(path.join(root, "project", "src"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "project", "src", "index.ts"),
        "export {};\n",
      );
      const nested = await localPolicy.resolveExistingInside(
        root,
        "project/src",
        {
          directory: true,
          rejectSymlinks: true,
        },
      );
      check(
        "filesystem policy resolves an ordinary directory inside its root",
        nested.path === fs.realpathSync(path.join(root, "project", "src")),
        nested,
      );
      check(
        "filesystem policy emits slash-separated workspace paths",
        localPolicy.toWireRelative(nested.root, nested.path) === "project/src",
      );
      check(
        "remote explorer hides the same generated trees as Studio",
        [
          ".git",
          "node_modules",
          "out",
          "dist",
          "build",
          ".next",
          ".turbo",
          "coverage",
        ].every(localPolicy.isStudioExplorerIgnoredDirectory) &&
          !localPolicy.isStudioExplorerIgnoredDirectory("src"),
      );

      let traversalError = null;
      try {
        await localPolicy.resolveExistingInside(root, "../", {
          directory: true,
        });
      } catch (err) {
        traversalError = err;
      }
      check(
        "filesystem policy rejects lexical parent traversal",
        Boolean(traversalError),
      );

      let outsideError = null;
      try {
        await localPolicy.resolveExistingInside(root, outside, {
          allowAbsolute: true,
          directory: true,
        });
      } catch (err) {
        outsideError = err;
      }
      check(
        "filesystem policy rejects an absolute path outside its root",
        Boolean(outsideError),
      );

      if (process.platform !== "win32") {
        fs.symlinkSync(
          path.join(root, "project", "src"),
          path.join(root, "linked-src"),
        );
        let symlinkError = null;
        try {
          await localPolicy.resolveExistingInside(root, "linked-src/index.ts", {
            rejectSymlinks: true,
          });
        } catch (err) {
          symlinkError = err;
        }
        check(
          "filesystem policy rejects symlinks even when they resolve back inside",
          /symbolic link/i.test(symlinkError?.message ?? ""),
          symlinkError?.message,
        );

        fs.symlinkSync(outside, path.join(root, "escape"));
        let symlinkEscapeError = null;
        try {
          await localPolicy.resolveExistingInside(root, "escape", {
            directory: true,
          });
        } catch (err) {
          symlinkEscapeError = err;
        }
        check(
          "filesystem policy rejects a symlink escape from the root",
          Boolean(symlinkEscapeError),
        );
      }

      const glyphs = "🙂".repeat(100);
      const truncated = localPolicy.truncateUtf8(glyphs, 33);
      check(
        "UTF-8 truncation stays inside its byte budget without a broken glyph",
        Buffer.byteLength(truncated, "utf8") <= 33 &&
          !truncated.includes("\ufffd"),
        { bytes: Buffer.byteLength(truncated, "utf8"), truncated },
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }

  /* ---- workspace-bound file mutations --------------------------------- */

  {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "codara-remote-mutate-"),
    );
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), "codara-remote-mutate-outside-"),
    );
    try {
      fs.mkdirSync(path.join(root, "src"));
      fs.mkdirSync(path.join(root, "archive"));
      fs.mkdirSync(path.join(root, ".git"));
      fs.writeFileSync(path.join(root, "src", "existing.ts"), "keep");
      fs.writeFileSync(path.join(outside, "outside.txt"), "outside");

      const created = await fileMutations.createRemoteWorkspaceEntry(root, {
        parentPath: "src",
        name: "new.ts",
        kind: "file",
      });
      check(
        "remote Explorer creates an exclusive workspace-relative file",
        created.path === "src/new.ts" &&
          created.ext === "ts" &&
          fs.readFileSync(path.join(root, "src", "new.ts"), "utf8") === "",
        created,
      );

      const folder = await fileMutations.createRemoteWorkspaceEntry(root, {
        name: "notes",
        kind: "directory",
      });
      check(
        "remote Explorer creates a folder without recursive path injection",
        folder.path === "notes" &&
          folder.isDir &&
          fs.statSync(path.join(root, "notes")).isDirectory(),
        folder,
      );

      const renamed = await fileMutations.renameRemoteWorkspaceEntry(root, {
        path: "src/new.ts",
        name: "renamed.ts",
      });
      check(
        "remote Explorer renames without leaving the workspace",
        renamed.path === "src/renamed.ts" &&
          !fs.existsSync(path.join(root, "src", "new.ts")) &&
          fs.existsSync(path.join(root, "src", "renamed.ts")),
        renamed,
      );

      let collisionError = null;
      try {
        await fileMutations.renameRemoteWorkspaceEntry(root, {
          path: "src/renamed.ts",
          name: "existing.ts",
        });
      } catch (err) {
        collisionError = err;
      }
      check(
        "remote rename refuses to overwrite an existing entry",
        /already exists/i.test(collisionError?.message ?? "") &&
          fs.readFileSync(path.join(root, "src", "existing.ts"), "utf8") ===
            "keep" &&
          fs.existsSync(path.join(root, "src", "renamed.ts")),
        collisionError?.message,
      );

      const moved = await fileMutations.moveRemoteWorkspaceEntry(root, {
        path: "src/renamed.ts",
        destinationPath: "archive",
      });
      check(
        "remote Explorer moves an entry into another workspace folder",
        moved.path === "archive/renamed.ts" &&
          !fs.existsSync(path.join(root, "src", "renamed.ts")) &&
          fs.existsSync(path.join(root, "archive", "renamed.ts")),
        moved,
      );
      fs.writeFileSync(path.join(root, "src", "collision.ts"), "source");
      fs.writeFileSync(
        path.join(root, "archive", "collision.ts"),
        "destination",
      );
      let ambiguousMoveError = null;
      try {
        await fileMutations.moveRemoteWorkspaceEntry(root, {
          path: "src/collision.ts",
          destinationPath: "archive",
        });
      } catch (err) {
        ambiguousMoveError = err;
      }
      check(
        "remote move replay does not hide an ambiguous destination collision",
        /already exists/i.test(ambiguousMoveError?.message ?? "") &&
          fs.readFileSync(path.join(root, "src", "collision.ts"), "utf8") ===
            "source" &&
          fs.readFileSync(
            path.join(root, "archive", "collision.ts"),
            "utf8",
          ) === "destination",
        ambiguousMoveError?.message,
      );

      let missingSourceError = null;
      try {
        await fileMutations.moveRemoteWorkspaceEntry(root, {
          path: "src/renamed.ts",
          destinationPath: "archive",
        });
      } catch (err) {
        missingSourceError = err;
      }
      check(
        "a first move with a missing source never claims an unrelated target",
        Boolean(missingSourceError) &&
          fs.existsSync(path.join(root, "archive", "renamed.ts")),
        missingSourceError?.message,
      );

      let traversalError = null;
      try {
        await fileMutations.createRemoteWorkspaceEntry(root, {
          parentPath: "../",
          name: "escape.txt",
          kind: "file",
        });
      } catch (err) {
        traversalError = err;
      }
      check(
        "remote create cannot traverse outside its workspace",
        Boolean(traversalError) &&
          !fs.existsSync(path.join(path.dirname(root), "escape.txt")),
        traversalError?.message,
      );

      let hiddenError = null;
      try {
        await fileMutations.createRemoteWorkspaceEntry(root, {
          parentPath: ".git",
          name: "phone-owned",
          kind: "file",
        });
      } catch (err) {
        hiddenError = err;
      }
      check(
        "remote mutations cannot enter Explorer-hidden metadata trees",
        /outside the phone Explorer/i.test(hiddenError?.message ?? "") &&
          !fs.existsSync(path.join(root, ".git", "phone-owned")),
        hiddenError?.message,
      );

      let reservedNameError = null;
      try {
        await fileMutations.createRemoteWorkspaceEntry(root, {
          name: "CON.txt",
          kind: "file",
        });
      } catch (err) {
        reservedNameError = err;
      }
      check(
        "remote entry names use a portable cross-platform policy",
        /reserved/i.test(reservedNameError?.message ?? ""),
        reservedNameError?.message,
      );

      fs.mkdirSync(path.join(root, "tree", "child"), { recursive: true });
      let recursiveMoveError = null;
      try {
        await fileMutations.moveRemoteWorkspaceEntry(root, {
          path: "tree",
          destinationPath: "tree/child",
        });
      } catch (err) {
        recursiveMoveError = err;
      }
      check(
        "remote move refuses to put a folder inside itself",
        /into itself/i.test(recursiveMoveError?.message ?? "") &&
          fs.existsSync(path.join(root, "tree", "child")),
        recursiveMoveError?.message,
      );

      if (process.platform !== "win32") {
        fs.symlinkSync(outside, path.join(root, "outside-link"));
        let symlinkMutationError = null;
        try {
          await fileMutations.deleteRemoteWorkspaceEntry(root, {
            path: "outside-link/outside.txt",
          });
        } catch (err) {
          symlinkMutationError = err;
        }
        check(
          "remote delete rejects a symlink escape and preserves the outside target",
          Boolean(symlinkMutationError) &&
            fs.readFileSync(path.join(outside, "outside.txt"), "utf8") ===
              "outside",
          symlinkMutationError?.message,
        );
      }

      let rootDeleteError = null;
      try {
        await fileMutations.deleteRemoteWorkspaceEntry(root, { path: "" });
      } catch (err) {
        rootDeleteError = err;
      }
      check(
        "remote delete can never remove the workspace root",
        /workspace root/i.test(rootDeleteError?.message ?? "") &&
          fs.existsSync(root),
        rootDeleteError?.message,
      );

      const deleted = await fileMutations.deleteRemoteWorkspaceEntry(root, {
        path: "archive/renamed.ts",
      });
      check(
        "remote delete reports its refresh parent and removes only the selected entry",
        deleted.deletedPath === "archive/renamed.ts" &&
          deleted.parentPath === "archive" &&
          !fs.existsSync(path.join(root, "archive", "renamed.ts")) &&
          fs.existsSync(path.join(root, "src", "existing.ts")),
        deleted,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }

  /* ---- Remote terminal image uploads ---------------------------------- */

  {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "codara-remote-image-test-"),
    );
    const imageDirectory = path.join(directory, "image dir");
    try {
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
      const upload = await imageUpload.createRemoteImageUpload(
        imageDirectory,
        {
          workspaceId: "ws1",
          name: "../Holiday Photo.heic",
          mimeType: "image/jpeg",
          size: jpeg.length,
        },
        "darwin",
      );
      await upload.write(jpeg.subarray(0, 3));
      await upload.write(jpeg.subarray(3));
      const attachment = await upload.finish();
      check(
        "remote image upload uses a private server-selected path and a safe terminal token",
        attachment.name === "Holiday Photo.jpg" &&
          attachment.path.startsWith(`${imageDirectory}${path.sep}`) &&
          attachment.inputToken.includes("\\ ") &&
          fs.readFileSync(attachment.path).equals(jpeg),
        attachment,
      );

      const partial = await imageUpload.createRemoteImageUpload(
        imageDirectory,
        {
          workspaceId: "ws1",
          name: "partial.jpg",
          mimeType: "image/jpeg",
          size: jpeg.length,
        },
      );
      await partial.write(jpeg.subarray(0, 3));
      const beforeAbort = fs.readdirSync(imageDirectory).length;
      await partial.abort();
      check(
        "aborting an image upload removes its incomplete temp file",
        fs.readdirSync(imageDirectory).length === beforeAbort - 1,
      );

      const forged = await imageUpload.createRemoteImageUpload(imageDirectory, {
        workspaceId: "ws1",
        name: "forged.jpg",
        mimeType: "image/jpeg",
        size: 6,
      });
      await forged.write(Buffer.from("NOTJPG"));
      let forgedError = null;
      try {
        await forged.finish();
      } catch (err) {
        forgedError = err;
      }
      check(
        "remote image upload rejects bytes that do not match the declared image type",
        /valid supported image/i.test(forgedError?.message ?? "") &&
          fs.readdirSync(imageDirectory).length === 1,
        forgedError?.message,
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }

  /* ---- Cora retry idempotency ------------------------------------------ */

  {
    const persistedRun = {
      id: "run-persisted",
      workspaceId: "ws1",
      humanMessages: [
        {
          id: "message-1",
          clientMessageId: "phone-retry-1",
          runId: "run-persisted",
          author: "user",
          kind: "note",
          message: "Build the feature",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    const retry = coraPolicy.findRemoteCoraRetry([persistedRun], {
      workspaceId: "ws1",
      message: "Build the feature",
      clientMessageId: "phone-retry-1",
    });
    check(
      "a new-conversation retry finds its durable run without a run id",
      retry === persistedRun,
    );

    let collision = null;
    try {
      coraPolicy.findRemoteCoraRetry([persistedRun], {
        workspaceId: "ws1",
        message: "A different request",
        clientMessageId: "phone-retry-1",
      });
    } catch (err) {
      collision = err;
    }
    check(
      "a reused Cora retry key cannot silently replace different content",
      /already used/i.test(collision?.message ?? ""),
      collision?.message,
    );

    let wrongRun = null;
    try {
      coraPolicy.findRemoteCoraRetry([persistedRun], {
        workspaceId: "ws1",
        runId: "run-other",
        message: "Build the feature",
        clientMessageId: "phone-retry-1",
      });
    } catch (err) {
      wrongRun = err;
    }
    check(
      "an existing-run retry key cannot cross into another run",
      /another Cora run/i.test(wrongRun?.message ?? ""),
      wrongRun?.message,
    );

    const queue = new coraPolicy.KeyedSerialQueue();
    const order = [];
    let releaseFirst;
    const gate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const first = queue.run("ws1:phone-retry-2", async () => {
      order.push("first-start");
      await gate;
      order.push("first-end");
      return "first";
    });
    const second = queue.run("ws1:phone-retry-2", async () => {
      order.push("second-start");
      return "second";
    });
    await Promise.resolve();
    await Promise.resolve();
    check(
      "same-key Cora deliveries do not start concurrently",
      order.join(",") === "first-start",
      order,
    );
    releaseFirst();
    check(
      "same-key Cora deliveries settle in order",
      JSON.stringify(await Promise.all([first, second])) ===
        JSON.stringify(["first", "second"]) &&
        order.join(",") === "first-start,first-end,second-start",
      order,
    );
    await Promise.resolve();
    check(
      "settled Cora retry keys leave no queue entry",
      queue.size() === 0,
      queue.size(),
    );

    await queue
      .run("ws1:phone-retry-failed", async () => {
        throw new Error("simulated first delivery failure");
      })
      .catch(() => undefined);
    const recovered = await queue.run(
      "ws1:phone-retry-failed",
      async () => "retry-ran",
    );
    check(
      "a failed Cora delivery does not wedge its retry key",
      recovered === "retry-ran",
      recovered,
    );
  }

  /* ---- compact durable Cora send receipts ----------------------------- */

  {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "codara-cora-send-receipts-"),
    );
    let now = 1_800_000_000_000;
    const input = {
      workspaceId: "ws1",
      message: "TOP SECRET feature request",
      clientMessageId: "phone-lost-reply-1",
    };
    const persistedRun = {
      id: "run-receipt",
      workspaceId: "ws1",
      humanMessages: [
        {
          clientMessageId: input.clientMessageId,
          author: "user",
          kind: "note",
          message: input.message,
        },
      ],
    };
    try {
      const first = await coraSendReceipts.CoraSendReceiptIndex.open({
        rootDir: directory,
        now: () => now,
        maxRecords: 3,
        retentionMs: 1_000,
      });
      await Promise.all([
        first.record(input, persistedRun.id),
        first.record(input, persistedRun.id),
      ]);
      const durableText = fs.readFileSync(first.filePath, "utf8");
      check(
        "Cora send receipt persists only routing identities and a message digest",
        !durableText.includes(input.message) &&
          durableText.includes(input.clientMessageId) &&
          /"messageSha256":"[0-9a-f]{64}"/.test(durableText) &&
          first.listRecordsForTest().length === 1,
        durableText,
      );

      const restarted = await coraSendReceipts.CoraSendReceiptIndex.open({
        rootDir: directory,
        now: () => now,
        maxRecords: 3,
        retentionMs: 1_000,
      });
      let runReads = 0;
      const recovered = await restarted.resolve(input, async (runId) => {
        runReads += 1;
        return runId === persistedRun.id ? persistedRun : null;
      });
      check(
        "a lost-reply retry survives restart with exactly one indexed run read",
        recovered === persistedRun && runReads === 1,
        { recovered: recovered?.id, runReads },
      );

      let collision = null;
      runReads = 0;
      try {
        await restarted.resolve(
          { ...input, message: "different request" },
          async () => {
            runReads += 1;
            return persistedRun;
          },
        );
      } catch (error) {
        collision = error;
      }
      check(
        "receipt hash collisions are rejected before any run body read",
        collision?.code === "CORA_SEND_RECEIPT_CONFLICT" && runReads === 0,
        { message: collision?.message, runReads },
      );

      let wrongRun = null;
      try {
        await restarted.resolve(
          { ...input, runId: "run-other" },
          async () => persistedRun,
        );
      } catch (error) {
        wrongRun = error;
      }
      check(
        "receipt routes cannot be replayed into another run",
        wrongRun?.code === "CORA_SEND_RECEIPT_CONFLICT",
        wrongRun?.message,
      );

      let authoritativeCollision = null;
      runReads = 0;
      try {
        await restarted.resolve(input, async () => {
          runReads += 1;
          return {
            ...persistedRun,
            humanMessages: [
              {
                ...persistedRun.humanMessages[0],
                message: "tampered authoritative message",
              },
            ],
          };
        });
      } catch (error) {
        authoritativeCollision = error;
      }
      check(
        "receipt matches are collision-checked against the authoritative run message",
        authoritativeCollision?.code === "CORA_SEND_RECEIPT_CONFLICT" &&
          runReads === 1,
        { message: authoritativeCollision?.message, runReads },
      );

      const stale = await restarted.resolve(input, async () => ({
        ...persistedRun,
        humanMessages: [],
      }));
      const afterStaleRestart =
        await coraSendReceipts.CoraSendReceiptIndex.open({
          rootDir: directory,
          now: () => now,
          maxRecords: 3,
          retentionMs: 1_000,
        });
      check(
        "a stale receipt whose authoritative message vanished is removed safely",
        stale === null &&
          afterStaleRestart.listRecordsForTest().length === 0,
        afterStaleRestart.listRecordsForTest(),
      );

      await afterStaleRestart.record(input, persistedRun.id);
      const removed = await afterStaleRestart.removeRun("ws1", persistedRun.id);
      const afterDelete = await coraSendReceipts.CoraSendReceiptIndex.open({
        rootDir: directory,
        now: () => now,
      });
      check(
        "run deletion prunes all of its Cora send receipts durably",
        removed === 1 && afterDelete.listRecordsForTest().length === 0,
        { removed, records: afterDelete.listRecordsForTest() },
      );

      fs.writeFileSync(afterDelete.filePath, "{not-json", "utf8");
      const logs = [];
      const repaired = await coraSendReceipts.CoraSendReceiptIndex.open({
        rootDir: directory,
        now: () => now,
        log: (line) => logs.push(line),
      });
      await repaired.record(input, persistedRun.id);
      const afterCorruptRepair =
        await coraSendReceipts.CoraSendReceiptIndex.open({
          rootDir: directory,
          now: () => now,
          retentionMs: 1_000,
        });
      check(
        "a corrupt receipt index fails closed and repairs on the next committed receipt",
        logs.some((line) => /corrupt index/i.test(line)) &&
          afterCorruptRepair.listRecordsForTest().length === 1,
        { logs, records: afterCorruptRepair.listRecordsForTest() },
      );

      now += 1_001;
      await afterCorruptRepair.record(
        {
          workspaceId: "ws1",
          message: "fresh",
          clientMessageId: "phone-fresh",
        },
        "run-fresh",
      );
      check(
        "receipt retention prunes expired run routes instead of growing forever",
        afterCorruptRepair
          .listRecordsForTest()
          .every((record) => record.clientMessageId !== input.clientMessageId),
        afterCorruptRepair.listRecordsForTest(),
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }

  /* ---- framing ---------------------------------------------------------- */

  const frameA = rpc.encodeFrame({
    id: 1,
    method: "ping",
    params: { nonce: "n" },
  });
  check(
    "frame length prefix matches body",
    frameA.readUInt32BE(0) === frameA.length - 4,
  );

  const decoder = new rpc.FrameDecoder();
  // Two frames delivered across pathological chunk boundaries.
  const frameB = rpc.encodeFrame({ id: 2, ok: true, result: {} });
  const joined = Buffer.concat([frameA, frameB]);
  let decoded = [];
  for (let i = 0; i < joined.length; i += 3) {
    decoded = decoded.concat(
      decoder.push(joined.subarray(i, Math.min(i + 3, joined.length))),
    );
  }
  check("decoder reassembles frames across chunk splits", decoded.length === 2);
  check(
    "decoded frame round-trips",
    decoded[0].method === "ping" && decoded[1].id === 2,
  );

  // Oversize: the declared length alone must reject, before any body bytes.
  const big = Buffer.alloc(4);
  big.writeUInt32BE(rpc.MAX_FRAME_BYTES + 1, 0);
  let limitErr = null;
  try {
    new rpc.FrameDecoder().push(big);
  } catch (err) {
    limitErr = err;
  }
  check(
    "oversized declared frame throws FrameLimitError",
    limitErr?.name === "FrameLimitError",
  );

  const atLimit = new rpc.FrameDecoder(64);
  const smallFrame = rpc.encodeFrame({ pad: "x".repeat(20) });
  check(
    "frames under a custom limit pass",
    atLimit.push(smallFrame).length === 1,
  );

  /* ---- frame-count cap and linear buffering (item 2) -------------------- */

  // A single chunk that carries more than MAX_FRAMES_PER_PUSH complete frames
  // is treated as fatal, so a ~16 MiB write of tiny frames cannot turn into
  // millions of synchronous JSON.parse calls. Pre-fix the decoder returned
  // every frame with no cap.
  {
    const tiny = rpc.encodeFrame(0);
    const flood = Buffer.concat(
      Array.from({ length: rpc.MAX_FRAMES_PER_PUSH + 5 }, () => tiny),
    );
    let countErr = null;
    try {
      new rpc.FrameDecoder().push(flood);
    } catch (err) {
      countErr = err;
    }
    check(
      "a chunk over the per-push frame cap throws FrameCountError",
      countErr?.name === "FrameCountError",
      countErr?.name,
    );

    // Exactly at the cap is still accepted: the cap is a ceiling, not an
    // off-by-one.
    const atCap = Buffer.concat(
      Array.from({ length: rpc.MAX_FRAMES_PER_PUSH }, () => tiny),
    );
    check(
      "a chunk exactly at the per-push frame cap is accepted",
      new rpc.FrameDecoder().push(atCap).length === rpc.MAX_FRAMES_PER_PUSH,
    );

    // The declared-length cap still rejects before the body is buffered, even
    // when the body bytes never arrive: only the 4-byte prefix is present.
    const headerOnly = Buffer.alloc(4);
    headerOnly.writeUInt32BE(rpc.MAX_FRAME_BYTES + 1, 0);
    let limitErr2 = null;
    try {
      new rpc.FrameDecoder().push(headerOnly);
    } catch (err) {
      limitErr2 = err;
    }
    check(
      "oversize is rejected from the length prefix alone, no body",
      limitErr2?.name === "FrameLimitError",
    );

    // Byte-at-a-time delivery of a large frame reassembles correctly and
    // stays linear (the chunk-list buffer never re-copies consumed bytes).
    const bigBody = { blob: "q".repeat(200_000) };
    const bigFrame = rpc.encodeFrame(bigBody);
    const dripDecoder = new rpc.FrameDecoder();
    let dripped = [];
    const started = Date.now();
    for (let i = 0; i < bigFrame.length; i += 1) {
      dripped = dripped.concat(dripDecoder.push(bigFrame.subarray(i, i + 1)));
    }
    check(
      "byte-at-a-time delivery reassembles the frame",
      dripped.length === 1 && dripped[0].blob.length === 200_000,
    );
    check(
      "byte-at-a-time delivery stays fast (linear, not quadratic)",
      Date.now() - started < 4000,
      Date.now() - started,
    );
  }

  /* ---- rpc session ------------------------------------------------------ */

  // A minimal in-process duplex: write() parses server frames, push()
  // injects client bytes.
  // `writeAccepts` models Node's Writable contract: set it false to make
  // write() report backpressure, then call drain() to release it.
  function makeFakeStream() {
    const handlers = { data: [], close: [], error: [], drain: [] };
    const outDecoder = new rpc.FrameDecoder();
    const outbox = [];
    return {
      outbox,
      writeAccepts: true,
      write(buf) {
        for (const frame of outDecoder.push(buf)) outbox.push(frame);
        return this.writeAccepts;
      },
      destroyed: false,
      ended: false,
      end() {
        this.ended = true;
        for (const h of handlers.close) h();
      },
      destroy() {
        this.destroyed = true;
        for (const h of handlers.close) h();
      },
      on(event, handler) {
        handlers[event].push(handler);
      },
      inject(buf) {
        for (const h of handlers.data) h(buf);
      },
      drain() {
        this.writeAccepts = true;
        for (const h of handlers.drain) h();
      },
    };
  }

  // Device-scoped terminal store double. The registry itself has its own
  // focused tests; this double keeps the RPC suite about the wire contract:
  // stable retries, attachment generations, sequence cursors and disconnect
  // ownership.
  function makeTerminalLeaseStore(createTerminal) {
    const leases = new Map();
    const createReceipts = new Map();
    const closeReceipts = new Map();
    const calls = [];
    let terminalSerial = 0;
    let attachmentSerial = 0;

    const leaseError = (code, message) =>
      Object.assign(new Error(message), { code });
    const copyDescriptor = (lease) => ({ ...lease.descriptor });
    const requireOwned = (ownerKey, terminalId) => {
      const lease = leases.get(terminalId);
      if (!lease || lease.ownerKey !== ownerKey) {
        throw leaseError(
          "UNKNOWN_REMOTE_TERMINAL",
          "That remote terminal is no longer available.",
        );
      }
      return lease;
    };
    const requireAttached = (
      ownerKey,
      terminalId,
      subscriberId,
      attachmentId,
    ) => {
      const lease = requireOwned(ownerKey, terminalId);
      if (
        lease.subscriber?.subscriberId !== subscriberId ||
        lease.subscriber?.attachmentId !== attachmentId
      ) {
        throw leaseError(
          "STALE_TERMINAL_ATTACHMENT",
          "This terminal moved to a newer connection.",
        );
      }
      return lease;
    };

    return {
      calls,
      leases,
      async createInteractive(ownerKey, requestId, request) {
        calls.push(["createInteractive", ownerKey, requestId, request]);
        const fingerprint = JSON.stringify(request);
        const receiptKey = `${ownerKey}\0${requestId}`;
        const prior = createReceipts.get(receiptKey);
        if (prior) {
          if (prior.fingerprint !== fingerprint) {
            throw leaseError(
              "TERMINAL_CREATE_CONFLICT",
              "That create retry id was reused for different input.",
            );
          }
          return copyDescriptor(requireOwned(ownerKey, prior.terminalId));
        }
        const terminalId = `lease-${++terminalSerial}`;
        const lease = {
          ownerKey,
          descriptor: {
            terminalId,
            workspaceId: request.workspaceId,
            kind: "interactive",
            phase: "starting",
            profile: request.profile,
            cols: request.cols,
            rows: request.rows,
            createdAt: 1_700_000_000_000 + terminalSerial,
            sequence: 0,
            nextInputSequence: 1,
          },
          replay: [],
          subscriber: null,
          acceptedInputs: new Map(),
          handle: null,
        };
        leases.set(terminalId, lease);
        createReceipts.set(receiptKey, { fingerprint, terminalId });
        const handle = await createTerminal({
          ...request,
          onData(data) {
            lease.descriptor.sequence += 1;
            const event = {
              terminalId,
              sequence: lease.descriptor.sequence,
              data,
            };
            lease.replay.push(event);
            lease.subscriber?.callbacks.onData(event);
          },
          onExit() {
            if (lease.descriptor.phase === "ended") return;
            lease.descriptor.phase = "ended";
            lease.descriptor.sequence += 1;
            lease.subscriber?.callbacks.onExit({
              terminalId,
              sequence: lease.descriptor.sequence,
            });
          },
        });
        lease.handle = handle;
        lease.descriptor.phase = "live";
        if (handle.desktopTabId)
          lease.descriptor.desktopTabId = handle.desktopTabId;
        if (handle.title) lease.descriptor.title = handle.title;
        return copyDescriptor(lease);
      },
      list(ownerKey) {
        calls.push(["list", ownerKey]);
        return [...leases.values()]
          .filter((lease) => lease.ownerKey === ownerKey)
          .map(copyDescriptor);
      },
      attach(ownerKey, terminalId, afterSequence, subscriberId, callbacks) {
        calls.push([
          "attach",
          ownerKey,
          terminalId,
          afterSequence,
          subscriberId,
        ]);
        const lease = requireOwned(ownerKey, terminalId);
        if (
          !Number.isSafeInteger(afterSequence) ||
          afterSequence < 0 ||
          afterSequence > lease.descriptor.sequence
        ) {
          throw leaseError(
            "INVALID_TERMINAL_CURSOR",
            "That terminal cursor is invalid.",
          );
        }
        const attachmentId = `attachment-${++attachmentSerial}`;
        lease.subscriber = { subscriberId, attachmentId, callbacks };
        return {
          terminal: copyDescriptor(lease),
          replay: lease.replay
            .filter((event) => event.sequence > afterSequence)
            .map(({ sequence, data }) => ({ sequence, data })),
          truncated: false,
          attachmentId,
        };
      },
      detach(ownerKey, terminalId, subscriberId, attachmentId) {
        calls.push([
          "detach",
          ownerKey,
          terminalId,
          subscriberId,
          attachmentId,
        ]);
        const lease = requireOwned(ownerKey, terminalId);
        if (
          lease.subscriber?.subscriberId === subscriberId &&
          lease.subscriber?.attachmentId === attachmentId
        ) {
          lease.subscriber = null;
        }
      },
      detachSubscriber(subscriberId) {
        calls.push(["detachSubscriber", subscriberId]);
        for (const lease of leases.values()) {
          if (lease.subscriber?.subscriberId === subscriberId) {
            lease.subscriber = null;
          }
        }
      },
      write(
        ownerKey,
        terminalId,
        subscriberId,
        attachmentId,
        inputSequence,
        data,
      ) {
        calls.push([
          "write",
          ownerKey,
          terminalId,
          subscriberId,
          attachmentId,
          inputSequence,
          data,
        ]);
        const lease = requireAttached(
          ownerKey,
          terminalId,
          subscriberId,
          attachmentId,
        );
        const accepted = lease.acceptedInputs.get(inputSequence);
        if (accepted !== undefined) {
          if (accepted !== data) {
            throw leaseError(
              "TERMINAL_INPUT_CONFLICT",
              "That input sequence was reused for different data.",
            );
          }
          return;
        }
        if (inputSequence !== lease.descriptor.nextInputSequence) {
          throw leaseError(
            "TERMINAL_INPUT_GAP",
            "Terminal input arrived out of order.",
          );
        }
        lease.acceptedInputs.set(inputSequence, data);
        lease.descriptor.nextInputSequence += 1;
        lease.handle.write(data);
      },
      async resize(
        ownerKey,
        terminalId,
        subscriberId,
        attachmentId,
        cols,
        rows,
      ) {
        calls.push([
          "resize",
          ownerKey,
          terminalId,
          subscriberId,
          attachmentId,
          cols,
          rows,
        ]);
        const lease = requireAttached(
          ownerKey,
          terminalId,
          subscriberId,
          attachmentId,
        );
        await lease.handle.resize(cols, rows);
        lease.descriptor.cols = cols;
        lease.descriptor.rows = rows;
      },
      close(
        ownerKey,
        terminalId,
        subscriberId,
        attachmentId,
        requestId,
      ) {
        calls.push([
          "close",
          ownerKey,
          terminalId,
          subscriberId,
          attachmentId,
          requestId,
        ]);
        const receiptKey = `${ownerKey}\0${requestId}`;
        const prior = closeReceipts.get(receiptKey);
        if (prior) {
          if (prior !== terminalId) {
            throw leaseError(
              "TERMINAL_CLOSE_CONFLICT",
              "That close retry id was reused for another terminal.",
            );
          }
          return;
        }
        const lease = requireAttached(
          ownerKey,
          terminalId,
          subscriberId,
          attachmentId,
        );
        closeReceipts.set(receiptKey, terminalId);
        lease.handle.close();
        leases.delete(terminalId);
      },
      revokeOwner(ownerKey) {
        calls.push(["revokeOwner", ownerKey]);
        for (const [terminalId, lease] of leases) {
          if (lease.ownerKey !== ownerKey) continue;
          lease.handle?.close();
          leases.delete(terminalId);
        }
      },
      shutdown() {
        calls.push(["shutdown"]);
        for (const lease of leases.values()) lease.handle?.close();
        leases.clear();
      },
    };
  }

  const madeTerminals = [];
  const services = {
    device: {
      publicKey: "pk",
      name: "Studio",
      role: "computer",
      version: "0.0.0",
    },
    listWorkspaces: async () => [{ id: "ws1", name: "One", path: "/tmp/one" }],
    createTerminal: async (request) => {
      const terminal = {
        request,
        closed: false,
        paused: false,
        written: [],
        write(data) {
          this.written.push(data);
        },
        resize() {},
        pause() {
          this.paused = true;
        },
        resume() {
          this.paused = false;
        },
        close() {
          this.closed = true;
        },
      };
      madeTerminals.push(terminal);
      return terminal;
    },
  };

  const stream = makeFakeStream();
  const session = new rpc.RpcSession(stream, services);
  const request = (id, method, params) =>
    stream.inject(rpc.encodeFrame({ id, method, params }));
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  request(1, "workspaces.list", {});
  await flush();
  check(
    "methods before hello are refused",
    stream.outbox[0]?.ok === false &&
      stream.outbox[0]?.error.code === "not-connected",
    stream.outbox[0],
  );

  request(2, "hello", { protocol: 99, device: services.device });
  await flush();
  check(
    "wrong protocol version is refused",
    stream.outbox[1]?.ok === false &&
      stream.outbox[1]?.error.code === "unsupported-protocol",
  );

  request(3, "hello", {
    protocol: rpc.RPC_PROTOCOL_VERSION,
    device: { publicKey: "c", name: "Phone", role: "phone", version: "1" },
  });
  await flush();
  check(
    "hello succeeds and reports our device",
    stream.outbox[2]?.ok === true &&
      stream.outbox[2]?.result.device.role === "computer",
    stream.outbox[2],
  );

  request(4, "workspaces.list", {});
  await flush();
  check(
    "workspaces.list answers",
    stream.outbox[3]?.result.workspaces[0].id === "ws1",
  );

  request(5, "terminal.create", { workspaceId: "ws1", cols: 80, rows: 24 });
  await flush();
  const terminalId = stream.outbox[4]?.result?.terminalId;
  check(
    "terminal.create returns an id",
    typeof terminalId === "string",
    stream.outbox[4],
  );

  madeTerminals[0].request.onData("hi from pty");
  check(
    "legacy pty output arrives as a sequenced terminal.data event",
    stream.outbox[5]?.event === "terminal.data" &&
      stream.outbox[5]?.payload.data === "hi from pty" &&
      stream.outbox[5]?.payload.sequence === 1,
    stream.outbox[5],
  );

  request(6, "terminal.write", { terminalId, data: "echo x\n" });
  await flush();
  check(
    "terminal.write reaches the pty",
    madeTerminals[0].written[0] === "echo x\n",
  );

  request(7, "terminal.write", { terminalId: "rt-nope", data: "x" });
  await flush();
  check(
    "unknown terminal id errors cleanly",
    stream.outbox[7]?.ok === false &&
      stream.outbox[7]?.error.code === "unknown-terminal",
  );

  // Per-connection terminal cap.
  for (let i = 0; i < rpc.MAX_TERMINALS_PER_CONNECTION; i += 1) {
    request(10 + i, "terminal.create", {
      workspaceId: "ws1",
      cols: 80,
      rows: 24,
    });
  }
  await flush();
  // Replies interleave (cap refusals are synchronous, successes resolve a
  // spawn later), so search rather than assume ordering: of the 8 creates,
  // 7 fill the cap (one terminal already exists) and exactly 1 is refused.
  const refused = stream.outbox.filter(
    (frame) =>
      frame?.ok === false && /terminals open/.test(frame?.error?.message ?? ""),
  );
  check(
    "terminal cap refuses the create over the limit",
    refused.length === 1,
    refused.length,
  );
  check(
    "session tracks the capped terminal count",
    session.terminalCount() === rpc.MAX_TERMINALS_PER_CONNECTION,
  );

  // A bare RpcSession has no process-wide lease store. It deliberately keeps
  // the old connection-owned behavior used by isolated embedders and tests.
  session.destroy();
  check(
    "a bare RpcSession disconnect closes every legacy session-owned terminal",
    madeTerminals.every((t) => t.closed),
  );
  check("destroy tears the stream down", stream.destroyed === true);

  // Revocation is an authenticated terminal condition, unlike an ordinary
  // Studio shutdown. It removes session access synchronously but gracefully
  // flushes one control event so the phone suppresses its reconnect loop.
  {
    const revokedStream = makeFakeStream();
    const revokedSession = new rpc.RpcSession(revokedStream, services);
    revokedStream.inject(
      rpc.encodeFrame({
        id: 1,
        method: "hello",
        params: {
          protocol: rpc.RPC_PROTOCOL_VERSION,
          device: services.device,
        },
      }),
    );
    await flush();
    const before = revokedStream.outbox.length;
    revokedSession.revoke();
    check(
      "revocation sends its authenticated terminal reason before closing",
      revokedStream.outbox[before]?.event === "session.revoked" &&
        revokedStream.ended === true,
      revokedStream.outbox.slice(before),
    );
    revokedStream.inject(
      rpc.encodeFrame({ id: 2, method: "ping", params: { nonce: "late" } }),
    );
    await flush();
    check(
      "a revoked session cannot process another request while its notice flushes",
      revokedStream.outbox.length === before + 1,
      revokedStream.outbox.slice(before),
    );
  }

  // Oversized inbound frame drops the connection.
  const stream2 = makeFakeStream();
  void new rpc.RpcSession(stream2, services);
  const evil = Buffer.alloc(4);
  evil.writeUInt32BE(rpc.MAX_FRAME_BYTES + 1, 0);
  stream2.inject(evil);
  check(
    "oversized inbound frame destroys the session",
    stream2.destroyed === true,
  );
  check(
    "no reply is sent for a framing violation",
    stream2.outbox.length === 0,
  );

  // Individually valid async requests still need a concurrency ceiling. A
  // paired but compromised phone must not fan out unbounded filesystem/git/
  // Cora work while earlier calls are still pending.
  {
    const held = [];
    let started = 0;
    const limitedStream = makeFakeStream();
    const limitedSession = new rpc.RpcSession(limitedStream, {
      ...services,
      listWorkspaces: () => {
        started += 1;
        return new Promise((resolve) => held.push(resolve));
      },
    });
    const limitedRequest = (id, method, params) =>
      limitedStream.inject(rpc.encodeFrame({ id, method, params }));
    limitedRequest(1, "hello", {
      protocol: rpc.RPC_PROTOCOL_VERSION,
      device: {
        publicKey: "phone",
        name: "Phone",
        role: "phone",
        version: "1",
      },
    });
    await flush();
    for (let i = 0; i < rpc.MAX_IN_FLIGHT_REQUESTS + 1; i += 1) {
      limitedRequest(100 + i, "workspaces.list", {});
    }
    await flush();
    const overflowId = 100 + rpc.MAX_IN_FLIGHT_REQUESTS;
    check(
      "async RPC work is capped per connection",
      started === rpc.MAX_IN_FLIGHT_REQUESTS,
      started,
    );
    check(
      "a request beyond the async-work cap receives a bounded error",
      limitedStream.outbox.some(
        (frame) =>
          frame?.id === overflowId &&
          frame?.ok === false &&
          /already in progress/i.test(frame?.error?.message ?? ""),
      ),
      limitedStream.outbox.at(-1),
    );
    for (const release of held) release([]);
    await flush();
    limitedRequest(1000, "workspaces.list", {});
    await flush();
    check(
      "the async-work slot is released when a request settles",
      started === rpc.MAX_IN_FLIGHT_REQUESTS + 1,
      started,
    );
    held.at(-1)([]);
    await flush();
    limitedSession.destroy();
  }

  /* ---- fatal frame abandons the rest of its chunk (item 7) ------------- */

  // A malformed frame and a valid terminal.create delivered in ONE decrypted
  // chunk: the malformed frame destroys the session synchronously, and the
  // create that follows it in the same chunk must never reach the spawn path.
  {
    const stream3 = makeFakeStream();
    void new rpc.RpcSession(stream3, services);
    stream3.inject(
      rpc.encodeFrame({
        id: 1,
        method: "hello",
        params: {
          protocol: rpc.RPC_PROTOCOL_VERSION,
          device: services.device,
        },
      }),
    );
    await flush();
    const before = madeTerminals.length;
    const malformed = rpc.encodeFrame(12345); // a bare number is not a request
    const create = rpc.encodeFrame({
      id: 2,
      method: "terminal.create",
      params: { workspaceId: "ws1", cols: 80, rows: 24 },
    });
    stream3.inject(Buffer.concat([malformed, create]));
    await flush();
    check("a fatal frame destroys the session", stream3.destroyed === true);
    check(
      "a terminal.create after a fatal frame in the same chunk never spawns",
      madeTerminals.length === before,
      madeTerminals.length - before,
    );
  }

  /* ---- outbound backpressure (F5) --------------------------------------- */

  const bpStream = makeFakeStream();
  void new rpc.RpcSession(bpStream, services);
  const bpRequest = (id, method, params) =>
    bpStream.inject(rpc.encodeFrame({ id, method, params }));
  bpRequest(1, "hello", {
    protocol: rpc.RPC_PROTOCOL_VERSION,
    device: services.device,
  });
  await flush();
  bpRequest(2, "terminal.create", { workspaceId: "ws1", cols: 80, rows: 24 });
  await flush();
  const bpTerminal = madeTerminals[madeTerminals.length - 1];
  check("a fresh terminal is not paused", bpTerminal.paused === false);

  // The peer stops draining: the next write reports backpressure, which
  // must stop the pty rather than let us buffer without limit.
  bpStream.writeAccepts = false;
  bpTerminal.request.onData("x".repeat(100));
  check("backpressure pauses the pty", bpTerminal.paused === true);

  // Past the cap, output is dropped instead of queued.
  const beforeDrop = bpStream.outbox.length;
  for (let i = 0; i < 20; i += 1) {
    bpTerminal.request.onData("y".repeat(100_000));
  }
  const emitted = bpStream.outbox.length - beforeDrop;
  check(
    "queued output past the cap is dropped, not buffered",
    emitted * 100_000 <= rpc.MAX_PENDING_EVENT_BYTES,
    emitted,
  );

  bpStream.drain();
  check("drain resumes the pty", bpTerminal.paused === false);
  const afterDrain = bpStream.outbox.length;
  bpTerminal.request.onData("z");
  check(
    "output flows again after drain",
    bpStream.outbox.length === afterDrain + 1,
  );

  /* ---- all writes gated, paused-birth terminals (item 6) --------------- */

  {
    const g = makeFakeStream();
    void new rpc.RpcSession(g, services);
    const greq = (id, method, params) =>
      g.inject(rpc.encodeFrame({ id, method, params }));
    greq(1, "hello", {
      protocol: rpc.RPC_PROTOCOL_VERSION,
      device: services.device,
    });
    await flush();
    // Back the peer up first, then create a terminal: it must be born paused
    // so its opening burst is held at the pty, not produced into a paused
    // session and dropped.
    g.writeAccepts = false;
    greq(2, "ping", { nonce: "x" }); // a reply that returns backpressure
    await flush();
    greq(3, "terminal.create", { workspaceId: "ws1", cols: 80, rows: 24 });
    await flush();
    const born = madeTerminals[madeTerminals.length - 1];
    check(
      "a terminal created while backpressured is born paused",
      born.paused === true,
    );

    // A peer that never drains but keeps forcing replies must not grow our
    // write queue without bound: past MAX_PENDING_WRITE_BYTES the session is
    // destroyed rather than buffered forever. Ordinary replies, not just
    // terminal events, are what this bounds.
    let guard = 0;
    while (!g.destroyed && guard < 5000) {
      greq(100 + guard, "ping", { nonce: "y".repeat(4000) });
      guard += 1;
      if (guard % 200 === 0) await flush();
    }
    await flush();
    check(
      "a peer that will not drain replies has its session closed",
      g.destroyed === true,
      guard,
    );
  }

  /* ---- additive desktop services + terminal event ordering ------------- */

  {
    const calls = [];
    let coraHistoryTitle = "Remote work";
    let coraWorkerActivity = "Read src/main/index.ts";
    let sharedTerminal = null;
    const sharedTerminals = [];
    let sharedWorkerTerminal = null;
    const uploadedImageChunks = [];
    let imageUploadAborts = 0;
    const workerControlRegistry =
      new workerTerminalControls.WorkerTerminalControlRegistry();
    const extendedServices = {
      ...services,
      peerDevice: {
        publicKey: "trusted-phone-key",
        name: "Etienne's iPhone",
        role: "phone",
        version: "1",
      },
      listDirectories: async (requestedPath) => {
        calls.push(["directories.list", requestedPath]);
        return {
          path: "/Users/e/Projects",
          parentPath: "/Users/e",
          rootPath: "/Users/e",
          directories: [{ name: "Codara", path: "/Users/e/Projects/Codara" }],
        };
      },
      addWorkspace: async (input) => {
        calls.push(["workspaces.add", input]);
        return {
          id: "ws-added",
          name: input.name ?? "Added",
          path: input.path,
          color: "#2AA298",
          branch: "main",
        };
      },
      listWorkspaceOrganization: async () => ({
        groups: [{ id: "group-studio", name: "Studio", collapsed: false }],
        railOrder: ["group-studio"],
      }),
      getFleetOverview: async () => {
        calls.push(["fleet.overview"]);
        return {
          workspaces: [
            {
              id: "ws1",
              name: "One",
              color: "#2AA298",
              branch: "main",
              conversationCount: 3,
              latestConversation: {
                status: "running",
                updatedAt: "2026-07-30T09:00:00.000Z",
              },
              activeConversationWorkers: 2,
              activeAutomations: 1,
            },
          ],
        };
      },
      listSubscriptionProfiles: async () => {
        calls.push(["subscriptions.list"]);
        return [
          {
            id: "11111111-1111-4111-8111-111111111111",
            provider: "openai-codex",
            label: "Codex Max 2",
            status: "unknown",
            isDefault: true,
          },
        ];
      },
      listNativeCliAccounts: async () => {
        calls.push(["nativeCliAccounts.list"]);
        return [
          {
            id: "personal",
            runtime: "claude",
            label: "Claude personal",
            status: "connected",
            isDefault: true,
          },
          {
            id: "22222222-2222-4222-8222-222222222222",
            runtime: "codex",
            label: "Codex Max 2",
            status: "connected",
            isDefault: false,
          },
        ];
      },
      createWorkspaceGroup: async (name) => {
        calls.push(["workspaces.group.create", name]);
        return { id: "group-new", name, collapsed: false };
      },
      updateWorkspaceGroup: async (input) => {
        calls.push(["workspaces.group.update", input]);
        return {
          id: input.groupId,
          name: input.name ?? "Studio",
          collapsed: input.collapsed ?? false,
        };
      },
      deleteWorkspaceGroup: async (groupId) => {
        calls.push(["workspaces.group.delete", groupId]);
      },
      moveWorkspace: async (input) => {
        calls.push(["workspaces.move", input]);
        return {
          id: input.workspaceId,
          name: "One",
          path: "/tmp/one",
          ...(input.groupId ? { groupId: input.groupId } : {}),
        };
      },
      reorderWorkspaceRail: async (input) => {
        calls.push(["workspaces.rail.move", input]);
      },
      listFiles: async (input) => {
        calls.push(["files.list", input]);
        return {
          path: input.path ?? "",
          parentPath: input.path ? "" : null,
          entries: [{ name: "src", path: "src", isDir: true }],
        };
      },
      readFile: async (input) => {
        calls.push(["files.read", input]);
        return {
          path: input.path,
          name: "index.ts",
          content: "export {};",
          size: 10,
          mtimeMs: 12,
        };
      },
      createFileEntry: async (input) => {
        calls.push(["files.create", input]);
        return {
          name: input.name,
          path: `${input.parentPath ? `${input.parentPath}/` : ""}${input.name}`,
          isDir: input.kind === "directory",
        };
      },
      renameFileEntry: async (input) => {
        calls.push(["files.rename", input]);
        const parent = input.path.includes("/")
          ? input.path.slice(0, input.path.lastIndexOf("/") + 1)
          : "";
        return {
          name: input.name,
          path: `${parent}${input.name}`,
          isDir: false,
        };
      },
      moveFileEntry: async (input) => {
        calls.push(["files.move", input]);
        if (input.requestId === "move-conflict") {
          throw Object.assign(new Error("conflicting replay"), {
            code: "MUTATION_REQUEST_CONFLICT",
          });
        }
        if (input.requestId === "move-unknown") {
          throw Object.assign(new Error("move may already have completed"), {
            code: "MUTATION_OUTCOME_UNKNOWN",
          });
        }
        const name = input.path.split("/").at(-1);
        return {
          name,
          path: `${input.destinationPath ? `${input.destinationPath}/` : ""}${name}`,
          isDir: false,
        };
      },
      deleteFileEntry: async (input) => {
        calls.push(["files.delete", input]);
        return {
          deletedPath: input.path,
          parentPath: input.path.includes("/")
            ? input.path.slice(0, input.path.lastIndexOf("/"))
            : "",
        };
      },
      getGitStatus: async (workspaceId) => {
        calls.push(["git.status", workspaceId]);
        return {
          isRepo: true,
          branch: "main",
          detached: false,
          ahead: 1,
          behind: 0,
          staged: [],
          unstaged: [{ path: "src/index.ts", status: "modified" }],
          hasConflicts: false,
        };
      },
      getGitLog: async (input) => {
        calls.push(["git.log", input]);
        return {
          isRepo: true,
          commits: [
            {
              hash: "a".repeat(40),
              shortHash: "aaaaaaa",
              subject: "Remote history",
              author: "Codara",
              relativeDate: "now",
              parentHashes: [],
              refs: ["main"],
              isHead: true,
            },
          ],
        };
      },
      getGitCommitDetail: async (input) => {
        calls.push(["git.commitDetail", input]);
        return {
          hash: input.hash,
          shortHash: input.hash.slice(0, 7),
          subject: "Remote history",
          body: "Commit body",
          author: "Codara",
          authorEmail: "codara@example.com",
          relativeDate: "now",
          isoDate: "2026-01-01T00:00:00.000Z",
          parentHashes: [],
          refs: ["main"],
          isHead: true,
          files: [
            {
              path: "src/index.ts",
              status: "modified",
              additions: 2,
              deletions: 1,
            },
          ],
        };
      },
      getGitHubStatus: async (workspaceId) => {
        calls.push(["github.status", workspaceId]);
        return {
          kind: "ready",
          repository: {
            owner: "codara",
            name: "studio",
            nameWithOwner: "codara/studio",
            url: "https://github.com/codara/studio",
            hostname: "github.com",
            defaultBranch: "main",
          },
          pullRequest: null,
          issues: [],
        };
      },
      getGitHubWorkQueue: async (input) => {
        const callsSoFar = calls.filter(
          ([method]) => method === "github.workQueue",
        ).length;
        calls.push(["github.workQueue", input]);
        return {
          kind: "ready",
          refreshedAt: new Date(
            Date.UTC(2026, 6, 31, 12, 0, callsSoFar),
          ).toISOString(),
          repositoriesScanned: 1,
          items: [],
          errors: [],
          truncated: {
            sourceRootsOmitted: 0,
            repositoriesOmitted: 0,
            workspaceJoinsOmitted: 0,
            errorsOmitted: 0,
            itemsOmitted: 0,
            payloadBytes: false,
          },
        };
      },
      publishGitHub: async (input) => {
        calls.push(["github.publish", input]);
        if (input.requestId === "publish-conflict") {
          throw Object.assign(new Error("conflicting publish replay"), {
            code: "MUTATION_REQUEST_CONFLICT",
          });
        }
        return {
          ok: true,
          receipts: [
            {
              phase: "validate",
              status: "completed",
              message: "Input validated.",
            },
            {
              phase: "create",
              status: "completed",
              message: "Pull request created.",
            },
          ],
          branch: "feature/remote-publish",
          base: "main",
          committed: true,
          commitHash: "b".repeat(40),
          pushed: true,
          outcome: "created",
          pullRequest: {
            number: 42,
            title: input.input.title,
            url: "https://github.com/codara/studio/pull/42",
            state: "OPEN",
            isDraft: input.input.draft,
            baseBranch: "main",
            headBranch: "feature/remote-publish",
            checks: { total: 0, successful: 0, failed: 0, pending: 0 },
          },
        };
      },
      markGitHubReady: async (input) => {
        calls.push(["github.ready", input]);
        if (input.requestId === "ready-conflict") {
          throw Object.assign(new Error("conflicting mark-ready replay"), {
            code: "MUTATION_REQUEST_CONFLICT",
          });
        }
        return {
          ok: true,
          outcome: "ready",
          receipts: [
            {
              phase: "verify",
              status: "completed",
              message: "Confirmed ready for review.",
            },
          ],
          pullRequest: {
            number: input.input.pullRequestNumber,
            title: "Ready for review",
            url: "https://github.com/codara/studio/pull/42",
            state: "OPEN",
            isDraft: false,
            baseBranch: input.input.baseBranch,
            headBranch: input.input.headBranch,
            headCommitOid: input.input.expectedHeadCommitOid,
            checks: { total: 0, successful: 0, failed: 0, pending: 0 },
          },
        };
      },
      mergeGitHub: async (input) => {
        calls.push(["github.merge", input]);
        if (input.requestId === "merge-conflict") {
          throw Object.assign(new Error("conflicting merge replay"), {
            code: "MUTATION_REQUEST_CONFLICT",
          });
        }
        return {
          ok: true,
          outcome: "merged",
          strategy: input.input.strategy,
          receipts: [
            {
              phase: "verify",
              status: "completed",
              message: "Confirmed merged.",
            },
          ],
          pullRequest: {
            number: input.input.pullRequestNumber,
            title: "Merged safely",
            url: "https://github.com/codara/studio/pull/42",
            state: "MERGED",
            isDraft: false,
            baseBranch: input.input.baseBranch,
            headBranch: input.input.headBranch,
            headCommitOid: input.input.expectedHeadCommitOid,
            reviewDecision: "APPROVED",
            mergeStateStatus: "UNKNOWN",
            checks: { total: 2, successful: 2, failed: 0, pending: 0 },
          },
        };
      },
      startGitHubIssue: async (input) => {
        calls.push(["github.issue.start", input]);
        if (input.requestId === "issue-start-conflict") {
          throw Object.assign(new Error("conflicting issue replay"), {
            code: "MUTATION_REQUEST_CONFLICT",
          });
        }
        return {
          ok: true,
          outcome: "created",
          workspaceId: "ws-issue-123",
          runId: "run-issue-123",
          branch: "codara/issue-123-fix-mobile",
          activated: true,
        };
      },
      startGitHubPullRequest: async (input) => {
        calls.push(["github.pullRequest.start", input]);
        if (input.requestId === "pr-start-conflict") {
          throw Object.assign(new Error("conflicting PR replay"), {
            code: "MUTATION_REQUEST_CONFLICT",
          });
        }
        return {
          ok: true,
          outcome: "created",
          workspaceId: "ws-pr-42",
          runId: "run-pr-42",
          branch: "codara/pr/example/42/mobile-queue",
          activated: true,
        };
      },
      listCoraHistory: async (workspaceId) => {
        calls.push(["cora.history", workspaceId]);
        return [
          {
            id: "run-1",
            workspaceId,
            title: coraHistoryTitle,
            status: "running",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:01:00.000Z",
            messageCount: 1,
            lastMessage: "hello",
            activeWorkers: 1,
          },
          ...Array.from({ length: 11 }, (_, index) => ({
            id: `run-history-${index + 2}`,
            workspaceId,
            title: `Older conversation ${index + 2}`,
            status: "complete",
            createdAt: `2025-12-31T23:59:${String(index).padStart(2, "0")}.000Z`,
            updatedAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
            messageCount: index + 2,
            lastMessage: "older summary",
            activeWorkers: 0,
          })),
        ];
      },
      getCoraRun: async (input) => {
        calls.push(["cora.get", input]);
        const run = {
          id: input.runId,
          workspaceId: input.workspaceId,
          title: "Remote work",
          status: "running",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:01:00.000Z",
          messageCount: 1,
          activeWorkers: 1,
          messages: [
            {
              id: "message-1",
              author: "cora",
              kind: "note",
              message: "hello",
              createdAt: "2026-01-01T00:01:00.000Z",
            },
          ],
          workers: [
            {
              id: "attempt-1",
              title: "Inspect the renderer",
              runtime: "claude",
              status: "running",
              runtimeState: "working",
              ...(coraWorkerActivity
                ? { runtimeActivity: coraWorkerActivity }
                : {}),
            },
          ],
        };
        return {
          run,
          cursor: "cursor-current",
          ...(input.afterCursor === "cursor-base"
            ? {
                messageDelta: {
                  afterCursor: input.afterCursor,
                  windowStartId: "message-1",
                  windowEndId: "message-1",
                  windowCount: 1,
                  messages: run.messages,
                },
              }
            : {}),
        };
      },
      getCoraGraph: async (input) => {
        calls.push(["cora.graph.get", input]);
        return {
          id: input.runId,
          workspaceId: input.workspaceId,
          title: "Remote work",
          status: "running",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:01:00.000Z",
          messageCount: 200,
          activeWorkers: 1,
          messages: [],
          currentStepId: "step-1",
          steps: [{ id: "step-1", title: "Implement", status: "running" }],
          stepsTotal: 1,
          stepsFinished: 0,
          workers: [
            {
              id: "attempt-1",
              stepId: "step-1",
              title: "Implement",
              runtime: "codex",
              status: "running",
            },
          ],
        };
      },
      deleteCoraRun: async (input) => {
        calls.push(["cora.delete", input]);
      },
      resumeCoraRun: async (input) => {
        calls.push(["cora.resume", input]);
        return {
          outcome: "accepted",
          recoveryId: input.recoveryId,
        };
      },
      sendCoraMessage: async (input) => {
        calls.push(["cora.send", input]);
        if (input.clientMessageId === "phone-message-too-large-service") {
          throw Object.assign(
            new Error("Cora messages are limited to 16 KiB."),
            { code: "CORA_MESSAGE_TOO_LARGE" },
          );
        }
        const fullMessages = Array.from({ length: 200 }, (_, index) => ({
          id: `message-${index + 1}`,
          author: index === 199 ? "user" : "cora",
          kind: "note",
          message:
            index === 199
              ? input.message
              : `${String(index + 1).padStart(3, "0")}:${"x".repeat(1024)}`,
          createdAt: "2026-01-01T00:01:00.000Z",
        }));
        const run = {
          id: input.runId ?? "run-new",
          workspaceId: input.workspaceId,
          title: "Remote work",
          status: "planning",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:01:00.000Z",
          messageCount: fullMessages.length,
          activeWorkers: 0,
          messages: fullMessages,
        };
        return {
          run,
          cursor: "cursor-after-send",
          ...(input.afterCursor === "cursor-before-send"
            ? {
                messageDelta: {
                  afterCursor: input.afterCursor,
                  windowStartId: "message-2",
                  windowEndId: "message-200",
                  windowCount: 200,
                  messages: [fullMessages.at(-1)],
                },
              }
            : {}),
        };
      },
      listWorkerSessions: async (input) => {
        calls.push(["workerSessions.list", input]);
        return [
          {
            runtime: input.runtime,
            sessionId: "session-codex-1",
            title: "Continue the mobile terminal",
            updatedAt: "2026-07-28T20:00:00.000Z",
          },
        ];
      },
      deleteWorkerSession: async (input) => {
        calls.push(["workerSessions.delete", input]);
        return {
          deleted: true,
          memoryDeleted: input.memoryScope !== "none",
          memoryScope: input.memoryScope,
          warnings: ["Codex's delete command failed"],
        };
      },
      getAutomation: async (input) => {
        calls.push(["automations.get", input]);
        return {
          id: input.automationId,
          name: "Nightly sweep",
          enabled: true,
          status: "idle",
          triggerKind: "cron",
          triggerSummary: "Every night at 02:00",
          iteration: 3,
          model: "claude-opus-5",
          effort: "high",
          prompt: "Review yesterday's diffs",
          liveRun: {
            id: "run-loom-live",
            status: "running",
            workers: [
              {
                id: "attempt-live-1",
                title: "Inspect the renderer",
                runtime: "codex",
                model: "gpt-5.6-codex",
                status: "running",
                runtimeState: "working",
              },
            ],
          },
          history: [
            {
              iteration: 2,
              runId: "run-loom-2",
              startedAt: "2026-07-29T02:00:00.000Z",
              finishedAt: "2026-07-29T02:11:00.000Z",
              status: "complete",
              summary: "Nothing to fix",
              costUsd: 0.42,
              stopReason: "agent-done",
            },
          ],
        };
      },
      getCoraWhiteboard: async (input) => {
        calls.push(["cora.whiteboard.get", input]);
        if (input.runId === "run-blank") return null;
        return {
          title: "How the phone reads a run",
          summary: "Flattened for the phone",
          nodes: [
            { id: "n1", kind: "topic", title: "Remote access" },
            { id: "n2", kind: "risk", title: "Frame budget", tone: "warning" },
          ],
          edges: [{ id: "e1", from: "n1", to: "n2", label: "bounded by" }],
          updatedAt: "2026-07-29T10:00:00.000Z",
        };
      },
      getCoraBoard: async (input) => {
        calls.push(["cora.board.get", input]);
        return boardProjection.projectRemoteBoardRead(
          input.runId === "run-empty"
            ? { revision: 0, cards: [] }
            : {
                revision: 4,
                cards: [
                  {
                    id: "card-1",
                    title: "Ship the phone board",
                    status: "idea",
                    order: 1,
                    updatedAt: "2026-07-29T09:00:00.000Z",
                  },
                ],
              },
        );
      },
      updateCoraBoard: async (input) => {
        calls.push(["cora.board.update", input]);
        // Stand in for the real revision guard: a write composed against an
        // older revision is reported back, not applied.
        const applied = input.baseRevision === 4;
        return {
          applied,
          board: {
            revision: applied ? 5 : 4,
            cards: [
              {
                id: "card-1",
                title: "Ship the phone board",
                status: applied && input.action === "queue" ? "queued" : "idea",
                order: 1,
                updatedAt: "2026-07-29T09:05:00.000Z",
              },
            ],
          },
        };
      },
      beginImageUpload: async (input) => {
        calls.push(["files.imageUpload.begin", input]);
        return {
          async write(data) {
            uploadedImageChunks.push(Buffer.from(data));
          },
          async finish() {
            return {
              name: input.name,
              mimeType: input.mimeType,
              size: input.size,
              path: "/tmp/phone-image.jpg",
              inputToken: "/tmp/phone-image.jpg",
            };
          },
          async abort() {
            imageUploadAborts += 1;
          },
        };
      },
      attachWorkerTerminal: async (request) => {
        calls.push(["automations.workerTerminal.open", request]);
        request.onData("worker bootstrap");
        sharedWorkerTerminal = {
          closed: false,
          written: [],
          write(data) {
            this.written.push(data);
          },
          resize() {},
          close() {
            this.closed = true;
          },
          title: "Automation worker",
          controlTargetId: "automation-worker:ws1:run-loom-live:attempt-live-1:g1",
          controlCapability: "steer",
        };
        return sharedWorkerTerminal;
      },
      createTerminal: async (request) => {
        calls.push(["terminal.create", request]);
        // A renderer-backed shell can print its prompt before the awaited
        // create service returns. RPC must hold this until the response tells
        // the phone which terminalId owns it.
        request.onData("opening prompt");
        sharedTerminal = {
          request,
          closed: false,
          detached: false,
          written: [],
          sizes: [],
          write(data) {
            this.written.push(data);
          },
          resize(cols, rows) {
            this.sizes.push([cols, rows]);
          },
          close() {
            this.closed = true;
          },
          detach() {
            this.detached = true;
          },
          desktopTabId: "term-desktop",
          title: "Etienne's iPhone · Codex",
        };
        sharedTerminals.push(sharedTerminal);
        return sharedTerminal;
      },
    };
    const terminalLeaseStore = makeTerminalLeaseStore((request) =>
      extendedServices.createTerminal(request),
    );
    extendedServices.terminalLeases = terminalLeaseStore;
    extendedServices.workerTerminalControls = workerControlRegistry;
    const ex = makeFakeStream();
    const exSession = new rpc.RpcSession(ex, extendedServices);
    const exReq = (id, method, params) =>
      ex.inject(rpc.encodeFrame({ id, method, params }));
    exReq(1, "hello", {
      protocol: rpc.RPC_PROTOCOL_VERSION,
      device: {
        publicKey: "forged",
        name: "Forged name",
        role: "phone",
        version: "1",
      },
    });
    await flush();

    exReq(11, "workspaces.list", {});
    await flush();
    check(
      "workspaces.list returns Studio workspace folders and top-level order",
      ex.outbox.at(-1)?.result?.groups?.[0]?.name === "Studio" &&
        ex.outbox.at(-1)?.result?.railOrder?.[0] === "group-studio",
      ex.outbox.at(-1),
    );
    exReq(110, "fleet.overview", {});
    await flush();
    const fleetRevision = ex.outbox.at(-1)?.result?.revision;
    check(
      "fleet.overview returns a compact revisioned workspace projection",
      ex.outbox.at(-1)?.result?.workspaces?.[0]?.conversationCount === 3 &&
        ex.outbox.at(-1)?.result?.workspaces?.[0]?.activeConversationWorkers ===
          2 &&
        ex.outbox.at(-1)?.result?.workspaces?.[0]?.activeAutomations === 1 &&
        typeof fleetRevision === "string" &&
        fleetRevision.length > 20,
      ex.outbox.at(-1),
    );
    exReq(111, "fleet.overview", { ifRevision: fleetRevision });
    await flush();
    check(
      "fleet.overview omits unchanged rows when the revision matches",
      ex.outbox.at(-1)?.result?.notModified === true &&
        ex.outbox.at(-1)?.result?.revision === fleetRevision &&
        ex.outbox.at(-1)?.result?.workspaces === undefined,
      ex.outbox.at(-1),
    );
    exReq(112, "subscriptions.list", {});
    await flush();
    const subscriptionsRevision = ex.outbox.at(-1)?.result?.revision;
    check(
      "subscriptions.list returns only a sanitized revisioned account projection",
      ex.outbox.at(-1)?.result?.profiles?.[0]?.label === "Codex Max 2" &&
        ex.outbox.at(-1)?.result?.profiles?.[0]?.provider === "openai-codex" &&
        !("identityFingerprint" in ex.outbox.at(-1).result.profiles[0]) &&
        !("path" in ex.outbox.at(-1).result.profiles[0]) &&
        typeof subscriptionsRevision === "string",
      ex.outbox.at(-1),
    );
    exReq(113, "subscriptions.list", { ifRevision: subscriptionsRevision });
    await flush();
    check(
      "subscriptions.list omits unchanged profile rows",
      ex.outbox.at(-1)?.result?.notModified === true &&
        ex.outbox.at(-1)?.result?.profiles === undefined &&
        ex.outbox.at(-1)?.result?.revision === subscriptionsRevision,
      ex.outbox.at(-1),
    );
    exReq(114, "nativeCliAccounts.list", {});
    await flush();
    const nativeAccountsRevision = ex.outbox.at(-1)?.result?.revision;
    check(
      "nativeCliAccounts.list returns a sanitized revisioned routing projection",
      ex.outbox.at(-1)?.result?.profiles?.[0]?.id === "personal" &&
        ex.outbox.at(-1)?.result?.profiles?.[0]?.runtime === "claude" &&
        ex.outbox.at(-1)?.result?.profiles?.[1]?.label === "Codex Max 2" &&
        !("path" in ex.outbox.at(-1).result.profiles[0]) &&
        !("env" in ex.outbox.at(-1).result.profiles[0]) &&
        typeof nativeAccountsRevision === "string",
      ex.outbox.at(-1),
    );
    exReq(115, "nativeCliAccounts.list", {
      ifRevision: nativeAccountsRevision,
    });
    await flush();
    check(
      "nativeCliAccounts.list omits unchanged profile rows",
      ex.outbox.at(-1)?.result?.notModified === true &&
        ex.outbox.at(-1)?.result?.profiles === undefined &&
        ex.outbox.at(-1)?.result?.revision === nativeAccountsRevision,
      ex.outbox.at(-1),
    );
    exReq(2, "directories.list", { path: "/Users/e/Projects" });
    await flush();
    check(
      "directories.list delegates and returns the bounded listing shape",
      ex.outbox.at(-1)?.result?.directories?.[0]?.name === "Codara",
      ex.outbox.at(-1),
    );
    exReq(3, "workspaces.add", {
      path: "/Users/e/Projects/Codara",
      name: "  Mobile  ",
    });
    await flush();
    check(
      "workspaces.add trims its display name and returns appearance metadata",
      calls.at(-1)?.[1]?.name === "Mobile" &&
        ex.outbox.at(-1)?.result?.workspace?.color === "#2AA298",
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    exReq(31, "workspaces.group.create", { name: "  Mobile folder  " });
    await flush();
    check(
      "workspaces.group.create trims and delegates its bounded name",
      calls.at(-1)?.[0] === "workspaces.group.create" &&
        calls.at(-1)?.[1] === "Mobile folder" &&
        ex.outbox.at(-1)?.result?.group?.id === "group-new",
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    exReq(32, "workspaces.group.update", {
      groupId: "group-studio",
      name: "  Products  ",
      collapsed: true,
    });
    await flush();
    check(
      "workspaces.group.update delegates name and collapsed state",
      calls.at(-1)?.[0] === "workspaces.group.update" &&
        calls.at(-1)?.[1]?.name === "Products" &&
        calls.at(-1)?.[1]?.collapsed === true,
      calls.at(-1),
    );
    exReq(33, "workspaces.move", {
      workspaceId: "ws1",
      groupId: "group-studio",
      beforeWorkspaceId: null,
    });
    await flush();
    check(
      "workspaces.move delegates an explicit group destination",
      calls.at(-1)?.[0] === "workspaces.move" &&
        calls.at(-1)?.[1]?.groupId === "group-studio" &&
        ex.outbox.at(-1)?.result?.workspace?.groupId === "group-studio",
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    exReq(331, "workspaces.move", {
      workspaceId: "ws1",
      groupId: null,
      beforeRailItemId: "group-studio",
    });
    await flush();
    check(
      "workspaces.move delegates an atomic top-level drop position",
      calls.at(-1)?.[0] === "workspaces.move" &&
        calls.at(-1)?.[1]?.groupId === null &&
        calls.at(-1)?.[1]?.beforeRailItemId === "group-studio",
      calls.at(-1),
    );
    exReq(34, "workspaces.rail.move", {
      itemId: "group-studio",
      beforeItemId: null,
    });
    await flush();
    check(
      "workspaces.rail.move delegates top-level ordering",
      calls.at(-1)?.[0] === "workspaces.rail.move" &&
        calls.at(-1)?.[1]?.beforeItemId === null,
      calls.at(-1),
    );
    exReq(35, "workspaces.group.delete", { groupId: "group-studio" });
    await flush();
    check(
      "workspaces.group.delete delegates without deleting workspaces",
      calls.at(-1)?.[0] === "workspaces.group.delete" &&
        calls.at(-1)?.[1] === "group-studio" &&
        ex.outbox.at(-1)?.ok === true,
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    exReq(4, "files.list", { workspaceId: "ws1", path: "" });
    await flush();
    check(
      "files.list returns workspace-relative entries",
      ex.outbox.at(-1)?.result?.entries?.[0]?.path === "src",
    );
    exReq(5, "files.read", { workspaceId: "ws1", path: "src/index.ts" });
    await flush();
    check(
      "files.read wraps its file DTO",
      ex.outbox.at(-1)?.result?.file?.content === "export {};",
    );
    exReq(51, "files.create", {
      workspaceId: "ws1",
      parentPath: "src",
      name: "mobile.ts",
      kind: "file",
    });
    await flush();
    check(
      "files.create delegates a bounded leaf mutation and returns its entry",
      calls.at(-1)?.[0] === "files.create" &&
        ex.outbox.at(-1)?.result?.entry?.path === "src/mobile.ts",
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    exReq(52, "files.rename", {
      workspaceId: "ws1",
      path: "src/mobile.ts",
      name: "phone.ts",
    });
    await flush();
    check(
      "files.rename delegates one workspace-relative entry",
      calls.at(-1)?.[0] === "files.rename" &&
        ex.outbox.at(-1)?.result?.entry?.path === "src/phone.ts",
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    exReq(53, "files.move", {
      workspaceId: "ws1",
      path: "src/phone.ts",
      destinationPath: "archive",
      requestId: "move-phone-1",
    });
    await flush();
    check(
      "files.move delegates a destination folder instead of an arbitrary target path",
      calls.at(-1)?.[1]?.destinationPath === "archive" &&
        calls.at(-1)?.[1]?.requestId === "move-phone-1" &&
        ex.outbox.at(-1)?.result?.entry?.path === "archive/phone.ts",
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    const callsBeforeBadMoveId = calls.length;
    exReq(531, "files.move", {
      workspaceId: "ws1",
      path: "src/phone.ts",
      destinationPath: "archive",
      requestId: "x".repeat(257),
    });
    await flush();
    check(
      "files.move rejects an unbounded retry id before mutating",
      ex.outbox.at(-1)?.error?.code === "invalid-params" &&
        calls.length === callsBeforeBadMoveId,
      ex.outbox.at(-1),
    );
    exReq(532, "files.move", {
      workspaceId: "ws1",
      path: "src/phone.ts",
      destinationPath: "archive",
      requestId: "move-conflict",
    });
    await flush();
    check(
      "files.move exposes durable retry-key conflicts to the phone",
      ex.outbox.at(-1)?.error?.code === "mutation-conflict",
      ex.outbox.at(-1),
    );
    exReq(533, "files.move", {
      workspaceId: "ws1",
      path: "src/phone.ts",
      destinationPath: "archive",
      requestId: "move-unknown",
    });
    await flush();
    check(
      "files.move exposes an unknown durable outcome instead of retrying blindly",
      ex.outbox.at(-1)?.error?.code === "mutation-outcome-unknown" &&
        /may already have completed/i.test(
          ex.outbox.at(-1)?.error?.message ?? "",
        ),
      ex.outbox.at(-1),
    );
    exReq(54, "files.delete", { workspaceId: "ws1", path: "archive/phone.ts" });
    await flush();
    check(
      "files.delete returns the parent that the phone should refresh",
      ex.outbox.at(-1)?.result?.deleted?.parentPath === "archive",
      ex.outbox.at(-1),
    );
    const imageBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    exReq(55, "files.imageUpload.begin", {
      workspaceId: "ws1",
      name: "phone.jpg",
      mimeType: "image/jpeg",
      size: imageBytes.length,
    });
    await flush();
    const imageUploadId = ex.outbox.at(-1)?.result?.uploadId;
    check(
      "files.imageUpload.begin returns a session-owned bounded chunk size",
      typeof imageUploadId === "string" &&
        ex.outbox.at(-1)?.result?.chunkBytes ===
          imageUpload.REMOTE_IMAGE_CHUNK_BYTES,
      ex.outbox.at(-1),
    );
    exReq(56, "files.imageUpload.chunk", {
      uploadId: imageUploadId,
      offset: 1,
      data: imageBytes.toString("base64"),
    });
    await flush();
    check(
      "files.imageUpload.chunk rejects out-of-order offsets before writing",
      ex.outbox.at(-1)?.error?.code === "invalid-params" &&
        uploadedImageChunks.length === 0,
      ex.outbox.at(-1),
    );
    exReq(57, "files.imageUpload.chunk", {
      uploadId: imageUploadId,
      offset: 0,
      data: imageBytes.toString("base64"),
    });
    await flush();
    check(
      "files.imageUpload.chunk acknowledges decoded bytes",
      ex.outbox.at(-1)?.result?.received === imageBytes.length &&
        Buffer.concat(uploadedImageChunks).equals(imageBytes),
      ex.outbox.at(-1),
    );
    exReq(58, "files.imageUpload.finish", { uploadId: imageUploadId });
    await flush();
    check(
      "files.imageUpload.finish exposes only the server-created attachment",
      ex.outbox.at(-1)?.result?.attachment?.inputToken ===
        "/tmp/phone-image.jpg" && imageUploadAborts === 0,
      ex.outbox.at(-1),
    );
    exReq(6, "git.status", { workspaceId: "ws1" });
    await flush();
    check(
      "git.status returns source-control changes",
      ex.outbox.at(-1)?.result?.status?.unstaged?.length === 1,
    );
    exReq(61, "git.log", { workspaceId: "ws1", limit: 25 });
    await flush();
    check(
      "git.log delegates a bounded history depth",
      calls.at(-1)?.[1]?.limit === 25 &&
        ex.outbox.at(-1)?.result?.log?.commits?.[0]?.isHead === true,
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    const callsBeforeOversizedLog = calls.length;
    exReq(64, "git.log", { workspaceId: "ws1", limit: 1000 });
    await flush();
    check(
      "git.log rejects an unbounded history request before spawning git",
      ex.outbox.at(-1)?.ok === false &&
        ex.outbox.at(-1)?.error?.code === "invalid-params" &&
        calls.length === callsBeforeOversizedLog,
      {
        callsBeforeOversizedLog,
        callsAfter: calls.length,
        response: ex.outbox.at(-1),
      },
    );
    exReq(62, "git.commitDetail", { workspaceId: "ws1", hash: "a".repeat(40) });
    await flush();
    check(
      "git.commitDetail returns metadata and changed files",
      ex.outbox.at(-1)?.result?.commit?.files?.[0]?.additions === 2,
      ex.outbox.at(-1),
    );
    const callsBeforeBadHash = calls.length;
    exReq(63, "git.commitDetail", { workspaceId: "ws1", hash: "--help" });
    await flush();
    check(
      "git.commitDetail rejects option-shaped hashes before spawning git",
      ex.outbox.at(-1)?.ok === false &&
        ex.outbox.at(-1)?.error?.code === "invalid-params" &&
        calls.length === callsBeforeBadHash,
      {
        callsBeforeBadHash,
        callsAfter: calls.length,
        response: ex.outbox.at(-1),
      },
    );
    exReq(65, "github.status", { workspaceId: "ws1" });
    await flush();
    check(
      "github.status returns the bounded GitHub readiness projection",
      calls.at(-1)?.[0] === "github.status" &&
        calls.at(-1)?.[1] === "ws1" &&
        ex.outbox.at(-1)?.result?.status?.repository?.nameWithOwner ===
          "codara/studio" &&
        typeof ex.outbox.at(-1)?.result?.revision === "string",
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    const githubRevision = ex.outbox.at(-1)?.result?.revision;
    exReq(650, "github.status", {
      workspaceId: "ws1",
      ifRevision: githubRevision,
    });
    await flush();
    check(
      "github.status omits an unchanged snapshot when its revision matches",
      ex.outbox.at(-1)?.result?.notModified === true &&
        ex.outbox.at(-1)?.result?.revision === githubRevision &&
        ex.outbox.at(-1)?.result?.status === undefined,
      ex.outbox.at(-1),
    );
    const callsBeforeMalformedGitHubStatus = calls.length;
    exReq(651, "github.status", {
      workspaceId: "ws1",
      cwd: "/private/worktree",
    });
    await flush();
    check(
      "github.status rejects phone-supplied paths and unknown fields",
      ex.outbox.at(-1)?.error?.code === "invalid-params" &&
        calls.length === callsBeforeMalformedGitHubStatus,
      ex.outbox.at(-1),
    );
    exReq(652, "github.workQueue", {});
    await flush();
    check(
      "github.workQueue returns one bounded host-wide projection",
      calls.at(-1)?.[0] === "github.workQueue" &&
        ex.outbox.at(-1)?.result?.status?.kind === "ready" &&
        ex.outbox.at(-1)?.result?.status?.repositoriesScanned === 1 &&
        typeof ex.outbox.at(-1)?.result?.revision === "string" &&
        typeof ex.outbox.at(-1)?.result?.refreshedAt === "string",
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    const queueRevision = ex.outbox.at(-1)?.result?.revision;
    exReq(653, "github.workQueue", { ifRevision: queueRevision });
    await flush();
    check(
      "github.workQueue revision ignores timestamp-only refreshes",
      ex.outbox.at(-1)?.result?.notModified === true &&
        ex.outbox.at(-1)?.result?.revision === queueRevision &&
        ex.outbox.at(-1)?.result?.status === undefined &&
        ex.outbox.at(-1)?.result?.refreshedAt !== undefined,
      ex.outbox.at(-1),
    );
    exReq(655, "github.workQueue", {
      ifRevision: queueRevision,
      refresh: true,
    });
    await flush();
    check(
      "github.workQueue explicit refresh reaches the bounded server service",
      calls.at(-1)?.[0] === "github.workQueue" &&
        calls.at(-1)?.[1]?.refresh === true &&
        ex.outbox.at(-1)?.result?.notModified === true,
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    const callsBeforeRateLimitedRefresh = calls.length;
    exReq(656, "github.workQueue", { refresh: true });
    await flush();
    check(
      "github.workQueue throttles repeated forced provider refreshes per session",
      ex.outbox.at(-1)?.error?.code === "rate-limited" &&
        calls.length === callsBeforeRateLimitedRefresh,
      ex.outbox.at(-1),
    );
    const callsBeforeMalformedQueue = calls.length;
    exReq(654, "github.workQueue", {
      repository: "someone/else",
      workspaceId: "ws1",
    });
    await flush();
    check(
      "github.workQueue rejects phone-controlled repository fan-out",
      ex.outbox.at(-1)?.error?.code === "invalid-params" &&
        calls.length === callsBeforeMalformedQueue,
      ex.outbox.at(-1),
    );
    exReq(66, "github.publish", {
      workspaceId: "ws1",
      requestId: "publish-ws1-1",
      input: {
        title: "  Publish from phone  ",
        body: "Ready for review.",
        draft: true,
        commitMessage: "  Publish remote changes  ",
      },
    });
    await flush();
    check(
      "github.publish delegates canonical input plus a stable retry id",
      calls.at(-1)?.[0] === "github.publish" &&
        calls.at(-1)?.[1]?.workspaceId === "ws1" &&
        calls.at(-1)?.[1]?.requestId === "publish-ws1-1" &&
        calls.at(-1)?.[1]?.input?.title === "Publish from phone" &&
        calls.at(-1)?.[1]?.input?.commitMessage === "Publish remote changes" &&
        ex.outbox.at(-1)?.result?.result?.pullRequest?.number === 42 &&
        ex.outbox.at(-1)?.result?.result?.base === "main",
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    const callsBeforePublishWithoutReceipt = calls.length;
    exReq(661, "github.publish", {
      workspaceId: "ws1",
      input: { title: "Publish", body: "", draft: false },
    });
    await flush();
    check(
      "github.publish requires a stable retry id before mutation",
      ex.outbox.at(-1)?.error?.code === "invalid-params" &&
        calls.length === callsBeforePublishWithoutReceipt,
      ex.outbox.at(-1),
    );
    const callsBeforeMalformedPublish = calls.length;
    exReq(662, "github.publish", {
      workspaceId: "ws1",
      requestId: "publish-invalid-1",
      input: {
        title: "Publish",
        body: "",
        draft: false,
        token: "must-not-be-forwarded",
      },
    });
    await flush();
    check(
      "github.publish rejects unknown input fields before invoking git or gh",
      ex.outbox.at(-1)?.error?.code === "invalid-params" &&
        calls.length === callsBeforeMalformedPublish,
      ex.outbox.at(-1),
    );
    exReq(663, "github.publish", {
      workspaceId: "ws1",
      requestId: "publish-invalid-2",
      input: { title: "x".repeat(257), body: "", draft: false },
    });
    await flush();
    check(
      "github.publish rejects an oversized title before invoking git or gh",
      ex.outbox.at(-1)?.error?.code === "invalid-params" &&
        calls.length === callsBeforeMalformedPublish,
      ex.outbox.at(-1),
    );
    exReq(664, "github.publish", {
      workspaceId: "ws1",
      requestId: "publish-conflict",
      input: { title: "Publish", body: "", draft: false },
    });
    await flush();
    check(
      "github.publish exposes durable retry conflicts as a typed wire error",
      ex.outbox.at(-1)?.error?.code === "mutation-conflict",
      ex.outbox.at(-1),
    );
    exReq(66401, "github.ready", {
      workspaceId: "ws1",
      requestId: "ready-ws1-42",
      input: {
        repository: "  codara/studio  ",
        pullRequestNumber: 42,
        baseBranch: "  main  ",
        headBranch: "  feature/remote-publish  ",
        expectedHeadCommitOid: "B".repeat(40),
      },
    });
    await flush();
    check(
      "github.ready delegates only the exact canonical pins plus stable retry id",
      calls.at(-1)?.[0] === "github.ready" &&
        JSON.stringify(calls.at(-1)?.[1]) ===
          JSON.stringify({
            workspaceId: "ws1",
            requestId: "ready-ws1-42",
            input: {
              repository: "codara/studio",
              pullRequestNumber: 42,
              baseBranch: "main",
              headBranch: "feature/remote-publish",
              expectedHeadCommitOid: "b".repeat(40),
            },
          }) &&
        ex.outbox.at(-1)?.result?.result?.pullRequest?.isDraft === false,
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    const callsBeforeReadyWithoutReceipt = calls.length;
    exReq(66402, "github.ready", {
      workspaceId: "ws1",
      input: {
        repository: "codara/studio",
        pullRequestNumber: 42,
        baseBranch: "main",
        headBranch: "feature/remote-publish",
        expectedHeadCommitOid: "b".repeat(40),
      },
    });
    await flush();
    check(
      "github.ready requires a stable retry id before mutation",
      ex.outbox.at(-1)?.error?.code === "invalid-params" &&
        calls.length === callsBeforeReadyWithoutReceipt,
      ex.outbox.at(-1),
    );
    const callsBeforeMalformedReady = calls.length;
    exReq(66403, "github.ready", {
      workspaceId: "ws1",
      requestId: "ready-invalid",
      input: {
        repository: "codara/studio",
        pullRequestNumber: 42,
        baseBranch: "main",
        headBranch: "feature/remote-publish",
        expectedHeadCommitOid: "b".repeat(40),
        force: true,
      },
    });
    await flush();
    check(
      "github.ready rejects force and unknown phone fields",
      ex.outbox.at(-1)?.error?.code === "invalid-params" &&
        calls.length === callsBeforeMalformedReady,
      ex.outbox.at(-1),
    );
    exReq(66404, "github.ready", {
      workspaceId: "ws1",
      requestId: "ready-conflict",
      input: {
        repository: "codara/studio",
        pullRequestNumber: 42,
        baseBranch: "main",
        headBranch: "feature/remote-publish",
        expectedHeadCommitOid: "b".repeat(40),
      },
    });
    await flush();
    check(
      "github.ready exposes durable retry conflicts as a typed wire error",
      ex.outbox.at(-1)?.error?.code === "mutation-conflict",
      ex.outbox.at(-1),
    );
    exReq(6641, "github.merge", {
      workspaceId: "ws1",
      requestId: "merge-ws1-42",
      input: {
        repository: "codara/studio",
        pullRequestNumber: 42,
        baseBranch: "main",
        headBranch: "feature/remote-publish",
        expectedHeadCommitOid: "b".repeat(40),
        strategy: "squash",
      },
    });
    await flush();
    check(
      "github.merge delegates only an exact pinned merge plus stable retry id",
      calls.at(-1)?.[0] === "github.merge" &&
        JSON.stringify(calls.at(-1)?.[1]) ===
          JSON.stringify({
            workspaceId: "ws1",
            requestId: "merge-ws1-42",
            input: {
              repository: "codara/studio",
              pullRequestNumber: 42,
              baseBranch: "main",
              headBranch: "feature/remote-publish",
              expectedHeadCommitOid: "b".repeat(40),
              strategy: "squash",
            },
          }) &&
        ex.outbox.at(-1)?.result?.result?.pullRequest?.state === "MERGED",
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    const callsBeforeMergeWithoutBase = calls.length;
    exReq(66411, "github.merge", {
      workspaceId: "ws1",
      requestId: "merge-ws1-42-no-base",
      input: {
        repository: "codara/studio",
        pullRequestNumber: 42,
        headBranch: "feature/remote-publish",
        expectedHeadCommitOid: "b".repeat(40),
        strategy: "squash",
      },
    });
    await flush();
    check(
      "github.merge requires the reviewed base branch before mutation",
      ex.outbox.at(-1)?.error?.code === "invalid-params" &&
        calls.length === callsBeforeMergeWithoutBase,
      ex.outbox.at(-1),
    );
    const callsBeforeMergeWithoutReceipt = calls.length;
    exReq(6642, "github.merge", {
      workspaceId: "ws1",
      input: {
        repository: "codara/studio",
        pullRequestNumber: 42,
        baseBranch: "main",
        headBranch: "feature/remote-publish",
        expectedHeadCommitOid: "b".repeat(40),
        strategy: "squash",
      },
    });
    await flush();
    check(
      "github.merge requires a stable retry id before mutation",
      ex.outbox.at(-1)?.error?.code === "invalid-params" &&
        calls.length === callsBeforeMergeWithoutReceipt,
      ex.outbox.at(-1),
    );
    const callsBeforeMalformedMerge = calls.length;
    exReq(6643, "github.merge", {
      workspaceId: "ws1",
      requestId: "merge-invalid",
      input: {
        repository: "codara/studio",
        pullRequestNumber: 42,
        baseBranch: "main",
        headBranch: "feature/remote-publish",
        expectedHeadCommitOid: "b".repeat(40),
        strategy: "squash",
        deleteBranch: true,
      },
    });
    await flush();
    check(
      "github.merge rejects branch deletion and unknown phone fields",
      ex.outbox.at(-1)?.error?.code === "invalid-params" &&
        calls.length === callsBeforeMalformedMerge,
      ex.outbox.at(-1),
    );
    exReq(6644, "github.merge", {
      workspaceId: "ws1",
      requestId: "merge-conflict",
      input: {
        repository: "codara/studio",
        pullRequestNumber: 42,
        baseBranch: "main",
        headBranch: "feature/remote-publish",
        expectedHeadCommitOid: "b".repeat(40),
        strategy: "squash",
      },
    });
    await flush();
    check(
      "github.merge exposes durable retry conflicts as a typed wire error",
      ex.outbox.at(-1)?.error?.code === "mutation-conflict",
      ex.outbox.at(-1),
    );
    exReq(665, "github.issue.start", {
      sourceWorkspaceId: "ws1",
      issueNumber: 123,
      requestId: "issue-start-ws1-123",
    });
    await flush();
    check(
      "github.issue.start delegates only the authoritative source, issue number, and stable retry id",
      calls.at(-1)?.[0] === "github.issue.start" &&
        JSON.stringify(calls.at(-1)?.[1]) ===
          JSON.stringify({
            sourceWorkspaceId: "ws1",
            issueNumber: 123,
            requestId: "issue-start-ws1-123",
          }) &&
        ex.outbox.at(-1)?.result?.result?.workspaceId === "ws-issue-123" &&
        ex.outbox.at(-1)?.result?.result?.runId === "run-issue-123",
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    const callsBeforeIssueWithoutReceipt = calls.length;
    exReq(666, "github.issue.start", {
      sourceWorkspaceId: "ws1",
      issueNumber: 123,
    });
    await flush();
    check(
      "github.issue.start requires a stable retry id before mutation",
      ex.outbox.at(-1)?.error?.code === "invalid-params" &&
        calls.length === callsBeforeIssueWithoutReceipt,
      ex.outbox.at(-1),
    );
    const callsBeforeMalformedIssueStart = calls.length;
    exReq(667, "github.issue.start", {
      sourceWorkspaceId: "ws1",
      issueNumber: 123,
      requestId: "issue-start-invalid-1",
      cwd: "/private/worktree",
    });
    await flush();
    check(
      "github.issue.start rejects phone-supplied paths and unknown fields",
      ex.outbox.at(-1)?.error?.code === "invalid-params" &&
        calls.length === callsBeforeMalformedIssueStart,
      ex.outbox.at(-1),
    );
    for (const [id, issueNumber] of [
      [668, 0],
      [669, 2_147_483_648],
    ]) {
      exReq(id, "github.issue.start", {
        sourceWorkspaceId: "ws1",
        issueNumber,
        requestId: `issue-start-invalid-${id}`,
      });
      await flush();
      check(
        `github.issue.start rejects unsafe issue number ${issueNumber}`,
        ex.outbox.at(-1)?.error?.code === "invalid-params" &&
          calls.length === callsBeforeMalformedIssueStart,
        ex.outbox.at(-1),
      );
    }
    exReq(670, "github.issue.start", {
      sourceWorkspaceId: "ws1",
      issueNumber: 123,
      requestId: "issue-start-conflict",
    });
    await flush();
    check(
      "github.issue.start exposes durable retry conflicts as a typed wire error",
      ex.outbox.at(-1)?.error?.code === "mutation-conflict",
      ex.outbox.at(-1),
    );
    exReq(671, "github.pullRequest.start", {
      sourceWorkspaceId: "ws1",
      repositoryUrl: "https://github.com/CODARA/STUDIO/",
      pullRequestNumber: 42,
      expectedHeadCommitOid: "B".repeat(40),
      requestId: "pr-start-ws1-42-b",
    });
    await flush();
    check(
      "github.pullRequest.start delegates only canonical pinned queue identity and a stable retry id",
      calls.at(-1)?.[0] === "github.pullRequest.start" &&
        JSON.stringify(calls.at(-1)?.[1]) ===
          JSON.stringify({
            sourceWorkspaceId: "ws1",
            repositoryUrl: "https://github.com/codara/studio",
            pullRequestNumber: 42,
            expectedHeadCommitOid: "b".repeat(40),
            requestId: "pr-start-ws1-42-b",
          }) &&
        ex.outbox.at(-1)?.result?.result?.workspaceId === "ws-pr-42" &&
        ex.outbox.at(-1)?.result?.result?.runId === "run-pr-42",
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    const callsBeforePrWithoutReceipt = calls.length;
    exReq(672, "github.pullRequest.start", {
      sourceWorkspaceId: "ws1",
      repositoryUrl: "https://github.com/codara/studio",
      pullRequestNumber: 42,
      expectedHeadCommitOid: "b".repeat(40),
    });
    await flush();
    check(
      "github.pullRequest.start requires a stable retry id before mutation",
      ex.outbox.at(-1)?.error?.code === "invalid-params" &&
        calls.length === callsBeforePrWithoutReceipt,
      ex.outbox.at(-1),
    );
    for (const [id, override] of [
      [673, { cwd: "/private/worktree" }],
      [674, { repositoryUrl: "https://user@github.com/codara/studio" }],
      [675, { repositoryUrl: "https://github.com/codara/studio?ref=main" }],
      [676, { expectedHeadCommitOid: "b".repeat(39) }],
      [677, { pullRequestNumber: 0 }],
      [679, { requestId: " bad\n" }],
      [680, { requestId: "short" }],
      [681, { requestId: "x".repeat(129) }],
    ]) {
      exReq(id, "github.pullRequest.start", {
        sourceWorkspaceId: "ws1",
        repositoryUrl: "https://github.com/codara/studio",
        pullRequestNumber: 42,
        expectedHeadCommitOid: "b".repeat(40),
        requestId: `pr-start-invalid-${id}`,
        ...override,
      });
      await flush();
      check(
        `github.pullRequest.start rejects unsafe or excess fields (${id})`,
        ex.outbox.at(-1)?.error?.code === "invalid-params" &&
          calls.length === callsBeforePrWithoutReceipt,
        ex.outbox.at(-1),
      );
    }
    exReq(678, "github.pullRequest.start", {
      sourceWorkspaceId: "ws1",
      repositoryUrl: "https://github.com/codara/studio",
      pullRequestNumber: 42,
      expectedHeadCommitOid: "b".repeat(40),
      requestId: "pr-start-conflict",
    });
    await flush();
    check(
      "github.pullRequest.start exposes durable retry conflicts as a typed wire error",
      ex.outbox.at(-1)?.error?.code === "mutation-conflict",
      ex.outbox.at(-1),
    );
    exReq(7, "cora.history", { workspaceId: "ws1" });
    await flush();
    const historyRevision = ex.outbox.at(-1)?.result?.revision;
    check(
      "cora.history returns workspace runs with a content revision",
      ex.outbox.at(-1)?.result?.runs?.[0]?.id === "run-1" &&
        typeof historyRevision === "string" &&
        historyRevision.length > 20,
    );
    exReq(71, "cora.history", {
      workspaceId: "ws1",
      ifRevision: historyRevision,
    });
    await flush();
    check(
      "cora.history omits an unchanged history projection",
      ex.outbox.at(-1)?.result?.notModified === true &&
        ex.outbox.at(-1)?.result?.revision === historyRevision &&
        ex.outbox.at(-1)?.result?.runs === undefined,
      ex.outbox.at(-1),
    );
    coraHistoryTitle = `Remote work ${"changed ".repeat(30)}`;
    exReq(72, "cora.history", {
      workspaceId: "ws1",
      ifRevision: historyRevision,
      deltaVersion: 1,
    });
    await flush();
    check(
      "cora.history capability returns a revision-based summary delta",
      ex.outbox.at(-1)?.result?.historyDelta?.version === 1 &&
        ex.outbox.at(-1)?.result?.historyDelta?.baseRevision ===
          historyRevision &&
        ex.outbox.at(-1)?.result?.historyDelta?.upserts?.[0]?.title ===
          coraHistoryTitle &&
        ex.outbox.at(-1)?.result?.runs === undefined,
      ex.outbox.at(-1),
    );
    exReq(8, "cora.get", { workspaceId: "ws1", runId: "run-1" });
    await flush();
    const runRevision = ex.outbox.at(-1)?.result?.revision;
    check(
      "cora.get returns bounded messages with an exact projection revision",
      ex.outbox.at(-1)?.result?.run?.messages?.[0]?.author === "cora" &&
        typeof runRevision === "string" &&
        runRevision.length > 20 &&
        ex.outbox.at(-1)?.result?.cursor === "cursor-current" &&
        ex.outbox.at(-1)?.result?.messageDelta === undefined,
    );
    exReq(814, "cora.graph.get", { workspaceId: "ws1", runId: "run-1" });
    await flush();
    check(
      "cora.graph.get returns graph relationships without the transcript",
      calls.at(-1)?.[0] === "cora.graph.get" &&
        ex.outbox.at(-1)?.result?.run?.messages?.length === 0 &&
        ex.outbox.at(-1)?.result?.run?.steps?.[0]?.id === "step-1" &&
        ex.outbox.at(-1)?.result?.run?.workers?.[0]?.stepId === "step-1",
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    exReq(81, "cora.get", {
      workspaceId: "ws1",
      runId: "run-1",
      ifRevision: runRevision,
    });
    await flush();
    check(
      "cora.get omits an unchanged transcript",
      ex.outbox.at(-1)?.result?.notModified === true &&
        ex.outbox.at(-1)?.result?.run === undefined &&
        ex.outbox.at(-1)?.result?.revision === runRevision &&
        ex.outbox.at(-1)?.result?.cursor === "cursor-current",
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    // runtimeActivity is rewritten in memory on every tool call without any
    // saveRun or event. Because the revision hashes the full bounded DTO, that
    // rewrite has to move the digest or the phone's conditional poll would sit
    // on notModified forever and never show live activity.
    coraWorkerActivity = "Edit src/main/remote-access/rpc.ts";
    exReq(815, "cora.get", {
      workspaceId: "ws1",
      runId: "run-1",
      ifRevision: runRevision,
    });
    await flush();
    const activityRevision = ex.outbox.at(-1)?.result?.revision;
    check(
      "cora.get revision moves when only a worker's runtimeActivity changed",
      ex.outbox.at(-1)?.result?.notModified === undefined &&
        typeof activityRevision === "string" &&
        activityRevision !== runRevision &&
        ex.outbox.at(-1)?.result?.run?.workers?.[0]?.runtimeActivity ===
          "Edit src/main/remote-access/rpc.ts" &&
        ex.outbox.at(-1)?.result?.run?.workers?.[0]?.runtimeState === "working",
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    exReq(816, "cora.get", {
      workspaceId: "ws1",
      runId: "run-1",
      ifRevision: activityRevision,
    });
    await flush();
    check(
      "cora.get revision is stable across two identical run snapshots",
      ex.outbox.at(-1)?.result?.notModified === true &&
        ex.outbox.at(-1)?.result?.revision === activityRevision,
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    coraWorkerActivity = "Read src/main/index.ts";
    exReq(811, "cora.get", {
      workspaceId: "ws1",
      runId: "run-1",
      afterCursor: "cursor-base",
    });
    await flush();
    check(
      "cora.get forwards a bounded cursor and falls back to full when the delta is larger",
      calls.at(-1)?.[0] === "cora.get" &&
        calls.at(-1)?.[1]?.afterCursor === "cursor-base" &&
        ex.outbox.at(-1)?.result?.run?.messages?.[0]?.id === "message-1" &&
        ex.outbox.at(-1)?.result?.messageDelta === undefined,
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    exReq(813, "cora.get", {
      workspaceId: "ws1",
      runId: "run-1",
      ifRevision: runRevision,
      afterCursor: "cursor-invalid",
    });
    await flush();
    check(
      "cora.get sends a full reset when an opaque cursor cannot prove the cached base",
      ex.outbox.at(-1)?.result?.notModified === undefined &&
        ex.outbox.at(-1)?.result?.run?.messages?.[0]?.id === "message-1" &&
        ex.outbox.at(-1)?.result?.messageDelta === undefined &&
        ex.outbox.at(-1)?.result?.cursor === "cursor-current",
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    const callsBeforeOversizedCoraCursor = calls.length;
    exReq(812, "cora.get", {
      workspaceId: "ws1",
      runId: "run-1",
      afterCursor: "x".repeat(129),
    });
    await flush();
    check(
      "cora.get rejects an oversized message cursor before projection",
      ex.outbox.at(-1)?.ok === false &&
        ex.outbox.at(-1)?.error?.code === "invalid-params" &&
        calls.length === callsBeforeOversizedCoraCursor,
      {
        callsBeforeOversizedCoraCursor,
        callsAfter: calls.length,
        response: ex.outbox.at(-1),
      },
    );
    const callsBeforeRemovedAccountSelect = calls.length;
    exReq(82, "cora.account.select", {
      workspaceId: "ws1",
      runId: "run-1",
      profileId: "11111111-1111-4111-8111-111111111111",
      requestId: "account-run-1",
    });
    await flush();
    check(
      "cora.account.select is no longer a phone surface (account choice lives in Settings)",
      ex.outbox.at(-1)?.ok === false &&
        ex.outbox.at(-1)?.error?.code === "unknown-method" &&
        calls.length === callsBeforeRemovedAccountSelect,
      ex.outbox.at(-1),
    );
    const callsBeforeRemovedNativeSelect = calls.length;
    exReq(85, "cora.nativeCliAccount.select", {
      workspaceId: "ws1",
      runId: "run-1",
      runtime: "claude",
      profileId: "personal",
      requestId: "native-account-run-1",
    });
    await flush();
    check(
      "cora.nativeCliAccount.select is no longer a phone surface",
      ex.outbox.at(-1)?.ok === false &&
        ex.outbox.at(-1)?.error?.code === "unknown-method" &&
        calls.length === callsBeforeRemovedNativeSelect,
      ex.outbox.at(-1),
    );
    exReq(87, "cora.resume", {
      workspaceId: "ws1",
      runId: "run-1",
      recoveryId: "recovery-ms7-run-1",
      requestId: "resume-recovery-1",
      account: {
        kind: "subscription",
        profileId: "11111111-1111-4111-8111-111111111111",
      },
    });
    await flush();
    check(
      "cora.resume delegates one exact recovery token, stable receipt, and bounded account selector",
      calls.at(-1)?.[0] === "cora.resume" &&
        JSON.stringify(calls.at(-1)?.[1]) ===
          JSON.stringify({
            workspaceId: "ws1",
            runId: "run-1",
            recoveryId: "recovery-ms7-run-1",
            requestId: "resume-recovery-1",
            account: {
              kind: "subscription",
              profileId: "11111111-1111-4111-8111-111111111111",
            },
          }) &&
        ex.outbox.at(-1)?.result?.outcome === "accepted" &&
        ex.outbox.at(-1)?.result?.recoveryId === "recovery-ms7-run-1",
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    const callsBeforeMalformedResume = calls.length;
    for (const [id, params] of [
      [
        871,
        {
          workspaceId: "ws1",
          runId: "run-1",
          recoveryId: "spark-not-a-recovery",
          requestId: "resume-bad-token",
        },
      ],
      [
        872,
        {
          workspaceId: "ws1",
          runId: "run-1",
          recoveryId: "recovery-ms7-run-1",
          requestId: "resume-bad-account",
          account: { kind: "native-cli", runtime: "codex", profileId: "../../auth.json" },
        },
      ],
      [
        873,
        {
          workspaceId: "ws1",
          runId: "run-1",
          recoveryId: "recovery-ms7-run-1",
        },
      ],
    ]) {
      exReq(id, "cora.resume", params);
      await flush();
      check(
        `cora.resume rejects malformed or receipt-less input before mutation (${id})`,
        ex.outbox.at(-1)?.error?.code === "invalid-params",
        ex.outbox.at(-1),
      );
    }
    check(
      "invalid cora.resume requests never reach the recovery service",
      calls.length === callsBeforeMalformedResume,
      { before: callsBeforeMalformedResume, after: calls.length },
    );
    exReq(10, "cora.delete", {
      workspaceId: "ws1",
      runId: "run-1",
      requestId: "delete-run-1",
    });
    await flush();
    check(
      "cora.delete delegates the workspace-scoped run id",
      calls.at(-1)?.[0] === "cora.delete" &&
        calls.at(-1)?.[1]?.workspaceId === "ws1" &&
        calls.at(-1)?.[1]?.runId === "run-1" &&
        calls.at(-1)?.[1]?.requestId === "delete-run-1" &&
        ex.outbox.at(-1)?.ok === true,
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    exReq(9, "cora.send", {
      workspaceId: "ws1",
      runId: "run-1",
      message: "  keep going  ",
      clientMessageId: "phone-message-1",
      afterCursor: "cursor-before-send",
      model: "claude-opus-5",
      effort: "xhigh",
    });
    await flush();
    const sendDeltaResult = ex.outbox.at(-1)?.result;
    const sendDeltaBytes = Buffer.byteLength(
      JSON.stringify(sendDeltaResult),
      "utf8",
    );
    check(
      "cora.send trims, delegates its stable id, message cursor, model and effort",
      calls.at(-1)?.[1]?.message === "keep going" &&
        calls.at(-1)?.[1]?.clientMessageId === "phone-message-1" &&
        calls.at(-1)?.[1]?.afterCursor === "cursor-before-send" &&
        calls.at(-1)?.[1]?.model === "claude-opus-5" &&
        calls.at(-1)?.[1]?.effort === "xhigh" &&
        sendDeltaResult?.run?.messages?.length === 1 &&
        sendDeltaResult?.cursor === "cursor-after-send" &&
        typeof sendDeltaResult?.revision === "string" &&
        sendDeltaResult?.messageDelta?.afterCursor ===
          "cursor-before-send" &&
        !("messages" in sendDeltaResult.messageDelta),
      { call: calls.at(-1), result: sendDeltaResult },
    );
    exReq(91, "cora.send", {
      workspaceId: "ws1",
      message: "start a fresh conversation",
      clientMessageId: "phone-message-new",
    });
    await flush();
    const sendFullResult = ex.outbox.at(-1)?.result;
    const sendFullBytes = Buffer.byteLength(
      JSON.stringify(sendFullResult),
      "utf8",
    );
    check(
      "an existing-run send with 200 long messages is below 2% of the bounded full-window payload",
      sendFullResult?.run?.messages?.length === 200 &&
        sendDeltaBytes / sendFullBytes < 0.02,
      {
        sendDeltaBytes,
        sendFullBytes,
        ratio: sendDeltaBytes / sendFullBytes,
      },
    );
    const callsBeforeOversizedSendCursor = calls.length;
    exReq(92, "cora.send", {
      workspaceId: "ws1",
      runId: "run-1",
      message: "keep going",
      clientMessageId: "phone-message-oversized",
      afterCursor: "x".repeat(129),
    });
    await flush();
    check(
      "cora.send rejects an oversized message cursor before mutation",
      ex.outbox.at(-1)?.error?.code === "invalid-params" &&
        calls.length === callsBeforeOversizedSendCursor,
      {
        callsBeforeOversizedSendCursor,
        callsAfter: calls.length,
        response: ex.outbox.at(-1),
      },
    );
    check(
      "a send that omits model and effort leaves the run's composer alone",
      !("model" in (calls.at(-1)?.[1] ?? {})) &&
        !("effort" in (calls.at(-1)?.[1] ?? {})),
      calls.at(-1),
    );
    for (const [id, params] of [
      [
        940,
        {
          workspaceId: "ws1",
          runId: "run-1",
          message: "keep going",
          clientMessageId: "phone-message-bad-model",
          model: "llama-3",
        },
      ],
      [
        941,
        {
          workspaceId: "ws1",
          runId: "run-1",
          message: "keep going",
          clientMessageId: "phone-message-path-model",
          model: "claude-../../etc/passwd",
        },
      ],
      [
        942,
        {
          workspaceId: "ws1",
          runId: "run-1",
          message: "keep going",
          clientMessageId: "phone-message-bad-effort",
          effort: "ultra",
        },
      ],
      [
        943,
        {
          workspaceId: "ws1",
          runId: "run-1",
          message: "keep going",
          clientMessageId: "phone-message-object-effort",
          effort: { level: "high" },
        },
      ],
    ]) {
      const callsBeforeBadComposer = calls.length;
      exReq(id, "cora.send", params);
      await flush();
      check(
        `cora.send rejects an unroutable model or effort before mutation (${id})`,
        ex.outbox.at(-1)?.error?.code === "invalid-params" &&
          calls.length === callsBeforeBadComposer,
        { response: ex.outbox.at(-1), call: calls.at(-1) },
      );
    }
    exReq(93, "cora.send", {
      workspaceId: "ws1",
      runId: "run-1",
      message: "oversized after service normalization",
      clientMessageId: "phone-message-too-large-service",
    });
    await flush();
    check(
      "cora.send exposes a permanent message-too-large error code",
      ex.outbox.at(-1)?.error?.code === "message-too-large" &&
        ex.outbox.at(-1)?.error?.message ===
          "Cora messages are limited to 16 KiB.",
      ex.outbox.at(-1),
    );

    exReq(95, "workerSessions.list", {
      workspaceId: "ws1",
      runtime: "codex",
    });
    await flush();
    check(
      "workerSessions.list returns workspace-scoped resumable workers",
      calls.at(-1)?.[0] === "workerSessions.list" &&
        calls.at(-1)?.[1]?.workspaceId === "ws1" &&
        ex.outbox.at(-1)?.result?.sessions?.[0]?.sessionId ===
          "session-codex-1",
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );

    /* ---- worker session delete ---------------------------------------- */

    exReq(96, "workerSessions.delete", {
      workspaceId: "ws1",
      runtime: "codex",
      sessionId: "session-codex-1",
    });
    await flush();
    check(
      "workerSessions.delete delegates only a workspace, runtime, session id and scope",
      calls.at(-1)?.[0] === "workerSessions.delete" &&
        JSON.stringify(Object.keys(calls.at(-1)?.[1] ?? {}).sort()) ===
          JSON.stringify([
            "memoryScope",
            "runtime",
            "sessionId",
            "workspaceId",
          ]) &&
        // An omitted scope is the narrow one, never a wider delete.
        calls.at(-1)?.[1]?.memoryScope === "none" &&
        ex.outbox.at(-1)?.result?.deleted === true &&
        ex.outbox.at(-1)?.result?.memoryDeleted === false &&
        ex.outbox.at(-1)?.result?.warnings?.length === 1,
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    exReq(961, "workerSessions.delete", {
      workspaceId: "ws1",
      runtime: "codex",
      sessionId: "session-codex-1",
      memoryScope: "codex-all",
    });
    await flush();
    check(
      "workerSessions.delete carries an explicit memory scope and reports what it removed",
      calls.at(-1)?.[1]?.memoryScope === "codex-all" &&
        ex.outbox.at(-1)?.result?.memoryDeleted === true &&
        ex.outbox.at(-1)?.result?.memoryScope === "codex-all",
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    {
      // A memory scope belongs to exactly one runtime. Codex's scope wipes
      // every local Codex memory on the machine, so it must never be reachable
      // through a Claude delete, and vice versa.
      const callsBefore = calls.length;
      const mismatched = [
        { runtime: "claude", memoryScope: "codex-all" },
        { runtime: "codex", memoryScope: "claude-project" },
        { runtime: "claude", memoryScope: "everything" },
        { runtime: "codex", memoryScope: 1 },
      ];
      for (const params of mismatched) {
        exReq(962, "workerSessions.delete", {
          workspaceId: "ws1",
          sessionId: "session-codex-1",
          ...params,
        });
      }
      await flush();
      const refusals = ex.outbox
        .slice(-mismatched.length)
        .filter(
          (frame) =>
            frame?.ok === false && frame?.error?.code === "invalid-params",
        );
      check(
        "a memory scope from the other runtime is refused, never widened",
        refusals.length === mismatched.length && calls.length === callsBefore,
        { refusals: refusals.length, newCalls: calls.length - callsBefore },
      );
    }
    {
      // A phone cannot name a path here, so the only injection surface left is
      // the session id itself; it must be refused before any service runs.
      const callsBefore = calls.length;
      for (const sessionId of [
        "../../etc/passwd",
        "",
        "-leading-dash",
        "a".repeat(200),
      ]) {
        exReq(97, "workerSessions.delete", {
          workspaceId: "ws1",
          runtime: "codex",
          sessionId,
        });
      }
      exReq(98, "workerSessions.delete", {
        workspaceId: "ws1",
        runtime: "shell",
        sessionId: "session-codex-1",
      });
      await flush();
      const refusals = ex.outbox
        .slice(-5)
        .filter(
          (frame) =>
            frame?.ok === false && frame?.error?.code === "invalid-params",
        );
      check(
        "workerSessions.delete refuses a malformed session id or runtime without calling the service",
        refusals.length === 5 && calls.length === callsBefore,
        { refusals: refusals.length, newCalls: calls.length - callsBefore },
      );
    }

    /* ---- automation detail --------------------------------------------- */

    exReq(97, "automations.get", {
      workspaceId: "ws1",
      automationId: "loom-1",
    });
    await flush();
    check(
      "automations.get returns the loom's worker, prompt and pass history",
      calls.at(-1)?.[0] === "automations.get" &&
        calls.at(-1)?.[1]?.workspaceId === "ws1" &&
        ex.outbox.at(-1)?.result?.automation?.model === "claude-opus-5" &&
        ex.outbox.at(-1)?.result?.automation?.history?.[0]?.stopReason ===
          "agent-done" &&
        ex.outbox.at(-1)?.result?.automation?.history?.[0]?.costUsd === 0.42 &&
        ex.outbox.at(-1)?.result?.automation?.liveRun?.id ===
          "run-loom-live" &&
        ex.outbox.at(-1)?.result?.automation?.liveRun?.workers?.[0]?.id ===
          "attempt-live-1" &&
        ex.outbox.at(-1)?.result?.automation?.liveRun?.messages === undefined,
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    {
      const callsBefore = calls.length;
      for (const params of [
        null,
        { workspaceId: "ws1" },
        { automationId: "loom-1" },
      ]) {
        exReq(971, "automations.get", params);
      }
      await flush();
      const refusals = ex.outbox
        .slice(-3)
        .filter(
          (frame) =>
            frame?.ok === false && frame?.error?.code === "invalid-params",
        );
      check(
        "automations.get refuses a request that does not name both the workspace and the loom",
        refusals.length === 3 && calls.length === callsBefore,
        { refusals: refusals.length, newCalls: calls.length - callsBefore },
      );
    }

    const workerTerminalBefore = ex.outbox.length;
    exReq(972, "automations.workerTerminal.open", {
      workspaceId: "ws1",
      runId: "run-loom-live",
      workerId: "attempt-live-1",
    });
    await flush();
    const workerTerminalFrames = ex.outbox.slice(workerTerminalBefore);
    const workerTerminalResponse = workerTerminalFrames.find(
      (frame) => frame?.id === 972,
    );
    const workerTerminalData = workerTerminalFrames.find(
      (frame) => frame?.event === "terminal.data",
    );
    check(
      "automation worker terminal validates ownership inputs and streams after its response",
      calls.at(-1)?.[0] === "automations.workerTerminal.open" &&
        calls.at(-1)?.[1]?.workspaceId === "ws1" &&
        calls.at(-1)?.[1]?.runId === "run-loom-live" &&
        calls.at(-1)?.[1]?.workerId === "attempt-live-1" &&
        workerTerminalResponse?.ok === true &&
        workerTerminalResponse?.result?.controlCapability === "steer" &&
        workerTerminalData?.payload?.terminalId ===
          workerTerminalResponse?.result?.terminalId &&
        workerTerminalData?.payload?.sequence === 1 &&
        workerTerminalFrames.indexOf(workerTerminalResponse) <
          workerTerminalFrames.indexOf(workerTerminalData),
      { call: calls.at(-1), frames: workerTerminalFrames },
    );
    const beforeWorkerLive = ex.outbox.length;
    calls.at(-1)?.[1]?.onData("worker live");
    const workerLiveData = ex.outbox.slice(beforeWorkerLive).find(
      (frame) => frame?.event === "terminal.data",
    );
    check(
      "automation worker live output continues the terminal sequence",
      workerLiveData?.payload?.terminalId ===
        workerTerminalResponse?.result?.terminalId &&
        workerLiveData?.payload?.sequence === 2 &&
        workerLiveData?.payload?.data === "worker live",
      workerLiveData,
    );
    const workerTerminalId = workerTerminalResponse?.result?.terminalId;
    exReq(9721, "automations.workerTerminal.acquire", {
      terminalId: workerTerminalId,
    });
    await flush();
    const controlLease = ex.outbox.at(-1)?.result;
    check(
      "an authenticated phone explicitly acquires a short worker control lease",
      ex.outbox.at(-1)?.ok === true &&
        typeof controlLease?.controlLeaseId === "string" &&
        controlLease?.nextInputSequence === 1 &&
        Number.isSafeInteger(controlLease?.expiresAt),
      ex.outbox.at(-1),
    );
    exReq(9722, "automations.workerTerminal.write", {
      terminalId: workerTerminalId,
      controlLeaseId: controlLease?.controlLeaseId,
      inputSequence: 1,
      data: "check the failing test\r",
    });
    await flush();
    exReq(9723, "automations.workerTerminal.write", {
      terminalId: workerTerminalId,
      controlLeaseId: controlLease?.controlLeaseId,
      inputSequence: 1,
      data: "check the failing test\r",
    });
    await flush();
    check(
      "worker input retries are exactly once through the RPC boundary",
      sharedWorkerTerminal?.written?.length === 1 &&
        sharedWorkerTerminal.written[0] === "check the failing test\r" &&
        ex.outbox.at(-1)?.ok === true &&
        ex.outbox.at(-1)?.result?.nextInputSequence === 2,
      {
        writes: sharedWorkerTerminal?.written,
        response: ex.outbox.at(-1),
      },
    );
    exReq(9724, "automations.workerTerminal.write", {
      terminalId: workerTerminalId,
      controlLeaseId: "forged-worker-control",
      inputSequence: 2,
      data: "must not run\r",
    });
    await flush();
    check(
      "a forged worker control lease cannot write",
      ex.outbox.at(-1)?.ok === false &&
        ex.outbox.at(-1)?.error?.code === "terminal-control-lost" &&
        sharedWorkerTerminal?.written?.length === 1,
      ex.outbox.at(-1),
    );
    exReq(973, "terminal.close", { terminalId: workerTerminalId });
    await flush();
    check(
      "a durable-terminal session still closes its connection-scoped worker mirror with {terminalId}",
      ex.outbox.at(-1)?.id === 973 &&
        ex.outbox.at(-1)?.ok === true &&
        sharedWorkerTerminal?.closed === true,
      { response: ex.outbox.at(-1), worker: sharedWorkerTerminal },
    );
    workerControlRegistry.shutdown();

    /* ---- Cora whiteboard ------------------------------------------------ */

    exReq(99, "cora.whiteboard.get", { workspaceId: "ws1", runId: "run-1" });
    await flush();
    check(
      "cora.whiteboard.get returns nodes and edges without canvas geometry",
      calls.at(-1)?.[0] === "cora.whiteboard.get" &&
        ex.outbox.at(-1)?.result?.whiteboard?.nodes?.length === 2 &&
        ex.outbox.at(-1)?.result?.whiteboard?.edges?.[0]?.label ===
          "bounded by" &&
        !("x" in (ex.outbox.at(-1)?.result?.whiteboard?.nodes?.[0] ?? {})),
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    exReq(991, "cora.whiteboard.get", {
      workspaceId: "ws1",
      runId: "run-blank",
    });
    await flush();
    check(
      "a chat with no whiteboard answers null rather than an error",
      ex.outbox.at(-1)?.ok === true &&
        ex.outbox.at(-1)?.result?.whiteboard === null,
      ex.outbox.at(-1),
    );

    /* ---- Cora Board ---------------------------------------------------- */

    exReq(100, "cora.board.get", { workspaceId: "ws1", runId: "run-1" });
    await flush();
    check(
      "cora.board.get returns the chat's revisioned card list",
      calls.at(-1)?.[0] === "cora.board.get" &&
        ex.outbox.at(-1)?.result?.board?.revision === 4 &&
        ex.outbox.at(-1)?.result?.board?.cards?.[0]?.id === "card-1" &&
        typeof ex.outbox.at(-1)?.result?.revision === "string",
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    const boardReadRevision = ex.outbox.at(-1)?.result?.revision;
    exReq(9100, "cora.board.get", {
      workspaceId: "ws1",
      runId: "run-1",
      ifRevision: boardReadRevision,
    });
    await flush();
    check(
      "cora.board.get omits cards when the bounded revision is unchanged",
      calls.at(-1)?.[1]?.ifRevision === boardReadRevision &&
        ex.outbox.at(-1)?.result?.notModified === true &&
        ex.outbox.at(-1)?.result?.revision === boardReadRevision &&
        !("board" in (ex.outbox.at(-1)?.result ?? {})),
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    exReq(9101, "cora.board.get", {
      workspaceId: "ws1",
      runId: "run-1",
      ifRevision: "stale-board-revision",
    });
    await flush();
    check(
      "cora.board.get returns current cards when the bounded revision changed",
      ex.outbox.at(-1)?.result?.notModified !== true &&
        ex.outbox.at(-1)?.result?.board?.cards?.[0]?.id === "card-1" &&
        ex.outbox.at(-1)?.result?.revision === boardReadRevision,
      ex.outbox.at(-1),
    );
    exReq(9102, "cora.board.get", {
      workspaceId: "ws1",
      runId: "run-empty",
    });
    await flush();
    check(
      "cora.board.get returns an empty board as a full valid projection",
      ex.outbox.at(-1)?.result?.board?.cards?.length === 0 &&
        typeof ex.outbox.at(-1)?.result?.revision === "string",
      ex.outbox.at(-1),
    );
    const callsBeforeMalformedBoardRead = calls.length;
    exReq(9103, "cora.board.get", {
      workspaceId: "ws1",
      runId: "run-1",
      ifRevision: 4,
    });
    await flush();
    check(
      "cora.board.get rejects a malformed conditional revision before service dispatch",
      calls.length === callsBeforeMalformedBoardRead &&
        ex.outbox.at(-1)?.ok === false &&
        ex.outbox.at(-1)?.error?.code === "invalid-params",
      { calls: calls.slice(callsBeforeMalformedBoardRead), response: ex.outbox.at(-1) },
    );
    exReq(9104, "cora.board.get", {
      workspaceId: "ws1",
      runId: "run-1",
      ifRevision: "x".repeat(129),
    });
    await flush();
    check(
      "cora.board.get bounds a conditional revision before service dispatch",
      calls.length === callsBeforeMalformedBoardRead &&
        ex.outbox.at(-1)?.ok === false &&
        ex.outbox.at(-1)?.error?.code === "invalid-params",
      { calls: calls.slice(callsBeforeMalformedBoardRead), response: ex.outbox.at(-1) },
    );
    exReq(101, "cora.board.update", {
      workspaceId: "ws1",
      runId: "run-1",
      baseRevision: 4,
      action: "add-idea",
      title: "  Try the board on the phone  ",
      description: "  with a body  ",
    });
    await flush();
    check(
      "cora.board.update add-idea trims its card text and carries the read revision",
      calls.at(-1)?.[1]?.title === "Try the board on the phone" &&
        calls.at(-1)?.[1]?.description === "with a body" &&
        calls.at(-1)?.[1]?.baseRevision === 4 &&
        ex.outbox.at(-1)?.result?.applied === true,
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    exReq(102, "cora.board.update", {
      workspaceId: "ws1",
      runId: "run-1",
      baseRevision: 4,
      action: "queue",
      cardId: "card-1",
    });
    await flush();
    check(
      "cora.board.update queue names one card and returns the advanced board",
      calls.at(-1)?.[1]?.action === "queue" &&
        calls.at(-1)?.[1]?.cardId === "card-1" &&
        ex.outbox.at(-1)?.result?.board?.revision === 5 &&
        ex.outbox.at(-1)?.result?.board?.cards?.[0]?.status === "queued",
      { call: calls.at(-1), response: ex.outbox.at(-1) },
    );
    exReq(103, "cora.board.update", {
      workspaceId: "ws1",
      runId: "run-1",
      baseRevision: 2,
      action: "delete",
      cardId: "card-1",
    });
    await flush();
    check(
      "a stale board write is reported unapplied with the current board, not an error",
      ex.outbox.at(-1)?.ok === true &&
        ex.outbox.at(-1)?.result?.applied === false &&
        ex.outbox.at(-1)?.result?.board?.revision === 4,
      ex.outbox.at(-1),
    );
    {
      const callsBefore = calls.length;
      const badWrites = [
        // add-idea without a usable title
        {
          workspaceId: "ws1",
          runId: "run-1",
          baseRevision: 4,
          action: "add-idea",
        },
        {
          workspaceId: "ws1",
          runId: "run-1",
          baseRevision: 4,
          action: "add-idea",
          title: "   ",
        },
        {
          workspaceId: "ws1",
          runId: "run-1",
          baseRevision: 4,
          action: "add-idea",
          title: "x".repeat(rpc.MAX_BOARD_CARD_TITLE_LENGTH + 1),
        },
        // card actions without a card
        {
          workspaceId: "ws1",
          runId: "run-1",
          baseRevision: 4,
          action: "queue",
        },
        {
          workspaceId: "ws1",
          runId: "run-1",
          baseRevision: 4,
          action: "delete",
          cardId: "",
        },
        // lanes the phone may not assign, and revisions that are not one
        {
          workspaceId: "ws1",
          runId: "run-1",
          baseRevision: 4,
          action: "done",
          cardId: "card-1",
        },
        {
          workspaceId: "ws1",
          runId: "run-1",
          baseRevision: -1,
          action: "queue",
          cardId: "card-1",
        },
        {
          workspaceId: "ws1",
          runId: "run-1",
          baseRevision: 1.5,
          action: "queue",
          cardId: "card-1",
        },
        {
          workspaceId: "ws1",
          baseRevision: 4,
          action: "queue",
          cardId: "card-1",
        },
      ];
      for (const params of badWrites) exReq(104, "cora.board.update", params);
      await flush();
      const refusals = ex.outbox
        .slice(-badWrites.length)
        .filter(
          (frame) =>
            frame?.ok === false && frame?.error?.code === "invalid-params",
        );
      check(
        "cora.board.update refuses every malformed write before the board is touched",
        refusals.length === badWrites.length && calls.length === callsBefore,
        { refusals: refusals.length, newCalls: calls.length - callsBefore },
      );
    }

    const beforeCreate = ex.outbox.length;
    const durableCreate = {
      workspaceId: "ws1",
      cols: 92,
      rows: 31,
      profile: "codex",
      resumeSessionId: "session-codex-1",
      title: "Phone worker",
      requestId: "create-phone-worker-0001",
    };
    exReq(10, "terminal.create", durableCreate);
    await flush();
    const createdFrames = ex.outbox.slice(beforeCreate);
    const createResponse = createdFrames.find((frame) => frame?.id === 10);
    const terminalId = createResponse?.result?.terminalId;
    const firstAttachmentId = createResponse?.result?.attachmentId;
    check(
      "durable terminal.create returns bootstrap output as sequenced replay",
      createResponse?.id === 10 &&
        createResponse?.ok === true &&
        createResponse?.result?.terminal?.terminalId === terminalId &&
        createResponse?.result?.replay?.[0]?.sequence === 1 &&
        createResponse?.result?.replay?.[0]?.data === "opening prompt" &&
        !createdFrames.some((frame) => frame?.event === "terminal.data"),
      createdFrames,
    );
    check(
      "terminal.create exposes the visible desktop tab and trusted phone name",
      createResponse?.result?.desktopTabId === "term-desktop" &&
        calls.at(-1)?.[1]?.profile === "codex" &&
        calls.at(-1)?.[1]?.resumeSessionId === "session-codex-1" &&
        calls.at(-1)?.[1]?.origin?.deviceName === "Etienne's iPhone",
      { response: createResponse, origin: calls.at(-1)?.[1]?.origin },
    );

    const spawnCountAfterCreate = sharedTerminals.length;
    exReq(1005, "terminal.create", durableCreate);
    await flush();
    const retryCreateResponse = ex.outbox.find(
      (frame) => frame?.id === 1005,
    );
    const retryAttachmentId = retryCreateResponse?.result?.attachmentId;
    check(
      "a stable terminal.create requestId retries the same lease without spawning twice",
      retryCreateResponse?.ok === true &&
        retryCreateResponse?.result?.terminalId === terminalId &&
        retryAttachmentId !== firstAttachmentId &&
        sharedTerminals.length === spawnCountAfterCreate,
      {
        response: retryCreateResponse,
        spawns: sharedTerminals.length - spawnCountAfterCreate,
      },
    );

    exReq(1006, "terminal.list", {});
    await flush();
    check(
      "terminal.list returns only the authenticated phone's durable descriptors",
      ex.outbox.at(-1)?.id === 1006 &&
        ex.outbox.at(-1)?.result?.terminals?.length === 1 &&
        ex.outbox.at(-1)?.result?.terminals?.[0]?.terminalId === terminalId &&
        terminalLeaseStore.calls.at(-1)?.[0] === "list" &&
        terminalLeaseStore.calls.at(-1)?.[1] === "trusted-phone-key",
      {
        response: ex.outbox.at(-1),
        storeCall: terminalLeaseStore.calls.at(-1),
      },
    );

    const beforeLiveData = ex.outbox.length;
    sharedTerminals[0].request.onData("live output");
    const liveData = ex.outbox.slice(beforeLiveData).find(
      (frame) => frame?.event === "terminal.data",
    );
    check(
      "a durable live terminal emits an increasing output sequence",
      liveData?.payload?.terminalId === terminalId &&
        liveData?.payload?.sequence === 2 &&
        liveData?.payload?.data === "live output",
      liveData,
    );

    exReq(1007, "terminal.detach", {
      terminalId,
      attachmentId: retryAttachmentId,
    });
    await flush();
    const beforeDetachedOutput = ex.outbox.length;
    sharedTerminals[0].request.onData("while detached");
    check(
      "terminal.detach stops socket delivery without closing the leased PTY",
      ex.outbox.length === beforeDetachedOutput &&
        sharedTerminals[0].closed === false,
      ex.outbox.slice(beforeDetachedOutput),
    );

    exReq(1008, "terminal.attach", {
      terminalId,
      afterSequence: 2,
    });
    await flush();
    const attachResponse = ex.outbox.at(-1);
    const replayAttachmentId = attachResponse?.result?.attachmentId;
    check(
      "terminal.attach resumes after a sequence cursor with bounded replay",
      attachResponse?.id === 1008 &&
        attachResponse?.ok === true &&
        attachResponse?.result?.terminal?.terminalId === terminalId &&
        attachResponse?.result?.replay?.length === 1 &&
        attachResponse?.result?.replay?.[0]?.sequence === 3 &&
        attachResponse?.result?.replay?.[0]?.data === "while detached" &&
        attachResponse?.result?.truncated === false,
      attachResponse,
    );

    exReq(1009, "terminal.attach", {
      terminalId,
      afterSequence: 3,
    });
    await flush();
    const newestAttachmentId = ex.outbox.at(-1)?.result?.attachmentId;
    exReq(1010, "terminal.write", {
      terminalId,
      attachmentId: replayAttachmentId,
      inputSequence: 1,
      data: "stale\n",
    });
    await flush();
    check(
      "a newer terminal.attach fences writes from the stale attachment",
      ex.outbox.at(-1)?.id === 1010 &&
        ex.outbox.at(-1)?.ok === false &&
        ex.outbox.at(-1)?.error?.code === "unknown-terminal" &&
        sharedTerminals[0].written.length === 0,
      ex.outbox.at(-1),
    );

    const sequencedWrite = {
      terminalId,
      attachmentId: newestAttachmentId,
      inputSequence: 1,
      data: "echo durable\n",
    };
    exReq(1011, "terminal.write", sequencedWrite);
    await flush();
    exReq(1012, "terminal.write", sequencedWrite);
    await flush();
    check(
      "terminal.write is exactly-once for a repeated inputSequence and payload",
      ex.outbox.at(-1)?.id === 1012 &&
        ex.outbox.at(-1)?.ok === true &&
        sharedTerminals[0].written.join("") === "echo durable\n",
      {
        response: ex.outbox.at(-1),
        written: sharedTerminals[0].written,
      },
    );
    exReq(1013, "terminal.write", {
      ...sequencedWrite,
      data: "different\n",
    });
    await flush();
    check(
      "terminal.write refuses different input under an accepted inputSequence",
      ex.outbox.at(-1)?.id === 1013 &&
        ex.outbox.at(-1)?.ok === false &&
        ex.outbox.at(-1)?.error?.code === "mutation-conflict" &&
        sharedTerminals[0].written.length === 1,
      ex.outbox.at(-1),
    );

    exReq(1014, "terminal.resize", {
      terminalId,
      attachmentId: newestAttachmentId,
      cols: 100,
      rows: 40,
    });
    await flush();
    check(
      "terminal.resize is fenced by the current attachment generation",
      ex.outbox.at(-1)?.id === 1014 &&
        ex.outbox.at(-1)?.ok === true &&
        sharedTerminals[0].sizes?.[0]?.join("x") === "100x40",
      {
        response: ex.outbox.at(-1),
        sizes: sharedTerminals[0].sizes,
      },
    );

    const closeParams = {
      terminalId,
      attachmentId: newestAttachmentId,
      requestId: "close-phone-worker-0001",
    };
    exReq(1015, "terminal.close", closeParams);
    await flush();
    exReq(1016, "terminal.close", closeParams);
    await flush();
    check(
      "terminal.close is idempotent under its stable requestId",
      ex.outbox.at(-1)?.id === 1016 &&
        ex.outbox.at(-1)?.ok === true &&
        sharedTerminals[0].closed === true &&
        terminalLeaseStore.leases.has(terminalId) === false,
      {
        response: ex.outbox.at(-1),
        terminal: sharedTerminals[0],
      },
    );

    exReq(1017, "terminal.list", {});
    await flush();
    check(
      "terminal.list drops an explicitly closed lease",
      ex.outbox.at(-1)?.result?.terminals?.length === 0,
      ex.outbox.at(-1),
    );

    // The OpenCode / Cursor / Grok terminal providers were removed. A phone
    // still running an older build can ask for one of those profiles, so the
    // request must be rejected as unsupported rather than silently starting a
    // bare shell that the user believes is a coding agent.
    const removedProfiles = ["opencode", "cursor", "grok"];
    const removedCreates = [];
    for (let index = 0; index < removedProfiles.length; index += 1) {
      const profile = removedProfiles[index];
      exReq(1100 + index, "terminal.create", {
        workspaceId: "ws1",
        cols: 80,
        rows: 24,
        profile,
        requestId: `create-${profile}-phone-0001`,
      });
      await flush();
      const response = ex.outbox.at(-1);
      removedCreates.push({
        profile,
        ok: response?.ok,
        code: response?.error?.code,
      });
    }
    check(
      "phone terminal.create rejects the removed experimental CLI profiles",
      removedCreates.every(
        (entry) => entry.ok === false && entry.code === "invalid-params",
      ),
      removedCreates,
    );

    exReq(1018, "terminal.create", {
      workspaceId: "ws1",
      cols: 80,
      rows: 24,
      requestId: "create-survive-disconnect-0001",
    });
    await flush();
    const survivingTerminal = sharedTerminals.at(-1);
    exSession.destroy();
    check(
      "production disconnect detaches its subscriber while preserving the durable PTY",
      survivingTerminal?.closed === false &&
        terminalLeaseStore.leases.size === 1 &&
        terminalLeaseStore.calls.at(-1)?.[0] === "detachSubscriber",
      {
        terminal: survivingTerminal,
        leases: terminalLeaseStore.leases.size,
        storeCall: terminalLeaseStore.calls.at(-1),
      },
    );
  }

  /* ---- old-Studio degradation for the optional surfaces ---------------- */

  {
    // The base services object has no board and no session delete, exactly
    // like a Studio that predates them. The phone must be told the method is
    // unknown so it hides the affordance instead of showing a dead control.
    const old = makeFakeStream();
    void new rpc.RpcSession(old, services);
    old.inject(
      rpc.encodeFrame({
        id: 1,
        method: "hello",
        params: { protocol: rpc.RPC_PROTOCOL_VERSION },
      }),
    );
    await flush();
    const before = old.outbox.length;
    old.inject(
      rpc.encodeFrame({
        id: 2,
        method: "cora.board.get",
        params: { workspaceId: "ws1", runId: "run-1" },
      }),
    );
    old.inject(
      rpc.encodeFrame({
        id: 5,
        method: "cora.whiteboard.get",
        params: { workspaceId: "ws1", runId: "run-1" },
      }),
    );
    old.inject(
      rpc.encodeFrame({
        id: 3,
        method: "cora.board.update",
        params: {
          workspaceId: "ws1",
          runId: "run-1",
          baseRevision: 0,
          action: "queue",
          cardId: "c",
        },
      }),
    );
    old.inject(
      rpc.encodeFrame({
        id: 4,
        method: "workerSessions.delete",
        params: { workspaceId: "ws1", runtime: "claude", sessionId: "abc" },
      }),
    );
    old.inject(
      rpc.encodeFrame({
        id: 6,
        method: "automations.workerTerminal.open",
        params: { workspaceId: "ws1", runId: "run-1", workerId: "attempt-1" },
      }),
    );
    old.inject(
      rpc.encodeFrame({
        id: 7,
        method: "fleet.overview",
        params: {},
      }),
    );
    old.inject(
      rpc.encodeFrame({
        id: 8,
        method: "github.workQueue",
        params: {},
      }),
    );
    await flush();
    const answers = old.outbox.slice(before);
    check(
      "an older Studio answers unknown-method for newer phone surfaces",
      answers.length === 7 &&
        answers.every(
          (frame) =>
            frame?.ok === false && frame?.error?.code === "unknown-method",
        ),
      answers,
    );
  }

  /* ---- early terminal exit and oversized outbound reply guards --------- */

  {
    const early = makeFakeStream();
    const earlyServices = {
      ...services,
      createTerminal: async (request) => {
        request.onExit();
        return { write() {}, resize() {}, close() {} };
      },
    };
    void new rpc.RpcSession(early, earlyServices);
    early.inject(
      rpc.encodeFrame({
        id: 1,
        method: "hello",
        params: { protocol: rpc.RPC_PROTOCOL_VERSION },
      }),
    );
    await flush();
    const before = early.outbox.length;
    early.inject(
      rpc.encodeFrame({
        id: 2,
        method: "terminal.create",
        params: { workspaceId: "ws1", cols: 80, rows: 24 },
      }),
    );
    await flush();
    const frames = early.outbox.slice(before);
    check(
      "a terminal that exits before registration returns one create error",
      frames.length === 1 && frames[0]?.id === 2 && frames[0]?.ok === false,
      frames,
    );
    check(
      "an early terminal exit never emits an unassociable terminal.exit",
      !frames.some((frame) => frame?.event === "terminal.exit"),
      frames,
    );

    const huge = makeFakeStream();
    void new rpc.RpcSession(huge, {
      ...services,
      listWorkspaces: async () => [
        {
          id: "huge",
          name: "x".repeat(rpc.MAX_FRAME_BYTES + 100),
          path: "/tmp",
        },
      ],
    });
    huge.inject(
      rpc.encodeFrame({
        id: 1,
        method: "hello",
        params: { protocol: rpc.RPC_PROTOCOL_VERSION },
      }),
    );
    await flush();
    huge.inject(
      rpc.encodeFrame({ id: 2, method: "workspaces.list", params: {} }),
    );
    await flush();
    check(
      "an oversized service response becomes a compact RPC error",
      huge.outbox.at(-1)?.id === 2 &&
        huge.outbox.at(-1)?.ok === false &&
        /too large/i.test(huge.outbox.at(-1)?.error?.message ?? ""),
      huge.outbox.at(-1),
    );
  }

  if (failures > 0) {
    console.error(`${failures} failure(s)`);
    process.exit(1);
  }
  console.log("all remote-access checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
