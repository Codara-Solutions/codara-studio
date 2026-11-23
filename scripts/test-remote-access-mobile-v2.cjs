#!/usr/bin/env node
"use strict";

// Focused pure-Node verification for mobile v2 remote-access features:
// - Workspace Rail tree enrichment (parentWorkspaceId, worktree, pullRequest,
//   agentStatus urgency ranking, note truncation, and wire budget shedding).
// - Unified sessions.search parameter validation, host-path redaction,
//   snippet marker stripping, wire budget enforcement, and per-device rate
//   limiting (including revoke cleanup).
// - 5-agent resume ownership verification (claude, codex, grok, pi,
//   antigravity) across workspace, project, and all scopes, rejecting unknown
//   ids, command-injection shapes, and sessions outside local workspaces.
// - Renderer source guards for manual desktop agent tab sharing and fresh
//   browser preview tab creation.
//
//   node scripts/test-remote-access-mobile-v2.cjs

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

let failures = 0;
const check = (name, condition, detail) => {
  if (!condition) {
    failures += 1;
    if (detail !== undefined) console.log(`     got: ${JSON.stringify(detail)}`);
  }
  console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
};

async function bundle(entry, outName, dir) {
  const outfile = path.join(dir, outName);
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    external: ["sodium-native", "@hyperswarm/secret-stream", "ws"],
  });
  return require(outfile);
}

