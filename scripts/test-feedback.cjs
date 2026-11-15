// Send feedback's client and store (src/main/feedback/client.ts, store.ts,
// src/shared/feedback.ts) against a local fake that follows the service's
// contract (tests/e2e/fixtures/feedback-service.cjs). Never the real service.
//
// - a report sends exactly the contract's fields: the text trimmed, the
//   version, the platform, the install id, and the contact only when given
// - 400 with a field, 429 with Retry-After, 503, a timeout and no network each
//   come back as one plain sentence, never as a thrown error
// - Studio refuses what the service would refuse before sending anything
// - the base URL is the one constant unless CODARA_FEEDBACK_URL overrides it,
//   and an override must be https or loopback http
// - the install id is a random UUID made once and kept, never derived
//
//   node scripts/test-feedback.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
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

const REPORT = {
  kind: "bug",
  source: "user",
  message: "  Terminal froze after resume\n  ",
  appVersion: "1.4.2-beta.1",
  platform: "linux-x64",
  installId: "3f0c2a8e-7d4b-4c55-9a1e-0b6f2d9c8e71",
};

async function main() {
  const client = await load("src/main/feedback/client.ts");
  const shared = await load("src/shared/feedback.ts");
  const { FeedbackStore } = await load("src/main/feedback/store.ts");

  // The base URL.
  assert.equal(client.FEEDBACK_SERVICE_URL, "https://studio-feedback.codara.cloud");
  assert.equal(client.feedbackServiceUrl({}), client.FEEDBACK_SERVICE_URL);
  assert.equal(client.feedbackServiceUrl({ CODARA_FEEDBACK_URL: "http://127.0.0.1:4100/" }), "http://127.0.0.1:4100");
  assert.equal(client.feedbackServiceUrl({ CODARA_FEEDBACK_URL: "https://feedback.example.test" }), "https://feedback.example.test");
  assert.throws(() => client.feedbackServiceUrl({ CODARA_FEEDBACK_URL: "http://feedback.example.test" }), /https/);

  // The shared rules.
  assert.equal(shared.feedbackMessageProblem("   "), "Write a message first.");
  assert.equal(shared.feedbackMessageProblem("x".repeat(4000)), null);
  assert.match(shared.feedbackMessageProblem("x".repeat(4001)), /4,001 characters/);
  assert.equal(shared.feedbackMessageProblem("😀".repeat(4000)), null, "code points, not UTF-16 units");
  assert.equal(shared.feedbackMessageProblem("line one\nline two\ttab\r\n"), null);
  assert.match(shared.feedbackMessageProblem("bell \u0007"), /control characters/);
  assert.match(shared.feedbackMessageProblem("c1 \u0085"), /control characters/);
  assert.match(shared.feedbackMessageProblem("half \ud83d pair"), /control characters/);
  assert.equal(shared.feedbackContactProblem(""), null);
  assert.equal(shared.feedbackContactProblem(" person@example.com "), null);
  for (const bad of ["person", "a@b", "a@@example.com", "a b@example.com", "<a>@example.com", "a@exämple.com", `${"a".repeat(65)}@example.com`]) {
    assert.ok(shared.feedbackContactProblem(bad), `${bad} is refused`);
  }
  assert.equal(shared.retryAfterText(1500), "in 25 minutes");
  assert.equal(shared.retryAfterText(30), "in 1 minute");

  const service = await startFeedbackService();
  const env = { CODARA_FEEDBACK_URL: service.url };
  try {
    // Success: exactly the contract's fields.
    const sent = await client.sendFeedback(REPORT, { env });
    assert.deepEqual(sent, { ok: true, id: "00000000-0000-4000-8000-000000000001" });
    const request = service.state.requests.at(-1);
    assert.equal(request.method, "POST");
    assert.equal(request.path, "/v1/feedback");
    assert.match(request.headers["content-type"], /^application\/json/);
    assert.deepEqual(JSON.parse(request.body), { ...REPORT, message: "Terminal froze after resume" });
    assert.equal(request.headers.authorization, undefined, "the public route carries no token");

    const withContact = await client.sendFeedback({ ...REPORT, contact: "  person@example.com " }, { env });
    assert.equal(withContact.ok, true);
    assert.equal(JSON.parse(service.state.requests.at(-1).body).contact, "person@example.com");
    await client.sendFeedback({ ...REPORT, contact: "   ", installId: null }, { env });
    const bare = JSON.parse(service.state.requests.at(-1).body);
    assert.ok(!("contact" in bare) && !("installId" in bare), "an empty contact and no install id are left out");

    // Refused before sending: nothing reaches the service.
    const before = service.state.requests.length;
    const empty = await client.sendFeedback({ ...REPORT, message: "  " }, { env });
    assert.deepEqual([empty.ok, empty.error, empty.field], [false, "invalid", "message"]);
    const badEmail = await client.sendFeedback({ ...REPORT, contact: "not an email" }, { env });
    assert.deepEqual([badEmail.ok, badEmail.error, badEmail.field], [false, "invalid", "contact"]);
    assert.equal(service.state.requests.length, before);

    // 400 with a field, as the service says it.
    const badVersion = await client.sendFeedback({ ...REPORT, appVersion: "-dev" }, { env });
    assert.deepEqual([badVersion.ok, badVersion.error, badVersion.field], [false, "invalid", "appVersion"]);
    assert.match(badVersion.message, /does not accept \(appVersion\)\. Update Studio/);
    const badKind = client.feedbackFailure({ status: 400, body: { error: "invalid_field", field: "kind" } });
    assert.equal(badKind.message, "The kind must be Bug, Idea or Other.");
    // A field the contract does not name never reaches past the sentences.
    for (const field of ["__proto__", "constructor", "toString", "a b <x>", 7]) {
      const odd = client.feedbackFailure({ status: 400, body: { error: "invalid_field", field } });
      assert.equal(typeof odd.message, "string", String(field));
      assert.match(odd.message, /does not accept/);
    }
    assert.equal(client.feedbackFailure({ status: 400, body: { field: "a b <x>" } }).field, undefined);
    const tooLarge = client.feedbackFailure({ status: 413, body: { error: "payload_too_large", maxBytes: 32768 } });
    assert.equal(tooLarge.error, "invalid");

    // 429 with Retry-After.
    service.state.next.push("rate_limited");
    const limited = await client.sendFeedback(REPORT, { env });
    assert.deepEqual(
      { ok: limited.ok, error: limited.error, retryAfterSeconds: limited.retryAfterSeconds },
      { ok: false, error: "rate_limited", retryAfterSeconds: 1500 },
    );
    assert.equal(limited.message, "Too many reports were sent from here. Try again in 25 minutes.");

    // 503.
    service.state.next.push("unavailable");
    const down = await client.sendFeedback(REPORT, { env });
    assert.deepEqual([down.ok, down.error], [false, "unavailable"]);
    assert.match(down.message, /not available right now/);

    // A timeout: the service takes the request and never answers.
    service.state.next.push("hang");
    const slow = await client.sendFeedback(REPORT, { env, timeoutMs: 150 });
    assert.deepEqual([slow.ok, slow.error], [false, "timeout"]);
    assert.match(slow.message, /did not answer within 10 seconds/);
    assert.equal(client.FEEDBACK_TIMEOUT_MS, 10_000);
  } finally {
    await service.close();
  }

  // No network: nothing listens on the port any more.
  const offline = await client.sendFeedback(REPORT, { env });
  assert.deepEqual([offline.ok, offline.error], [false, "offline"]);
  assert.match(offline.message, /Could not reach the feedback service/);

  // The install id: made once, kept, random.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-store-"));
  try {
    const file = path.join(dir, "feedback.json");
    const writes = [];
    const deps = { file, write: async (target, text) => (writes.push(text), fs.writeFileSync(target, text)) };
    const store = new FeedbackStore(deps);
    const [first, again] = await Promise.all([store.installId(), store.installId()]);
    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(again, first, "two reports at once share one id");
    assert.equal(writes.length, 1);
    assert.equal(await new FeedbackStore(deps).installId(), first, "kept across restarts");
    const otherFile = path.join(dir, "other.json");
    assert.notEqual(await new FeedbackStore({ ...deps, file: otherFile }).installId(), first, "never derived from the machine");
    fs.writeFileSync(file, JSON.stringify({ installId: "bad id!" }));
    assert.notEqual(await new FeedbackStore(deps).installId(), "bad id!", "a damaged id is replaced");
    const failing = new FeedbackStore({ file: path.join(dir, "ro.json"), write: async () => { throw new Error("read-only"); } });
    const kept = await failing.installId();
    assert.equal(await failing.installId(), kept, "a refused write still keeps the id for the session");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log("test-feedback: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
