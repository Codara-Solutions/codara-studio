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

  // The claude/codex CLI-flag helpers (claudeDisallowedTools, codexAccessFlags,
  // codexFastModeArgs) were deleted with the legacy CLI worker harness in
  // 2026-08; the Pi worker fence in resources/pi-cora/worker-policy.ts owns
  // tool access now.
  {
    ok("claudeDisallowedTools is gone", typeof wa.claudeDisallowedTools === "undefined");
    ok("codexAccessFlags is gone", typeof wa.codexAccessFlags === "undefined");
    ok("codexFastModeArgs is gone", typeof wa.codexFastModeArgs === "undefined");
  }

  // ── 4) wave decoration: default is a no-op ─────────────────────────────────
  {
    const self = { nodeId: "a", label: "A", model: "claude-opus-5", prompt: "do A" };
    const peer = { nodeId: "b", label: "B", model: "gpt-5.6-sol", prompt: "do B" };
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
    const self = { nodeId: "a", label: "Alpha", model: "claude-opus-5", prompt: "build the API" };
    const peers = [
      { nodeId: "b", label: "Beta", model: "gpt-5.6-sol", prompt: "b".repeat(150) },
      { nodeId: "c", model: "claude-opus-5", prompt: "write docs" },
    ];
    const out = wa.decorateWavePrompt("build the API", {
      self,
      peers,
      collab: { awareness: true },
      runDir: "/r",
    });
    ok("awareness block prepended", out.startsWith("You are one of 3 workers running in parallel"));
    ok("awareness lists peer Beta with its model", out.includes("- Beta (gpt-5.6-sol):"));
    ok("awareness falls back to nodeId when a peer has no label", out.includes("- c (claude-opus-5): write docs"));
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
    const self = { nodeId: "a", label: "Alpha", model: "claude-opus-5", prompt: "p", collab: { chat: true } };
    const chatPeer = { nodeId: "b", label: "Beta", model: "gpt-5.6-sol", prompt: "p", collab: { chat: true } };
    const silentPeer = { nodeId: "c", label: "Gamma", model: "claude-opus-5", prompt: "p" };

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
    // workerCanPost: every Pi worker can post unless Write is blocked.
    ok("full canPost", wa.workerCanPost({}) === true);
    ok(
      "readonly canPost (Write still allowed)",
      wa.workerCanPost({ access: "readonly" }) === true,
    );
    ok(
      "Write blocked CANNOT post",
      wa.workerCanPost({ blockedTools: ["Write"] }) === false,
    );
    ok("edits canPost", wa.workerCanPost({ access: "edits" }) === true);

    // A claude self that blocked Write: chat block gives the read-only caveat.
    const blockedSelf = { nodeId: "a", label: "Alpha", model: "claude-opus-5", prompt: "p", collab: { chat: true }, blockedTools: ["Write"] };
    const chatPeer = { nodeId: "b", label: "Beta", model: "gpt-5.6-sol", prompt: "p", collab: { chat: true } };
    const blockedOut = wa.decorateWavePrompt("p", {
      self: blockedSelf,
      peers: [chatPeer],
      collab: { chat: true },
      runDir: "/runs/r1",
    });
    ok("Write-blocked self still lists peer board files to read", blockedOut.includes(path.join("/runs/r1", "mail", "b.md")));
    ok("Write-blocked self states it cannot post", blockedOut.includes("You cannot post (Write is blocked"));
    ok("Write-blocked self does NOT tell it to append notes", !blockedOut.includes("append your notes"));

    // A readonly self (Write NOT blocked) CAN post.
    const roSelf = { nodeId: "a", label: "Alpha", model: "claude-opus-5", prompt: "p", collab: { chat: true }, access: "readonly" };
    const roOut = wa.decorateWavePrompt("p", {
      self: roSelf,
      peers: [chatPeer],
      collab: { chat: true },
      runDir: "/runs/r1",
    });
    ok("readonly (Write-allowed) self CAN post", roOut.includes("append your notes"));

    // A peer that blocked Write is a reader — omitted from the "post to" list.
    const readerPeer = { nodeId: "c", label: "Gamma", model: "claude-opus-5", prompt: "p", collab: { chat: true }, blockedTools: ["Write"] };
    const filteredOut = wa.decorateWavePrompt("p", {
      self: { nodeId: "a", label: "Alpha", model: "claude-opus-5", prompt: "p", collab: { chat: true } },
      peers: [chatPeer, readerPeer],
      collab: { chat: true },
      runDir: "/runs/r1",
    });
    ok("posting peer b.md listed", filteredOut.includes(path.join("/runs/r1", "mail", "b.md")));
    ok("read-only peer c.md omitted from post-to list", !filteredOut.includes(path.join("/runs/r1", "mail", "c.md")));
  }

  // ── 8) awareness + chat compose: awareness first, prompt, then chat ─────────
  {
    const self = { nodeId: "a", label: "Alpha", model: "claude-opus-5", prompt: "PROMPT", collab: { awareness: true, chat: true } };
    const peer = { nodeId: "b", label: "Beta", model: "gpt-5.6-sol", prompt: "p", collab: { awareness: true, chat: true } };
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
    ok("empty node accepted", V({}, "w") === null);
    ok("access full accepted", V({ access: "full" }, "w") === null);
    ok("access edits accepted", V({ access: "edits" }, "w") === null);
    ok("access readonly accepted (any model; Pi enforces the fence)", V({ access: "readonly" }, "w") === null);
    ok("bad access rejected", typeof V({ access: "write" }, "w") === "string");
    ok("blockedTools accepted for any worker", V({ blockedTools: ["Bash"] }, "w") === null);
    ok("blockedTools non-array rejected", typeof V({ blockedTools: "Bash" }, "w") === "string");
    ok("blockedTools with a blank entry rejected", typeof V({ blockedTools: [""] }, "w") === "string");
    ok(
      "blockedTools scoped form 'Bash(rm *)' rejected (only bare names are honored)",
      /bare tool name/.test(V({ blockedTools: ["Bash(rm *)"] }, "w") || ""),
    );
    ok("blockedTools bare name 'WebSearch' accepted", V({ blockedTools: ["WebSearch"] }, "w") === null);
    ok(
      "blockedTools entry starting with '-' rejected (never a valid identifier)",
      typeof V({ blockedTools: ["--dangerously"] }, "w") === "string",
    );
    ok("collab object accepted", V({ collab: { awareness: true, chat: false } }, "w") === null);
    ok("collab non-object rejected", typeof V({ collab: true }, "w") === "string");
    ok("collab.chat non-boolean rejected", typeof V({ collab: { chat: "yes" } }, "w") === "string");
  }

  console.log(`\nAll ${passed} worker-access checks PASSED.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
