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
  computerId: "studio-public-key",
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

  {
    const assert = require('node:assert/strict');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'github-phone-notify-'));
    try {
      const store = new phoneNotify.PhoneNotificationStore(dir);
      const prefs = { needsAnswer: true, completed: true, automations: true };
      const registration = { enabled: true, prefs, updatedAt: NOTIFICATION.createdAt };
      await store.set('old-phone', registration);
      await store.set('new-phone', { ...registration, prefs: { ...prefs, github: true } });
      const git = { ...NOTIFICATION, id: 'git-1', kind: 'github', sourceView: 'queue', runId: undefined, automationId: undefined };
      await store.record('old-phone', git);
      await store.record('new-phone', git);
      assert.equal((await store.listHistory('old-phone')).length, 0);
      assert.equal((await new phoneNotify.PhoneNotificationStore(dir).listHistory('new-phone'))[0].sourceView, 'queue');
      assert.equal(phoneNotify.phoneNotificationKindAllowed('github', { ...prefs, github: false }), false);
      assert.equal(phoneNotify.phoneNotificationKindAllowed('completed', { ...prefs, github: false }), true);
      let payload;
      await phoneNotify.sendExpoPushMessages([{ devicePublicKey: 'new-phone', token: 'test-token' }], git, async (_url, options) => {
        payload = JSON.parse(options.body)[0];
        return jsonResponse({ data: [{ status: 'ok', id: 'ticket' }] });
      });
      assert.equal(payload.title, 'GitHub activity');
      assert.equal(payload.data.sourceView, 'queue');
      assert.equal(payload.data.computerId, NOTIFICATION.computerId);
      assert.equal(JSON.stringify(payload).includes(NOTIFICATION.body), false);
      assert.equal(JSON.stringify(payload).includes(NOTIFICATION.workspaceName), false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

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

  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phone-history-"));
    try {
      const store = new phoneNotify.PhoneNotificationStore(dir);
      const recent = { ...NOTIFICATION, id: "recent", terminalPaneId: "pane-right", createdAt: "2026-09-09T12:00:00Z" };
      await Promise.all([
        store.record("keyA", recent),
        store.record("keyB", NOTIFICATION),
        store.record("keyA", NOTIFICATION),
      ]);
      await store.record("keyA", recent);
      const reread = new phoneNotify.PhoneNotificationStore(dir);
      check("phone history survives concurrent first arrivals and restart in event order",
        (await reread.listHistory("keyA")).map((entry) => entry.id).join(",") === "recent,evt-1");
      check("phone history retains the exact terminal pane across restart",
        (await reread.listHistory("keyA"))[0].terminalPaneId === "pane-right");
      check("phone history is isolated by paired device",
        (await reread.listHistory("keyB")).map((entry) => entry.id).join(",") === "evt-1" &&
        (await reread.listHistory("unknown")).length === 0);
      await store.set("muted", { enabled: false, prefs: { needsAnswer: true, completed: true, automations: true }, updatedAt: recent.createdAt });
      await store.set("filtered", { enabled: true, prefs: { needsAnswer: false, completed: true, automations: true }, updatedAt: recent.createdAt });
      await store.record("muted", recent);
      await store.record("filtered", recent);
      check("notification history respects disabled alerts at delivery time",
        (await store.listHistory("muted")).length === 0 && (await store.listHistory("filtered")).length === 0);
      await Promise.all(Array.from({ length: 205 }, (_, index) => store.record("keyA", {
        ...NOTIFICATION, id: `bounded-${index}`, createdAt: new Date(Date.UTC(2026, 8, 1) + index * 1000).toISOString(),
      })));
      const bounded = await store.listHistory("keyA");
      check("history caps after ordering without evicting the newest event", bounded.length === 200 && bounded[0].id === "recent");
      await store.remove("keyA");
      check("removing phone notification data clears its retained history", (await new phoneNotify.PhoneNotificationStore(dir).listHistory("keyA")).length === 0);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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

    await phoneNotify.sendExpoPushMessages([{ devicePublicKey: "keyA", token: "token" }], { ...NOTIFICATION, terminalPaneId: "pane-right" }, fetchImpl);
    const terminalMessage = calls[1].body[0];
    check("terminal push preserves exact pane routing with generic terminal copy",
      terminalMessage.data.terminalPaneId === "pane-right" && terminalMessage.title === "Terminal needs you" &&
      !JSON.stringify(terminalMessage).includes(NOTIFICATION.body), terminalMessage);
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
      message.data.id === "evt-1" &&
        message.data.createdAt === NOTIFICATION.createdAt &&
        message.data.computerId === "studio-public-key" &&
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
      registerNotifications: async (input) => { services.registration = input; },
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

    for (const github of [undefined, true, false, 'invalid']) {
      stream.inject(rpc.encodeFrame({ id: 10, method: 'notifications.register', params: {
        enabled: true, prefs: { needsAnswer: true, completed: true, automations: true, ...(github !== undefined ? { github } : {}) },
      } }));
      await flush();
      check(`GitHub registration validates ${String(github)}`, outbox.at(-1)?.ok === (github !== 'invalid'));
      if (github !== 'invalid') check('GitHub registration preserves advertised support', services.registration.prefs.github === github);
    }

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