function makeFakeStream(rpc, keyByte = 7) {
  const handlers = { data: [], close: [], error: [], drain: [] };
  const decoder = new rpc.FrameDecoder();
  const outbox = [];
  return {
    remotePublicKey: Buffer.alloc(32, keyByte),
    outbox,
    destroyed: false,
    ended: false,
    write(buf) {
      for (const frame of decoder.push(buf)) outbox.push(frame);
      return true;
    },
    end() { this.ended = true; handlers.close.forEach((h) => h()); },
    destroy() { this.destroyed = true; handlers.close.forEach((h) => h()); },
    on(event, handler) { handlers[event].push(handler); },
    inject(buf) { handlers.data.forEach((h) => h(buf)); },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

const makePrEntry = (workspaceId, number, phase, checks = "passing") => ({
  workspaceId,
  repository: "codara-solutions/codara-studio",
  watching: true,
  pullRequest: {
    workspaceId,
    repository: "codara-solutions/codara-studio",
    number,
    url: `https://github.com/codara-solutions/codara-studio/pull/${number}`,
    title: `PR ${number}`,
    phase,
    checks,
    failed: [],
    headOid: `oid-${number}`,
  },
});

const makeNote = (workspaceId, status, note, updatedAt, label) => ({
  key: `worktree:${workspaceId}`,
  workspaceId,
  entry: { status, note, updatedAt, by: { kind: "agent", label }, checkpoints: [] },
});

const makeSearchHit = (overrides) => ({
  key: `${overrides.agent}:${overrides.sessionId}`,
  title: "Untitled",
  originalTitle: null,
  pinned: false,
  branch: null,
  matches: [],
  snippet: null,
  snippetRole: null,
  cwd: "/Users/alice/dev/codara-studio",
  cwdExists: true,
  model: null,
  messageCount: 1,
  startedAt: null,
  lastAt: 1700000500000,
  workspaceId: null,
  ...overrides,
});

const makeSearchStatus = (overrides = {}) => ({
  enabled: true,
  phase: "idle",
  pausedReason: null,
  firstBuild: false,
  filesTotal: 0,
  filesDone: 0,
  sessions: 42,
  messages: 500,
  indexBytes: 1024,
  lastSyncAt: 1700000000000,
  error: null,
  introPending: false,
  ...overrides,
});

async function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codara-remote-mobile-v2-"));
  const cacheRoot = path.join(ROOT, "node_modules", ".cache");
  fs.mkdirSync(cacheRoot, { recursive: true });
  const bundleDir = fs.mkdtempSync(path.join(cacheRoot, "remote-mobile-v2-"));

  try {
    const railProj = await bundle(path.join(ROOT, "src", "main", "remote-access", "workspace-rail-projection.ts"), "workspace-rail-projection.cjs", bundleDir);
    const sessionRemote = await bundle(path.join(ROOT, "src", "main", "remote-access", "session-search-remote.ts"), "session-search-remote.cjs", bundleDir);
    const rpc = await bundle(path.join(ROOT, "src", "main", "remote-access", "rpc.ts"), "rpc.cjs", bundleDir);
    const remoteAccess = await bundle(path.join(ROOT, "src", "main", "remote-access", "index.ts"), "remote-access.cjs", bundleDir);

    // 1. Workspace rail tree enrichment
    {
      const workspaces = [
        { id: "ws-proj", name: "Codara Studio", cwd: "/work/codara-studio", color: "#5865f2", workers: [] },
        {
          id: "ws-wt-open",
          name: "feat-mobile",
          cwd: "/work/worktrees/feat-mobile",
          color: "#5865f2",
          workers: [],
          copyBranch: {
            repoCwd: "/work/codara-studio",
            branch: "feat/mobile-v2",
            baseBranch: "main",
            city: "feat-mobile",
            createdAt: "2026-11-23T10:00:00Z",
            createdBy: { kind: "agent", client: "claude-code", fromWorkspaceName: "Codara Studio" },
          },
        },
        {
          id: "ws-wt-merged",
          name: "fix-old",
          cwd: "/work/worktrees/fix-old",
          color: "#5865f2",
          workers: [],
          copyBranch: {
            repoCwd: "/work/codara-studio",
            branch: "fix/old",
            baseBranch: "main",
            city: "fix-old",
            createdAt: "2026-11-22T10:00:00Z",
            createdBy: { kind: "user" },
          },
        },
        {
          id: "ws-orphan-wt",
          name: "orphan-wt",
          cwd: "/work/worktrees/orphan",
          color: "#5865f2",
          workers: [],
          copyBranch: { repoCwd: "/work/not-in-rail", branch: "feat/orphan", city: "orphan", createdAt: "2026-11-22T12:00:00Z" },
        },
      ];
      const baseInfos = workspaces.map((ws) => ({ id: ws.id, name: ws.name, path: ws.cwd, color: ws.color }));
      const longNote = "x".repeat(220);
      const enriched = railProj.enrichRemoteWorkspaces({
        workspaces,
        baseInfos,
        railOrder: ["ws-proj"],
        pullRequests: [makePrEntry("ws-wt-open", 327, "open", "passing"), makePrEntry("ws-wt-merged", 320, "merged", "passing")],
        agentStates: [
          { workspaceId: "ws-proj", tabId: "t1", paneId: "p1", runtime: "codex", state: "working" },
          { workspaceId: "ws-proj", tabId: "t2", paneId: "p2", runtime: "claude", state: "blocked" },
          { workspaceId: "ws-wt-open", tabId: "t3", paneId: "p3", runtime: "antigravity", state: "working" },
        ],
        agentActivities: [
          {
            paneId: "p2", workspaceId: "ws-proj", tabId: "t2", tabTitle: "Claude", runtime: "claude", state: "blocked",
            stateSince: 1700000100000, sessionSince: 1700000000000, turnStartedAt: 1700000050000,
            tool: null, prompt: null, message: null, question: "Approve migration?", accountProfileId: null,
          },
          {
            paneId: "p3", workspaceId: "ws-wt-open", tabId: "t3", tabTitle: "Antigravity", runtime: "antigravity", state: "working",
            stateSince: 1700000200000, workingSince: 1700000150000, sessionSince: 1700000000000, turnStartedAt: 1700000150000,
            tool: "edit_file", prompt: null, message: null, question: null, accountProfileId: null,
          },
        ],
        agentNotes: {
          "worktree:ws-wt-open": makeNote("ws-wt-open", "in_progress", longNote, 1700000300000, "Antigravity"),
          "worktree:ws-wt-merged": makeNote("ws-wt-merged", "done", "Landed cleanly", 1700000400000, "Codex"),
        },
        budgetBytes: 384 * 1024,
      });

      const byId = new Map(enriched.map((w) => [w.id, w]));
      const proj = byId.get("ws-proj");
      const wtOpen = byId.get("ws-wt-open");
      const wtMerged = byId.get("ws-wt-merged");
      const orphan = byId.get("ws-orphan-wt");

      check(
        "enrichRemoteWorkspaces links parentWorkspaceId, worktree metadata, merged flag, and PR badge",
        proj?.parentWorkspaceId === undefined &&
          wtOpen?.parentWorkspaceId === "ws-proj" &&
          wtOpen?.worktree?.branch === "feat/mobile-v2" &&
          wtOpen?.worktree?.baseBranch === "main" &&
          wtOpen?.worktree?.createdBy?.kind === "agent" &&
          wtOpen?.worktree?.createdBy?.client === "claude-code" &&
          wtOpen?.worktree?.createdBy?.fromWorkspaceName === "Codara Studio" &&
          wtOpen?.worktree?.merged === false &&
          wtOpen?.pullRequest?.number === 327 &&
          wtOpen?.pullRequest?.phase === "open" &&
          wtOpen?.pullRequest?.checks === "passing" &&
          wtMerged?.parentWorkspaceId === "ws-proj" &&
          wtMerged?.worktree?.merged === true &&
          orphan?.parentWorkspaceId === undefined &&
          orphan?.worktree?.branch === "feat/orphan",
        { proj, wtOpen, wtMerged, orphan },
      );

      check(
        "enrichRemoteWorkspaces picks most urgent agentStatus, carries worktree note fallback, and truncates notes to <= 160 chars",
        proj?.agentStatus?.state === "needs-you" &&
          proj?.agentStatus?.label === "Claude Code" &&
          proj?.agentStatus?.since === 1700000100000 &&
          proj?.agentStatus?.note === "Approve migration?" &&
          wtOpen?.agentStatus?.state === "working" &&
          wtOpen?.agentStatus?.label === "Antigravity" &&
          wtOpen?.agentStatus?.since === 1700000150000 &&
          typeof wtOpen?.agentStatus?.note === "string" &&
          wtOpen.agentStatus.note.length <= 160 &&
          wtMerged?.agentStatus?.state === "done" &&
          wtMerged?.agentStatus?.note === "Landed cleanly",
        { proj: proj?.agentStatus, wtOpen: wtOpen?.agentStatus, wtMerged: wtMerged?.agentStatus },
      );

      const baseBytes = 2 + baseInfos.reduce((sum, info) => sum + Buffer.byteLength(JSON.stringify(info), "utf8") + 1, 0);
      const tight = railProj.enrichRemoteWorkspaces({
        workspaces,
        baseInfos,
        railOrder: ["ws-proj"],
        pullRequests: [makePrEntry("ws-wt-open", 327, "open", "passing")],
        agentNotes: { "worktree:ws-wt-open": makeNote("ws-wt-open", "in_progress", longNote, 1700000300000, "Claude Code") },
        budgetBytes: baseBytes + 20,
      });
      const tightBytes = Buffer.byteLength(JSON.stringify(tight), "utf8");
      check(
        "enrichRemoteWorkspaces sheds optional metadata before dropping workspaces under tight wire budget",
        tight.length === baseInfos.length && tightBytes <= baseBytes + 20,
        { count: tight.length, expected: baseInfos.length, tightBytes, budget: baseBytes + 20 },
      );

      // NIT 3: dangling parentWorkspaceId cleared when parent is absent, and
      // idle rows with runtime: null & no activity/note are skipped.
      const childOnly = railProj.enrichRemoteWorkspaces({
        workspaces: [workspaces[0], workspaces[1]],
        baseInfos: [baseInfos[1]],
        agentStates: [{ workspaceId: "ws-wt-open", tabId: "t9", paneId: "p9", runtime: null, state: "idle" }],
        budgetBytes: 384 * 1024,
      });
      check(
        "enrichRemoteWorkspaces strips dangling parentWorkspaceId and skips runtime-less agentStates rows",
        childOnly.length === 1 && childOnly[0].parentWorkspaceId === undefined && childOnly[0].agentStatus === undefined,
        childOnly,
      );
    }

    // 2. sessions.search param validation & hit sanitization
    {
      const validDefault = sessionRemote.parseRemoteSessionSearchParams({});
      const validFull = sessionRemote.parseRemoteSessionSearchParams({
        query: "mobile rail", scope: "project", workspaceId: "ws-1",
        agents: ["claude", "antigravity", "claude"], limit: 50, offset: 10,
      });
      const invalidCases = [
        null, [], { unknownKey: 1 }, { query: "a".repeat(513) }, { scope: "global" },
        { scope: "workspace" }, { scope: "project" }, { workspaceId: "" }, { workspaceId: "ws-\u0000bad" },
        { agents: ["bash"] }, { agents: ["claude", "codex", "grok", "pi", "antigravity", "cora", "claude"] },
        { limit: 0 }, { limit: 51 }, { limit: 1.5 }, { offset: -1 }, { offset: 501 },
      ];
      check(
        "parseRemoteSessionSearchParams accepts valid requests, dedupes agents, and rejects malformed or extra keys",
        validDefault?.scope === "all" &&
          validDefault?.limit === 30 &&
          validDefault?.offset === 0 &&
          validFull?.scope === "project" &&
          JSON.stringify(validFull?.agents) === JSON.stringify(["claude", "antigravity"]) &&
          invalidCases.every((bad) => sessionRemote.parseRemoteSessionSearchParams(bad) === null),
        { validDefault, validFull },
      );

      check(
        "safeCwdBasename rejects SSH paths and URL schemes",
        sessionRemote.safeCwdBasename("ssh://prod/srv/app") === undefined &&
          sessionRemote.safeCwdBasename("file:///Users/alice/.ssh") === undefined &&
          sessionRemote.safeCwdBasename("https://example.com/repo") === undefined &&
          sessionRemote.safeCwdBasename("/Users/alice/dev/codara-studio") === "codara-studio",
      );

      const projected = sessionRemote.projectRemoteSessionSearchResult(
        {
          hits: [
            makeSearchHit({
              agent: "claude", sessionId: "sess-1", title: "Fix\u0007 auth\nflow", originalTitle: "Fix\u0007 auth\nflow",
              pinned: true, branch: "feat/auth", snippet: `Check \u0001token\u0002 validation ${"z".repeat(300)}`,
              snippetRole: "assistant", model: "claude-opus", messageCount: 14, startedAt: 1700000000000,
            }),
            makeSearchHit({
              agent: "antigravity", sessionId: "conv-unbound", title: "Unbound chat",
              snippet: "General question", snippetRole: "user", cwd: null,
              messageCount: 3, lastAt: 1700000600000,
            }),
            makeSearchHit({
              agent: "antigravity", sessionId: "conv-outside", title: "Outside project chat",
              snippet: "Discussed secret path", snippetRole: "user", cwd: "/Users/alice/private/secret-folder",
              messageCount: 3, lastAt: 1700000600000,
            }),
            makeSearchHit({
              agent: "claude", sessionId: "sess-ssh", title: "Remote SSH session",
              cwd: "ssh://box/srv/app", workspaceId: "ws-ssh", messageCount: 2,
            }),
            makeSearchHit({
              agent: "cora", sessionId: "cora-ssh", title: "Remote Cora run",
              cwd: null, workspaceId: "ws-ssh", messageCount: 2,
            }),
            makeSearchHit({ agent: "antigravity", sessionId: "continue", title: "Synthetic continue pointer" }),
            makeSearchHit({ agent: "claude", sessionId: "bad;id", title: "Unsafe id" }),
          ],
          hasMore: false,
          tookMs: 12,
          status: makeSearchStatus(),
        },
        [
          { id: "ws-studio", name: "Codara Studio", cwd: "/Users/alice/dev/codara-studio" },
          { id: "ws-ssh", name: "Remote", cwd: "ssh://box/srv/app" },
        ],
        384 * 1024,
        "darwin",
      );

      const serialized = JSON.stringify(projected);
      check(
        "projectRemoteSessionSearchResult excludes non-workspace/SSH hits, keeps unbound antigravity, and redacts host paths",
        projected.hits.length === 2 &&
          projected.hits[0].workspaceId === "ws-studio" &&
          projected.hits[0].workspaceName === "Codara Studio" &&
          projected.hits[0].cwdLabel === "codara-studio" &&
          projected.hits[0].title === "Fix auth flow" &&
          projected.hits[0].snippet.startsWith("Check token validation ") &&
          projected.hits[0].snippet.length <= 240 &&
          !projected.hits[0].snippet.includes("\u0001") &&
          !projected.hits[0].snippet.includes("\u0002") &&
          projected.hits[1].sessionId === "conv-unbound" &&
          projected.hits[1].workspaceId === undefined &&
          projected.hits[1].cwdLabel === undefined &&
          !serialized.includes("/Users/alice") &&
          !serialized.includes("secret-folder") &&
          !serialized.includes("ws-ssh") &&
          projected.totalIndexed === 42 &&
          projected.enabled === true &&
          projected.indexing === false,
        projected,
      );

      const tinyBudget = sessionRemote.projectRemoteSessionSearchResult(
        {
          hits: Array.from({ length: 10 }, (_, idx) =>
            makeSearchHit({
              agent: "codex", sessionId: `sess-${idx}`, title: `Session ${idx} ${"a".repeat(80)}`,
              snippet: "b".repeat(120), snippetRole: "user", messageCount: 2, lastAt: 1700000000000 + idx,
            }),
          ),
          hasMore: false,
          tookMs: 5,
          status: makeSearchStatus({ phase: "indexing", sessions: 10 }),
        },
        [{ id: "ws-studio", name: "Codara Studio", cwd: "/Users/alice/dev/codara-studio" }],
        1200,
        "darwin",
      );
      check(
        "projectRemoteSessionSearchResult strictly respects wire byte budget and marks hasMore=true",
        tinyBudget.hits.length > 0 &&
          tinyBudget.hits.length < 10 &&
          tinyBudget.hasMore === true &&
          tinyBudget.indexing === true &&
          Buffer.byteLength(JSON.stringify(tinyBudget), "utf8") <= 1200,
        { count: tinyBudget.hits.length, bytes: Buffer.byteLength(JSON.stringify(tinyBudget), "utf8") },
      );
    }

    // 3. 5-agent resume session ownership verification (strict workspace & account scope)
    {
      const diskByRuntime = {
        claude: [{ sessionId: "claude-local-1" }],
        codex: [{ sessionId: "codex-local-1" }],
        grok: [{ sessionId: "grok-local-1" }],
      };
      const indexedByKey = new Map([
        ["claude:claude-other-account", { agent: "claude", sessionId: "claude-other-account", cwd: "/work/studio" }],
        ["claude:claude-other-ws", { agent: "claude", sessionId: "claude-other-ws", cwd: "/work/worktrees/feat" }],
        ["codex:codex-sub", { agent: "codex", sessionId: "codex-sub", cwd: "/work/studio/packages/a" }],
        ["codex:codex-other-ws", { agent: "codex", sessionId: "codex-other-ws", cwd: "/work/worktrees/feat" }],
        ["codex:codex-outside", { agent: "codex", sessionId: "codex-outside", cwd: "/etc/secret" }],
        ["grok:grok-exact", { agent: "grok", sessionId: "grok-exact", cwd: "/work/studio" }],
        ["grok:grok-sub", { agent: "grok", sessionId: "grok-sub", cwd: "/work/studio/sub" }],
        ["grok:grok-other-ws", { agent: "grok", sessionId: "grok-other-ws", cwd: "/work/worktrees/feat" }],
        ["pi:pi-exact", { agent: "pi", sessionId: "pi-exact", cwd: "/work/studio" }],
        ["pi:pi-sub", { agent: "pi", sessionId: "pi-sub", cwd: "/work/studio/sub" }],
        ["pi:pi-other-ws", { agent: "pi", sessionId: "pi-other-ws", cwd: "/work/worktrees/feat" }],
        ["antigravity:agy-conv-1", { agent: "antigravity", sessionId: "agy-conv-1", cwd: "/work/studio/sub" }],
        ["antigravity:agy-unbound", { agent: "antigravity", sessionId: "agy-unbound", cwd: null }],
        ["antigravity:agy-other-ws", { agent: "antigravity", sessionId: "agy-other-ws", cwd: "/work/worktrees/feat" }],
      ]);
      const verify = (profile, resumeSessionId) =>
        sessionRemote.verifyRemoteResumeSession({
          profile,
          resumeSessionId,
          cwd: "/work/studio",
          workspaceRoot: "/work/studio",
          claudeStateDir: "/home/u/.claude-work",
          listWorkerSessions: async (runtime) => diskByRuntime[runtime] ?? [],
          findPiSessionFile: async (_cwd, id) => (id === "pi-disk-1" ? "/home/u/.pi/session.jsonl" : null),
          lookupIndexedSession: async (agent, id) => indexedByKey.get(`${agent}:${id}`) ?? null,
          platform: "linux",
        });

      const okCases = await Promise.all([
        verify("claude", "claude-local-1"),
        verify("codex", "codex-local-1"),
        verify("codex", "codex-sub"),
        verify("grok", "grok-local-1"),
        verify("grok", "grok-exact"),
        verify("pi", "pi-disk-1"),
        verify("pi", "pi-exact"),
        verify("antigravity", "agy-conv-1"),
        verify("antigravity", "agy-unbound"),
      ]);
      const badCases = await Promise.all([
        verify("claude", "claude-other-account"),
        verify("claude", "claude-other-ws"),
        verify("codex", "codex-other-ws"),
        verify("codex", "codex-outside"),
        verify("grok", "grok-sub"),
        verify("grok", "grok-other-ws"),
        verify("pi", "pi-sub"),
        verify("pi", "pi-other-ws"),
        verify("antigravity", "agy-other-ws"),
        verify("antigravity", "continue"),
        verify("claude", "pi-exact"),
        verify("pi", "nonexistent-session"),
        verify("shell", "claude-local-1"),
        verify("claude", "abc; touch /tmp/pwn"),
      ]);

      check(
        "verifyRemoteResumeSession accepts verified workspace-scoped sessions across all 5 agent runtimes",
        okCases.every((v) => typeof v === "string" && v.length > 0),
        okCases,
      );
      check(
        "verifyRemoteResumeSession rejects cross-workspace, cross-account Claude, wrong agent, synthetic continue, and injection shapes",
        badCases.every((v) => v === null),
        badCases,
      );
    }

    // 4. sessions.search RPC dispatch, error redaction, and per-device rate limiting
    {
      let nextId = 1;
      const callOn = async (stream, method, params) => {
        const id = nextId++;
        stream.inject(rpc.encodeFrame({ id, method, params }));
        for (let i = 0; i < 6; i += 1) await flush();
        return stream.outbox.find((frame) => frame.id === id);
      };

      const errStream = makeFakeStream(rpc, 49);
      void new rpc.RpcSession(errStream, {
        device: { publicKey: "pk", name: "Studio", role: "computer", version: "0.0.0" },
        listWorkspaces: async () => [],
        searchSessions: async (input) => {
          if (input.workspaceId === "missing-ws") throw new Error("Unknown workspace: missing-ws");
          throw new Error("SQLITE_ERROR: /Users/alice/.codara/search.db corrupted");
        },
        createTerminal: async () => { throw new Error("not used"); },
      });
      await callOn(errStream, "hello", {
        protocol: rpc.RPC_PROTOCOL_VERSION,
        device: { publicKey: "phone", name: "Phone", role: "phone", version: "1" },
      });
      const unknownWsErr = await callOn(errStream, "sessions.search", { scope: "workspace", workspaceId: "missing-ws" });
      const redactedErr = await callOn(errStream, "sessions.search", { query: "boom" });
      check(
        "sessions.search maps Unknown workspace and redacts unexpected internal errors",
        unknownWsErr?.error?.code === "unknown-workspace" &&
          redactedErr?.error?.code === "internal" &&
          redactedErr.error.message === "Could not search sessions." &&
          !redactedErr.error.message.includes("SQLITE"),
        { unknownWsErr, redactedErr },
      );

      let clock = Date.parse("2026-11-23T15:00:00.000Z");
      let searchCalls = 0;
      const service = new remoteAccess.RemoteAccessService({
        remoteDir: path.join(tmpRoot, "remote"),
        deviceName: "Session Search Rate Test",
        appVersion: "test",
        now: () => clock,
        listWorkspaces: async () => [],
        searchSessions: async (input) => {
          searchCalls += 1;
          return { hits: [], hasMore: false, tookMs: 1, enabled: true, indexing: false, totalIndexed: input.limit ?? 30 };
        },
        createTerminal: async () => { throw new Error("not used"); },
        log: () => {},
      });
      const connectDevice = async (keyByte) => {
        const stream = makeFakeStream(rpc, keyByte);
        service.onAuthorizedStream(stream);
        await callOn(stream, "hello", {
          protocol: rpc.RPC_PROTOCOL_VERSION,
          device: { publicKey: "claimed", name: "Phone", role: "phone", version: "1" },
        });
        return stream;
      };

      try {
        const phoneA = await connectDevice(41);
        const burst = [];
        for (let i = 0; i < remoteAccess.SESSION_SEARCH_BURST; i += 1) {
          burst.push(await callOn(phoneA, "sessions.search", { query: "test", scope: "all" }));
        }
        const limited = await callOn(phoneA, "sessions.search", { query: "over" });
        const reconnectedA = await connectDevice(41);
        const stillLimited = await callOn(reconnectedA, "sessions.search", { query: "reconnect" });
        const phoneB = await connectDevice(42);
        const otherPhoneOk = await callOn(phoneB, "sessions.search", { query: "other" });
        const badParams = await callOn(phoneB, "sessions.search", { scope: "workspace" });
        clock += remoteAccess.SESSION_SEARCH_REFILL_MS;
        const refilled = await callOn(reconnectedA, "sessions.search", { query: "refilled" });

        await callOn(reconnectedA, "sessions.search", { query: "drain-again" });
        await service.revokeDevice(Buffer.alloc(32, 41).toString("base64"));
        const freshA = await connectDevice(41);
        const afterRevoke = await callOn(freshA, "sessions.search", { query: "fresh" });

        check(
          "sessions.search enforces device-scoped burst/refill rate limiting across reconnects and clears bucket on revokeDevice",
          burst.every((r) => r?.ok === true) &&
            limited?.error?.code === "rate-limited" &&
            stillLimited?.error?.code === "rate-limited" &&
            otherPhoneOk?.ok === true &&
            badParams?.error?.code === "invalid-params" &&
            refilled?.ok === true &&
            afterRevoke?.ok === true &&
            searchCalls === remoteAccess.SESSION_SEARCH_BURST + 3,
          { searchCalls, expected: remoteAccess.SESSION_SEARCH_BURST + 3, limited: limited?.error, afterRevoke: afterRevoke?.ok },
        );
      } finally {
        await service.setEnabled(false).catch(() => undefined);
      }
    }

    // 5. Renderer & production wiring source guards
    {
      const previewRpcSource = fs.readFileSync(path.join(ROOT, "src", "renderer", "src", "components", "Preview", "previewRpc.ts"), "utf8");
      const productionSource = fs.readFileSync(path.join(ROOT, "src", "main", "remote-access", "production.ts"), "utf8");
      const appSource = fs.readFileSync(path.join(ROOT, "src", "renderer", "src", "App.tsx"), "utf8");
      check(
        "previewRpc honors fresh: true and closeDesktopTab uses single-pane closePane with workspace & shareability checks",
        previewRpcSource.includes("const fresh = params.fresh === true;") &&
          previewRpcSource.includes("fresh ? { fresh: true } : undefined") &&
          productionSource.includes("closeDesktopTab:") &&
          productionSource.includes("await requireLocalWorkspace(workspaceId);") &&
          productionSource.includes('"closePane"') &&
          !productionSource.includes('{ action: "close", workspaceId, tabIds: [desktopTabId] }') &&
          appSource.includes("setCloseShareableTerminalPaneFn(") &&
          appSource.includes("tabs.closeTerminalPaneInWorkspace(workspaceId, tab.id, paneId)"),
      );
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(bundleDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
