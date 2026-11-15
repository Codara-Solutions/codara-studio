// codara_feedback_send (src/main/feedback/agent.ts) and the questions it
// waits on (src/main/feedback/approvals.ts), against a local fake of the
// feedback service (tests/e2e/fixtures/feedback-service.cjs).
//
// Invariant: an agent's report reaches the service only after the person
// pressed Send on a question showing that exact text, unless the person
// turned the question off. A "no", no answer, a closed window or an agent
// that stopped waiting sends nothing, and a late click acts for nobody.
//
//   node scripts/test-feedback-agent.cjs

const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");
const { startFeedbackService } = require("../tests/e2e/fixtures/feedback-service.cjs");

const ROOT = path.resolve(__dirname, "..");

async function load(entry) {
  const output = await esbuild.build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
    plugins: [
      {
        name: "shared",
        setup(build) {
          build.onResolve({ filter: /^@shared\// }, (args) => ({
            path: path.join(ROOT, "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
          }));
        },
      },
    ],
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", output.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

async function main() {
  const { agentSendFeedback, AgentFeedbackParamsError } = await load("src/main/feedback/agent.ts");
  const { FeedbackAsks } = await load("src/main/feedback/approvals.ts");
  const { sendFeedback } = await load("src/main/feedback/client.ts");

  const service = await startFeedbackService();
  const env = { CODARA_FEEDBACK_URL: service.url };
  const shown = [];
  const closed = [];
  let windowOpen = true;
  const asks = new FeedbackAsks({
    show: (request) => (windowOpen ? (shown.push(request), true) : false),
    close: (payload) => closed.push(payload),
  });
  let askFirst = true;
  const deps = (signal) => ({
    caller: async () => ({ agent: "Claude Code", workspaceName: "web" }),
    askFirst: async () => askFirst,
    ask: (request, abort) => asks.ask(request, { timeoutMs: 2_000, signal: abort }),
    send: (draft) =>
      sendFeedback(
        { ...draft, source: "agent", appVersion: "1.4.2", platform: "linux-x64", installId: "3f0c2a8e-7d4b-4c55-9a1e-0b6f2d9c8e71" },
        { env },
      ),
    signal,
  });
  // Answers the next question as soon as it is shown.
  const answerNext = (value) => {
    const seen = shown.length;
    const timer = setInterval(() => {
      if (shown.length > seen) {
        clearInterval(timer);
        assert.equal(asks.answer(shown.at(-1).id, value), true);
      }
    }, 2);
  };

  try {
    // Yes: the question shows the exact text and who asks; then it is sent.
    answerNext("yes");
    const yes = await agentSendFeedback({ kind: "bug", message: "  The rail flickers.\n" }, deps());
    assert.deepEqual(yes, { sent: true, id: service.state.items[0].id });
    assert.deepEqual(
      { ...shown.at(-1), id: undefined, expiresAt: undefined },
      { action: "send", agent: "Claude Code", workspaceName: "web", kind: "bug", message: "The rail flickers.", id: undefined, expiresAt: undefined },
    );
    const body = JSON.parse(service.state.requests.at(-1).body);
    assert.equal(body.source, "agent");
    assert.equal(body.message, "The rail flickers.");
    assert.ok(!("contact" in body), "an agent never sends a contact");

    // No: nothing reaches the service.
    const before = service.state.requests.length;
    answerNext("no");
    const no = await agentSendFeedback({ kind: "idea", message: "Pin tabs." }, deps());
    assert.deepEqual([no.sent, no.reason], [false, "declined"]);
    assert.equal(service.state.requests.length, before);

    // No answer before the timeout: nothing sent, the card is closed, and a
    // late click is refused.
    const quick = new FeedbackAsks({ show: (request) => (shown.push(request), true), close: (payload) => closed.push(payload) });
    const timedOut = await agentSendFeedback(
      { kind: "other", message: "Hello" },
      { ...deps(), ask: (request) => quick.ask(request, { timeoutMs: 20 }) },
    );
    assert.deepEqual([timedOut.sent, timedOut.reason], [false, "no_answer"]);
    assert.equal(closed.at(-1).reason, "expired");
    assert.equal(quick.answer(shown.at(-1).id, "yes"), false, "a late Send acts for nobody");
    assert.equal(service.state.requests.length, before);

    // The agent stops waiting: the question is withdrawn.
    const controller = new AbortController();
    const pending = agentSendFeedback({ kind: "bug", message: "Gone" }, deps(controller.signal));
    while (asks.list().length === 0) await new Promise((resolve) => setTimeout(resolve, 2));
    const withdrawnId = asks.list()[0].id;
    controller.abort();
    assert.deepEqual([(await pending).sent, (await pending).reason], [false, "no_answer"]);
    assert.deepEqual(closed.at(-1), { id: withdrawnId, reason: "withdrawn" });
    assert.equal(asks.list().length, 0);

    // No window to ask in: nothing sent.
    windowOpen = false;
    const noWindow = await agentSendFeedback({ kind: "bug", message: "Hidden" }, deps());
    assert.deepEqual([noWindow.sent, noWindow.reason], [false, "no_answer"]);
    windowOpen = true;
    assert.equal(service.state.requests.length, before);

    // The setting off: sent without a question.
    askFirst = false;
    const shownBefore = shown.length;
    const direct = await agentSendFeedback({ kind: "idea", message: "Straight through" }, deps());
    assert.equal(direct.sent, true);
    assert.equal(shown.length, shownBefore);
    askFirst = true;

    // Bad input is refused before any question.
    for (const params of [{ kind: "rant", message: "x" }, { kind: "bug" }, { kind: "bug", message: "  " }, { kind: "bug", message: "x".repeat(4001) }, { kind: "bug", message: "nul \u0000" }]) {
      await assert.rejects(agentSendFeedback(params, deps()), AgentFeedbackParamsError);
    }
    assert.equal(shown.length, shownBefore);

    // A failure comes back as a sentence, not a throw.
    askFirst = false;
    service.state.next.push("rate_limited");
    const limited = await agentSendFeedback({ kind: "bug", message: "Again" }, deps());
    assert.deepEqual(limited, { sent: false, reason: "rate_limited", note: "Too many reports were sent from here. Try again in 25 minutes." });
  } finally {
    await service.close();
  }
  console.log("test-feedback-agent: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
