// Harness for the phone-notification plumbing in src/main/remote-access/:
// the PhoneNotificationStore first-touch load race, the Expo ticket/receipt
// mapping (a missing ticket is a FAILURE; DeviceNotRegistered — immediate or
// via a receipt — clears the stored token), the generic-copy rule for push
// payloads that leave the E2E channel, and the RpcSession push-liveness rule
// (a proven session only counts as a live notification target while the phone
// has spoken within the liveness window).
//
//   node scripts/test-phone-notify.cjs
//
// No network, no Electron: Expo's API is a fake fetch, the session runs over
// a fake duplex.

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

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
    external: ["sodium-native", "@hyperswarm/secret-stream", "ws"],
  });
  delete require.cache[outfile];
  return require(outfile);
}

let failures = 0;
const check = (name, cond, detail) => {
  if (!cond) {
    failures += 1;
    if (detail !== undefined) console.log(`     got: ${JSON.stringify(detail)}`);
  }
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
};

const NOTIFICATION = {
  id: "evt-1",
  kind: "blocked",
  title: "Automation needs your answer",
  body: "Should I delete the production database?",
  workspaceId: "ws1",
  workspaceName: "Secret Client Project",
  runId: "run-1",
  automationId: "job-1",
  createdAt: "2026-07-29T00:00:00.000Z",
};

