// Pure unit tests for the per-worker tool-access + parallel-wave collaboration
// helpers (src/main/orchestration/worker-access.ts): the claude/codex flag
// mapping that buildLaunchCommandLine consumes, the wave-prompt decoration, and
// the LLM-facing field validation agent-socket.validateGraph delegates to.
// worker-access.ts depends only on node:path, so this bundles it in isolation.
//
//   node scripts/test-worker-access.cjs
//
// Exits non-zero on any failed assertion.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const WORKER_ACCESS_TS = path.join(ROOT, "src", "main", "orchestration", "worker-access.ts");

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spark-wa-"));
  const outfile = path.join(tmp, "worker-access.bundle.cjs");
  await esbuild.build({
    entryPoints: [WORKER_ACCESS_TS],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    resolveExtensions: [".ts", ".js", ".cjs", ".mjs", ".json"],
  });
  const wa = require(outfile);

  let passed = 0;
  const ok = (name, cond) => {
    if (!cond) throw new Error(`FAIL: ${name}`);
    passed += 1;
    console.log(`  PASS ${name}`);
  };
  const eq = (name, a, b) => ok(`${name} (got ${JSON.stringify(a)})`, JSON.stringify(a) === JSON.stringify(b));

  // ── 1) claudeDisallowedTools: preset → hard-deny list ──────────────────────
  {
    eq("full preset disallows nothing", wa.claudeDisallowedTools("full"), []);
    eq("absent access disallows nothing", wa.claudeDisallowedTools(undefined), []);
    eq("edits removes shell + web", wa.claudeDisallowedTools("edits"), ["Bash", "WebSearch", "WebFetch"]);
    eq(
      "readonly removes edits-to-existing + shell + web but KEEPS Write (for its report)",
      wa.claudeDisallowedTools("readonly"),
      ["Edit", "MultiEdit", "NotebookEdit", "Bash", "WebSearch", "WebFetch"],
    );
    ok("readonly does NOT deny Write", !wa.claudeDisallowedTools("readonly").includes("Write"));
  }

  // ── 2) blockedTools merge/dedupe onto ANY preset (incl. full) ──────────────
  {
    eq(
      "blockedTools merge onto full",
      wa.claudeDisallowedTools("full", ["WebSearch", "Bash"]),
      ["WebSearch", "Bash"],
    );
    eq(
      "blockedTools dedupe against the edits preset",
      wa.claudeDisallowedTools("edits", ["Bash", "Grep"]),
      ["Bash", "WebSearch", "WebFetch", "Grep"],
    );
    eq(
      "blockedTools are trimmed and blanks dropped",
      wa.claudeDisallowedTools("full", [" Bash ", "", "  "]),
      ["Bash"],
    );
  }

  // ── 3) codexAccessFlags: sandbox mode + approvals + precedence ─────────────
  {
    eq("codex full (no sandboxDir) → --yolo, no -a", wa.codexAccessFlags("full", false), {
      approvalsNever: false,
    });
    eq("codex full + sandboxDir → workspace-write, no -a (legacy unchanged)", wa.codexAccessFlags("full", true), {
      sandboxMode: "workspace-write",
      approvalsNever: false,
    });
    eq("codex edits → workspace-write + approvals never", wa.codexAccessFlags("edits", false), {
      sandboxMode: "workspace-write",
      approvalsNever: true,
    });
    // codex readonly is IMPOSSIBLE (read-only sandbox can't write the report), so
    // codexAccessFlags treats it as edits (workspace-write) — the launch backstop.
    eq("codex readonly → workspace-write (flipped from the impossible read-only)", wa.codexAccessFlags("readonly", false), {
      sandboxMode: "workspace-write",
      approvalsNever: true,
    });
    eq("codex readonly + sandboxDir → workspace-write (flipped)", wa.codexAccessFlags("readonly", true), {
      sandboxMode: "workspace-write",
      approvalsNever: true,
    });
  }

  // ── 3b) codex --add-dir emission (mirrors buildLaunchCommandLine's codex loop:
  // when a sandbox mode is set, each extra writable dir becomes --add-dir <d>) ──
  {
    const q = (v) => (/^[A-Za-z0-9_./:@+=,-]+$/.test(v) ? v : `'${v.replace(/'/g, "''")}'`);
    // Reconstruct the codex arg assembly the way run-store does, to confirm the
    // report dir + mail dir are made writable on sandboxed launches and NOT on
    // an unsandboxed --yolo launch.
    const codexCmd = (access, sandboxDir, extraWritableDirs) => {
      const c = wa.codexAccessFlags(access, Boolean(sandboxDir));
      const args = c.sandboxMode ? ["codex", "--sandbox", c.sandboxMode] : ["codex", "--yolo"];
      if (c.approvalsNever) args.push("-a", "never");
      if (c.sandboxMode) for (const d of extraWritableDirs) if (d.trim()) args.push("--add-dir", q(d));
      return args.join(" ");
    };
    const REP = "/runs/r1/steps/s/workers/t/attempts/a";
    const MAIL = "/runs/r1/mail";
    ok(
      "codex edits add-dirs the report dir",
      codexCmd("edits", undefined, [REP]).includes(`--add-dir ${REP}`),
    );
    ok(
      "codex edits + chat add-dirs BOTH report and mail dirs",
      codexCmd("edits", undefined, [REP, MAIL]).includes(`--add-dir ${REP}`) &&
        codexCmd("edits", undefined, [REP, MAIL]).includes(`--add-dir ${MAIL}`),
    );
    ok(
      "codex full + legacy sandboxDir ALSO add-dirs the report dir (same report-blocked geometry)",
      codexCmd("full", "/wt/x", [REP]).includes(`--add-dir ${REP}`),
    );
    ok(
      "codex full (unsandboxed --yolo) does NOT add-dir (already has disk access)",
      !codexCmd("full", undefined, [REP]).includes("--add-dir"),
    );
  }

  // ── 4) wave decoration: default is a no-op ─────────────────────────────────
  {
    const self = { nodeId: "a", label: "A", engine: "claude", prompt: "do A" };
    const peer = { nodeId: "b", label: "B", engine: "codex", prompt: "do B" };
    ok(
      "lone worker (no peers) is byte-identical",
      wa.decorateWavePrompt("do A", { self, peers: [], collab: { awareness: true, chat: true }, runDir: "/r" }) === "do A",
    );
    ok(
      "no collab flags = byte-identical even with peers",
      wa.decorateWavePrompt("do A", { self, peers: [peer], runDir: "/r" }) === "do A",
    );
  }

  // ── 5) awareness: only with >=1 peer + toggle on; lists every OTHER node ────
  {
    const self = { nodeId: "a", label: "Alpha", engine: "claude", prompt: "build the API" };
    const peers = [
      { nodeId: "b", label: "Beta", engine: "codex", prompt: "b".repeat(150) },
      { nodeId: "c", engine: "claude", prompt: "write docs" },
    ];
    const out = wa.decorateWavePrompt("build the API", {
      self,
      peers,
      collab: { awareness: true },
      runDir: "/r",
    });
    ok("awareness block prepended", out.startsWith("You are one of 3 workers running in parallel"));
    ok("awareness lists peer Beta with its engine", out.includes("- Beta (codex):"));
    ok("awareness falls back to nodeId when a peer has no label", out.includes("- c (claude): write docs"));
    ok("awareness snippet truncates a long prompt with an ellipsis", out.includes("…"));
    ok("awareness keeps the rendered prompt after the block", out.includes("\n\nbuild the API"));
    ok("awareness does NOT add a chat board", !out.includes("Shared message board"));

    const noPeers = wa.decorateWavePrompt("solo", {
      self,
      peers: [],
      collab: { awareness: true },
      runDir: "/r",
    });
    ok("awareness with a single-worker wave is a no-op", noPeers === "solo");
  }

  // ── 6) chat: needs a peer that ALSO has chat on; lists peer board files ─────
  {
    const self = { nodeId: "a", label: "Alpha", engine: "claude", prompt: "p", collab: { chat: true } };
    const chatPeer = { nodeId: "b", label: "Beta", engine: "codex", prompt: "p", collab: { chat: true } };
    const silentPeer = { nodeId: "c", label: "Gamma", engine: "claude", prompt: "p" };

    ok(
      "waveHasChat false when no OTHER peer has chat on",
      wa.waveHasChat({ chat: true }, [silentPeer]) === false,
    );
    ok(
      "waveHasChat true when a peer also has chat on",
      wa.waveHasChat({ chat: true }, [chatPeer]) === true,
    );

    const out = wa.decorateWavePrompt("p", {
      self,
      peers: [chatPeer, silentPeer],
      collab: { chat: true },
      runDir: "/runs/r1",
    });
    ok("chat block appended", out.includes("Shared message board:"));
    ok("chat names this worker's own board file to post to", out.includes(path.join("/runs/r1", "mail", "a.md")));
    ok("chat lists the chat-enabled peer's board file", out.includes(path.join("/runs/r1", "mail", "b.md") + " (Beta)"));
    ok("chat omits the non-chat peer's board file", !out.includes("c.md"));
    ok("chat tells a full-access worker to append its notes", out.includes("append your notes"));
    ok("chat forbids editing peers' files", out.includes("Do not edit peers' files."));

    // A lone chat-enabled worker (no chat peers) gets no board.
    const solo = wa.decorateWavePrompt("p", {
      self,
      peers: [silentPeer],
      collab: { chat: true },
      runDir: "/runs/r1",
    });
    ok("chat with no chat-peers is a no-op", solo === "p");
  }

  // ── 7) canPost matrix + Write-blocked chat caveat ──────────────────────────
  {
    // workerCanPost: claude can post unless Write is blocked; codex always can.
    ok("claude full canPost", wa.workerCanPost({ engine: "claude" }) === true);
    ok(
      "claude readonly canPost (Write still allowed)",
      wa.workerCanPost({ engine: "claude", access: "readonly" }) === true,
    );
    ok(
      "claude with Write blocked CANNOT post",
      wa.workerCanPost({ engine: "claude", blockedTools: ["Write"] }) === false,
    );
    ok("codex edits canPost", wa.workerCanPost({ engine: "codex", access: "edits" }) === true);
    ok("codex full canPost", wa.workerCanPost({ engine: "codex" }) === true);

    // A claude self that blocked Write: chat block gives the read-only caveat.
    const blockedSelf = { nodeId: "a", label: "Alpha", engine: "claude", prompt: "p", collab: { chat: true }, blockedTools: ["Write"] };
    const chatPeer = { nodeId: "b", label: "Beta", engine: "codex", prompt: "p", collab: { chat: true } };
    const blockedOut = wa.decorateWavePrompt("p", {
      self: blockedSelf,
      peers: [chatPeer],
      collab: { chat: true },
      runDir: "/runs/r1",
    });
    ok("Write-blocked self still lists peer board files to read", blockedOut.includes(path.join("/runs/r1", "mail", "b.md")));
    ok("Write-blocked self states it cannot post", blockedOut.includes("You cannot post (Write is blocked"));
    ok("Write-blocked self does NOT tell it to append notes", !blockedOut.includes("append your notes"));

    // A claude readonly self (Write NOT blocked) CAN post.
    const roSelf = { nodeId: "a", label: "Alpha", engine: "claude", prompt: "p", collab: { chat: true }, access: "readonly" };
    const roOut = wa.decorateWavePrompt("p", {
      self: roSelf,
      peers: [chatPeer],
      collab: { chat: true },
      runDir: "/runs/r1",
    });
    ok("readonly (Write-allowed) claude self CAN post", roOut.includes("append your notes"));

    // A peer that blocked Write is a reader — omitted from the "post to" list.
    const readerPeer = { nodeId: "c", label: "Gamma", engine: "claude", prompt: "p", collab: { chat: true }, blockedTools: ["Write"] };
    const filteredOut = wa.decorateWavePrompt("p", {
      self: { nodeId: "a", label: "Alpha", engine: "claude", prompt: "p", collab: { chat: true } },
      peers: [chatPeer, readerPeer],
      collab: { chat: true },
      runDir: "/runs/r1",
    });
    ok("posting peer b.md listed", filteredOut.includes(path.join("/runs/r1", "mail", "b.md")));
    ok("read-only peer c.md omitted from post-to list", !filteredOut.includes(path.join("/runs/r1", "mail", "c.md")));
  }

  // ── 8) awareness + chat compose: awareness first, prompt, then chat ─────────
  {
    const self = { nodeId: "a", label: "Alpha", engine: "claude", prompt: "PROMPT", collab: { awareness: true, chat: true } };
    const peer = { nodeId: "b", label: "Beta", engine: "codex", prompt: "p", collab: { awareness: true, chat: true } };
    const out = wa.decorateWavePrompt("PROMPT", {
      self,
      peers: [peer],
      collab: { awareness: true, chat: true },
      runDir: "/runs/r1",
    });
    const awarenessAt = out.indexOf("You are one of");
    const promptAt = out.indexOf("PROMPT");
    const chatAt = out.indexOf("Shared message board:");
    ok("order is awareness → prompt → chat", awarenessAt >= 0 && awarenessAt < promptAt && promptAt < chatAt);
  }

  // ── 9) validateWorkerAccessFields: accept + reject ─────────────────────────
  {
    const V = wa.validateWorkerAccessFields;
    ok("empty node accepted", V({}, "claude", "w") === null);
    ok("access full accepted", V({ access: "full" }, "claude", "w") === null);
    ok("access edits accepted", V({ access: "edits" }, "codex", "w") === null);
    ok("access readonly accepted on claude", V({ access: "readonly" }, "claude", "w") === null);
    ok(
      "access readonly REJECTED on codex with an instructive message",
      /read-only sandbox cannot write/.test(V({ access: "readonly" }, "codex", "w") || ""),
    );
    ok("bad access rejected", typeof V({ access: "write" }, "claude", "w") === "string");
    ok("blockedTools on claude accepted", V({ blockedTools: ["Bash"] }, "claude", "w") === null);
    ok(
      "blockedTools on codex rejected with an instructive message",
      /Claude-only/.test(V({ blockedTools: ["Bash"] }, "codex", "w") || ""),
    );
    ok("blockedTools non-array rejected", typeof V({ blockedTools: "Bash" }, "claude", "w") === "string");
    ok("blockedTools with a blank entry rejected", typeof V({ blockedTools: [""] }, "claude", "w") === "string");
    ok(
      "blockedTools scoped form 'Bash(rm *)' rejected (CLI silently ignores it)",
      /bare tool name/.test(V({ blockedTools: ["Bash(rm *)"] }, "claude", "w") || ""),
    );
    ok("blockedTools bare name 'WebSearch' accepted", V({ blockedTools: ["WebSearch"] }, "claude", "w") === null);
    ok(
      "blockedTools entry starting with '-' rejected (would parse as a CLI flag)",
      typeof V({ blockedTools: ["--dangerously"] }, "claude", "w") === "string",
    );
    ok("collab object accepted", V({ collab: { awareness: true, chat: false } }, "claude", "w") === null);
    ok("collab non-object rejected", typeof V({ collab: true }, "claude", "w") === "string");
    ok("collab.chat non-boolean rejected", typeof V({ collab: { chat: "yes" } }, "claude", "w") === "string");
  }

  console.log(`\nAll ${passed} worker-access checks PASSED.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