function jsonResponse(body, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

async function main() {
  const phoneNotify = await bundle(
    path.join(ROOT, "src", "main", "remote-access", "phone-notify.ts"),
    "phone-notify-test.cjs",
  );
  const rpc = await bundle(
    path.join(ROOT, "src", "main", "remote-access", "rpc.ts"),
    "phone-notify-rpc-test.cjs",
  );

  /* ---------------------------------------------- store first-touch race */
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phone-notify-"));
    fs.writeFileSync(
      path.join(dir, "phone-notifications.json"),
      JSON.stringify({
        devices: {
          keyA: {
            enabled: true,
            prefs: { needsAnswer: true, completed: true, automations: true },
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
    );
    const store = new phoneNotify.PhoneNotificationStore(dir);
    const registration = (name) => ({
      enabled: true,
      prefs: { needsAnswer: true, completed: false, automations: false },
      token: `ExponentPushToken[${name}]`,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    // Both mutations start before the first load resolves. With the parsed
    // RESULT cached instead of the load promise, each set mutates its own
    // private file object and one registration is silently dropped.
    await Promise.all([
      store.set("keyB", registration("b")),
      store.set("keyC", registration("c")),
    ]);
    const keys = (await store.entries()).map(([key]) => key).sort();
    check(
      "concurrent first-touch mutations both land (load promise memoized)",
      keys.join(",") === "keyA,keyB,keyC",
      keys,
    );
    const reread = new phoneNotify.PhoneNotificationStore(dir);
    const persisted = (await reread.entries()).map(([key]) => key).sort();
    check(
      "both registrations survive to disk",
      persisted.join(",") === "keyA,keyB,keyC",
      persisted,
    );
  }

  /* --------------------------------------------------- ticket mapping */
  {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return jsonResponse({
        data: [
          { status: "ok", id: "ticket-1" },
          {
            status: "error",
            message: "gone",
            details: { error: "DeviceNotRegistered" },
          },
          // NO third ticket: Expo answered the batch but dropped this message.
        ],
      });
    };
    const outcomes = await phoneNotify.sendExpoPushMessages(
      [
        { devicePublicKey: "keyA", token: "tokA" },
        { devicePublicKey: "keyB", token: "tokB" },
        { devicePublicKey: "keyC", token: "tokC" },
      ],
      NOTIFICATION,
      fetchImpl,
    );
    check(
      "an ok ticket succeeds and carries its ticket id",
      outcomes[0].ok === true && outcomes[0].ticketId === "ticket-1",
      outcomes[0],
    );
    check(
      "an immediate DeviceNotRegistered ticket is flagged",
      outcomes[1].ok === false && outcomes[1].deviceNotRegistered === true,
      outcomes[1],
    );
    check(
      "a MISSING ticket is a failure, not a success",
      outcomes[2].ok === false && !outcomes[2].deviceNotRegistered,
      outcomes[2],
    );

    const message = calls[0].body[0];
    check(
      "push payloads leaving the E2E channel carry only generic copy",
      message.title === "Needs your answer" &&
        message.body === "A run is waiting on your answer." &&
        message.subtitle === undefined &&
        !JSON.stringify(calls[0].body).includes("Secret Client Project") &&
        !JSON.stringify(calls[0].body).includes("production database"),
      message,
    );
    check(
      "push payloads keep the routing ids in data",
      message.data.workspaceId === "ws1" &&
        message.data.runId === "run-1" &&
        message.data.automationId === "job-1" &&
        message.data.kind === "blocked",
      message.data,
    );
  }

  /* -------------------------------------------------- receipt tracking */
  {
    const tracker = new phoneNotify.ExpoReceiptTracker();
    tracker.add("ticket-1", "keyA", 0);
    tracker.add("ticket-2", "keyB", 0);
    tracker.add("ticket-3", "keyC", 0);

    // First poll: Expo has verdicts for two tickets; the third is not ready.
    const receiptCalls = [];
    const failures1 = await tracker.poll(async (url, init) => {
      receiptCalls.push(JSON.parse(init.body));
      return jsonResponse({
        data: {
          "ticket-1": { status: "ok" },
          "ticket-2": {
            status: "error",
            message: "device gone",
            details: { error: "DeviceNotRegistered" },
          },
        },
      });
    }, 1_000);
    check(
      "receipts are queried as one batched id list",
      receiptCalls.length === 1 &&
        receiptCalls[0].ids.sort().join(",") === "ticket-1,ticket-2,ticket-3",
      receiptCalls[0],
    );
    check(
      "a DeviceNotRegistered receipt maps back to its device",
      failures1.length === 1 &&
        failures1[0].devicePublicKey === "keyB" &&
        failures1[0].deviceNotRegistered === true,
      failures1,
    );
    check(
      "an unanswered ticket stays pending for the next poll",
      tracker.size() === 1,
      tracker.size(),
    );

    // Transport failure: nothing is resolved, nothing is lost.
    const failures2 = await tracker.poll(async () => {
      throw new Error("offline");
    }, 2_000);
    check(
      "a failed receipts request keeps tickets pending",
      failures2.length === 0 && tracker.size() === 1,
      tracker.size(),
    );

    // A day later the unanswered ticket is abandoned rather than retained.
    const failures3 = await tracker.poll(
      async () => jsonResponse({ data: {} }),
      25 * 60 * 60 * 1000,
    );
    check(
      "tickets past the retention window are dropped",
      failures3.length === 0 && tracker.size() === 0,
      tracker.size(),
    );
  }

  /* ------------------------------------- DeviceNotRegistered clears token */
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phone-notify-"));
    const store = new phoneNotify.PhoneNotificationStore(dir);
    await store.set("keyB", {
      enabled: true,
      prefs: { needsAnswer: true, completed: true, automations: true },
      token: "ExponentPushToken[dead]",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await store.clearToken("keyB");
    const record = await store.get("keyB");
    check(
      "clearToken drops the token but keeps the registration",
      record !== undefined && record.token === undefined && record.enabled === true,
      record,
    );
  }

  /* -------------------------------------- production wiring (source pins) */
  // production.ts imports Electron, so it cannot run here; pin the contracts
  // the plumbing above exists for, the way test-remote-access.cjs pins its
  // production wiring.
  {
    const productionSource = fs.readFileSync(
      path.join(ROOT, "src", "main", "remote-access", "production.ts"),
      "utf8",
    );
    check(
      "production polls the receipts endpoint and clears dead tokens there too",
      /async function pollExpoReceipts/.test(productionSource) &&
        /failure\.deviceNotRegistered.*\n?.*clearToken\(failure\.devicePublicKey\)/.test(
          productionSource,
        ) &&
        /setInterval\([\s\S]{0,80}pollExpoReceipts[\s\S]{0,120}EXPO_RECEIPT_POLL_MS/.test(
          productionSource,
        ),
    );
    check(
      "production records accepted tickets for receipt follow-up",
      /expoReceipts\.add\(outcome\.ticketId, outcome\.devicePublicKey\)/.test(
        productionSource,
      ),
    );
    check(
      "a blocked automation iteration notifies as kind 'blocked' (needsAnswer gate)",
      /kind: "blocked",\s*\n\s*title: "Automation needs your answer"/.test(
        productionSource,
      ),
    );
    check(
      "production mirrors the desktop DND and watching suppressions",
      /getPreferenceCached\("notificationsDnd"\) === true\) return null/.test(
        productionSource,
      ) &&
        /isWatchingRun\(runId\)\)\s*\n?\s*return null/.test(
          productionSource,
        ),
    );
  }

  /* --------------------------------------------------- push liveness */
  {
    let nowMs = 100_000;
    const handlers = { data: [], close: [], error: [], drain: [] };
    const outDecoder = new rpc.FrameDecoder();
    const outbox = [];
    const stream = {
      write(buf) {
        for (const frame of outDecoder.push(buf)) outbox.push(frame);
        return true;
      },
      destroy() {
        for (const h of handlers.close) h();
      },
      on(event, handler) {
        handlers[event].push(handler);
      },
      inject(buf) {
        for (const h of handlers.data) h(buf);
      },
    };
    const services = {
      device: { publicKey: "pk", name: "Studio", role: "computer", version: "0.0.0" },
      listWorkspaces: async () => [],
      createTerminal: async () => {
        throw new Error("unused");
      },
    };
    const session = new rpc.RpcSession(stream, services, () => {}, () => nowMs);
    const flush = () => new Promise((resolve) => setImmediate(resolve));

    check(
      "an unproven session is never push-live",
      session.isPushLive(nowMs) === false,
    );

    stream.inject(
      rpc.encodeFrame({
        id: 1,
        method: "hello",
        params: {
          protocol: rpc.RPC_PROTOCOL_VERSION,
          device: { publicKey: "c", name: "Phone", role: "phone", version: "1" },
        },
      }),
    );
    await flush();
    check("hello completes over the fake duplex", outbox[0]?.ok === true, outbox[0]);
    check(
      "a proven session with recent inbound traffic is push-live",
      session.isPushLive(nowMs) === true,
    );

    nowMs += rpc.PUSH_LIVENESS_WINDOW_MS;
    check(
      "exactly at the window edge still counts",
      session.isPushLive(nowMs) === true,
    );
    nowMs += 1;
    check(
      "a proven session that has gone quiet past the window is NOT push-live",
      session.isPushLive(nowMs) === false,
    );

    stream.inject(rpc.encodeFrame({ id: 2, method: "ping", params: { nonce: "n" } }));
    await flush();
    check(
      "any inbound frame (a ping) restores push-liveness",
      session.isPushLive(nowMs) === true,
    );
  }

  if (failures > 0) {
    console.error(`${failures} failure(s)`);
    process.exit(1);
  }
  console.log("all phone-notify checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
