// Harness for src/main/share/ (Share as link, main-process side): the share
// key on disk (modes, reuse, symlink and corrupt-file handling), the local
// list of shared pages, request signing and building, the base URL override,
// response parsing, the ShareService over a fake fetch, and the agent offer
// gate. Everything runs in a throwaway directory; nothing touches the real
// ~/.codarastudio and nothing goes over the network.
//
//   node scripts/test-share-main.cjs
//
// Signatures are checked with node:crypto, and also with the service's own
// verifier (codara-share src/protocol.ts) when that repository is checked
// out next to this one or named by CODARA_SHARE_REPO: the canonical message
// is a hard contract between the two.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

function shareRepo() {
  const candidates = [];
  if (process.env.CODARA_SHARE_REPO) candidates.push(process.env.CODARA_SHARE_REPO);
  candidates.push(path.resolve(ROOT, "..", "codara-share"));
  try {
    // A worktree lives away from the main checkout; its siblings are the
    // main checkout's.
    const common = execFileSync("git", ["-C", ROOT, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    candidates.push(path.resolve(common, "..", "..", "codara-share"));
  } catch {
    /* not a git checkout */
  }
  return candidates.find((dir) => fs.existsSync(path.join(dir, "src", "protocol.ts"))) ?? null;
}

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
    external: ["sodium-native"],
  });
  delete require.cache[outfile];
  return require(outfile);
}

let failures = 0;
let passes = 0;
async function check(name, fn) {
  try {
    await fn();
    passes += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`not ok - ${name}`);
    console.error(error && error.stack ? error.stack : error);
  }
}

function mode(file) {
  return fs.statSync(file).mode & 0o777;
}

function verifyWithNode(headers, method, target, body) {
  const key = Buffer.from(headers["x-codara-key"], "base64");
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key]);
  const publicKey = crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
  const message = [
    "codara-share-auth-v1",
    method,
    target,
    crypto.createHash("sha256").update(body ?? Buffer.alloc(0)).digest("hex"),
    headers["x-codara-timestamp"],
    headers["x-codara-nonce"],
    headers["x-codara-key"],
  ].join("\n");
  return crypto.verify(null, Buffer.from(message, "utf8"), publicKey, Buffer.from(headers["x-codara-signature"], "base64"));
}

function jsonResponse(status, body) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function remotePage(id, extra = {}) {
  return { id, path: `/p/${id}`, size: 1234, createdAt: 1_000, expiresAt: Date.now() + 86_400_000, ...extra };
}

const ID_A = "AAAAAAAAAAAAAAAAAAAAAAAA";
const ID_B = "BBBBBBBBBBBBBBBBBBBBBBBB";

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codara-share-main-"));
  const identity = await bundle(path.join(ROOT, "src", "main", "share", "identity.ts"), "share-identity.cjs");
  const records = await bundle(path.join(ROOT, "src", "main", "share", "records.ts"), "share-records.cjs");
  const protocol = await bundle(path.join(ROOT, "src", "main", "share", "protocol.ts"), "share-protocol.cjs");
  const serviceMod = await bundle(path.join(ROOT, "src", "main", "share", "service.ts"), "share-service.cjs");
  const offerMod = await bundle(path.join(ROOT, "src", "main", "share", "offer.ts"), "share-offer.cjs");

  try {
    await check("the share key is created once, owner-only, and reused", () => {
      const dir = path.join(tmp, "home", "share");
      const first = identity.loadOrCreateShareIdentity(dir);
      assert.equal(first.publicKey.length, 32);
      assert.equal(first.secretKey.length, 64);
      assert.equal(first.publicKeyB64, first.publicKey.toString("base64"));
      if (process.platform !== "win32") {
        assert.equal(mode(dir), 0o700);
        assert.equal(mode(path.join(dir, "identity.json")), 0o600);
      }
      const file = JSON.parse(fs.readFileSync(path.join(dir, "identity.json"), "utf8"));
      assert.equal(file.purpose, "codara-share", "the key says what it is for");
      const again = identity.loadOrCreateShareIdentity(dir);
      assert.equal(again.publicKeyB64, first.publicKeyB64);
    });

    await check("loose modes on the key and its folder are tightened on use", () => {
      if (process.platform === "win32") return;
      const dir = path.join(tmp, "loose", "share");
      identity.loadOrCreateShareIdentity(dir);
      fs.chmodSync(dir, 0o755);
      fs.chmodSync(path.join(dir, "identity.json"), 0o644);
      identity.loadOrCreateShareIdentity(dir);
      assert.equal(mode(dir), 0o700);
      assert.equal(mode(path.join(dir, "identity.json")), 0o600);
    });

    await check("a symlinked share folder is refused", () => {
      if (process.platform === "win32") return;
      const real = path.join(tmp, "elsewhere");
      fs.mkdirSync(real);
      const link = path.join(tmp, "linked-share");
      fs.symlinkSync(real, link);
      assert.throws(() => identity.loadOrCreateShareIdentity(link), /symlink/);
      assert.deepEqual(fs.readdirSync(real), [], "nothing is written through the link");
    });

    await check("a symlink planted at identity.json is not read through", () => {
      if (process.platform === "win32") return;
      const dir = path.join(tmp, "planted", "share");
      fs.mkdirSync(dir, { recursive: true });
      const decoy = path.join(tmp, "decoy.json");
      const other = identity.loadOrCreateShareIdentity(path.join(tmp, "decoy-src"));
      fs.copyFileSync(path.join(tmp, "decoy-src", "identity.json"), decoy);
      fs.symlinkSync(decoy, path.join(dir, "identity.json"));
      const loaded = identity.loadOrCreateShareIdentity(dir);
      assert.notEqual(loaded.publicKeyB64, other.publicKeyB64, "the planted key is not used");
      assert.ok(!fs.lstatSync(path.join(dir, "identity.json")).isSymbolicLink(), "the link is replaced by a real file");
    });

    await check("a damaged key file is replaced by a fresh key", () => {
      const dir = path.join(tmp, "corrupt", "share");
      const first = identity.loadOrCreateShareIdentity(dir);
      fs.writeFileSync(path.join(dir, "identity.json"), "{not json");
      const second = identity.loadOrCreateShareIdentity(dir);
      assert.notEqual(second.publicKeyB64, first.publicKeyB64);
      const file = path.join(dir, "identity.json");
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      parsed.publicKey = Buffer.alloc(32, 7).toString("base64");
      fs.writeFileSync(file, JSON.stringify(parsed));
      const third = identity.loadOrCreateShareIdentity(dir);
      assert.notEqual(third.publicKeyB64, parsed.publicKey, "halves that disagree are not trusted");
    });

    await check("the local list keeps valid records, newest first, owner-only", () => {
      const dir = path.join(tmp, "records", "share");
      const page = (id, createdAt) => ({ id, url: `https://s.test/p/${id}`, title: "a.md", size: 1, createdAt, expiresAt: createdAt + 10 });
      records.upsertShareRecord(dir, page(ID_A, 1));
      records.upsertShareRecord(dir, page(ID_B, 2));
      assert.deepEqual(records.readShareRecords(dir).map((p) => p.id), [ID_B, ID_A]);
      if (process.platform !== "win32") assert.equal(mode(path.join(dir, "pages.json")), 0o600);
      records.removeShareRecord(dir, ID_B);
      assert.deepEqual(records.readShareRecords(dir).map((p) => p.id), [ID_A]);
      const file = path.join(dir, "pages.json");
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      raw.pages.push({ id: "../../etc", url: "x", title: "t", size: 1, createdAt: 1, expiresAt: 2 });
      raw.pages.push({ ...page(ID_B, 3), url: "https://evil.test/elsewhere" });
      fs.writeFileSync(file, JSON.stringify(raw));
      assert.deepEqual(records.readShareRecords(dir).map((p) => p.id), [ID_A], "malformed records are dropped");
      fs.writeFileSync(file, "garbage");
      assert.deepEqual(records.readShareRecords(dir), []);
    });

    const signer = identity.loadOrCreateShareIdentity(path.join(tmp, "signer", "share"));

    await check("requests are signed over the canonical message", () => {
      const body = Buffer.from("<p>héllo</p>", "utf8");
      const req = protocol.createPageRequest("https://s.test", signer, "<p>héllo</p>", 30);
      assert.equal(req.method, "POST");
      assert.equal(req.url, "https://s.test/v1/pages?ttlDays=30");
      assert.equal(req.headers["content-type"], "text/html; charset=utf-8");
      assert.ok(req.body.equals(body));
      assert.equal(Buffer.from(req.headers["x-codara-nonce"], "base64").length, 24);
      assert.ok(verifyWithNode(req.headers, "POST", "/v1/pages?ttlDays=30", body));
      assert.ok(!verifyWithNode(req.headers, "POST", "/v1/pages?ttlDays=90", body), "the query is signed");
      assert.ok(!verifyWithNode(req.headers, "POST", "/v1/pages?ttlDays=30", Buffer.from("other")), "the body is signed");
      const list = protocol.listPagesRequest("https://s.test", signer);
      assert.ok(verifyWithNode(list.headers, "GET", "/v1/pages"));
      const del = protocol.deletePageRequest("https://s.test", signer, ID_A);
      assert.ok(verifyWithNode(del.headers, "DELETE", `/v1/pages/${ID_A}`));
      const patch = protocol.setExpiryRequest("https://s.test", signer, ID_A, 7);
      assert.equal(patch.url, `https://s.test/v1/pages/${ID_A}?ttlDays=7`);
      assert.ok(verifyWithNode(patch.headers, "PATCH", `/v1/pages/${ID_A}?ttlDays=7`));
      const again = protocol.listPagesRequest("https://s.test", signer);
      assert.notEqual(again.headers["x-codara-nonce"], list.headers["x-codara-nonce"], "every request has a fresh nonce");
      assert.throws(() => protocol.deletePageRequest("https://s.test", signer, "../admin"), /page id/);
      assert.throws(() => protocol.pageLink("https://s.test", "nope"), /page id/);
    });

    const repo = shareRepo();
    await check(`the share service's own verifier accepts Studio's signature${repo ? "" : " (codara-share not found, skipped)"}`, async () => {
      if (!repo) return;
      const service = await bundle(path.join(repo, "src", "protocol.ts"), "codara-share-protocol.cjs");
      const html = "<!doctype html><p>interop</p>";
      const req = protocol.createPageRequest("https://s.test", signer, html, 90);
      const headers = {
        key: req.headers["x-codara-key"],
        timestamp: req.headers["x-codara-timestamp"],
        nonce: req.headers["x-codara-nonce"],
        signature: req.headers["x-codara-signature"],
      };
      const verified = service.verifyRequestSignature({
        method: "POST",
        target: "/v1/pages?ttlDays=90",
        body: Buffer.from(html, "utf8"),
        headers,
        now: Date.now(),
        clockSkewMs: 60_000,
      });
      assert.equal(verified.key, signer.publicKeyB64);
      assert.throws(() =>
        service.verifyRequestSignature({
          method: "POST",
          target: "/v1/pages?ttlDays=7",
          body: Buffer.from(html, "utf8"),
          headers,
          now: Date.now(),
          clockSkewMs: 60_000,
        }),
      );
      assert.ok(service.isPageId(ID_A), "Studio's id pattern matches the service's ids");
    });

    await check("the base URL defaults to the constant and accepts only safe overrides", () => {
      assert.equal(protocol.shareBaseUrl({}), protocol.DEFAULT_SHARE_BASE_URL);
      assert.ok(protocol.DEFAULT_SHARE_BASE_URL.startsWith("https://"));
      assert.equal(protocol.shareBaseUrl({ CODARA_SHARE_URL: "https://share.example.com/" }), "https://share.example.com");
      assert.equal(protocol.shareBaseUrl({ CODARA_SHARE_URL: "http://127.0.0.1:9001" }), "http://127.0.0.1:9001");
      assert.equal(protocol.shareBaseUrl({ CODARA_SHARE_URL: "http://localhost:9001" }), "http://localhost:9001");
      assert.throws(() => protocol.shareBaseUrl({ CODARA_SHARE_URL: "http://share.example.com" }), /https/);
      assert.throws(() => protocol.shareBaseUrl({ CODARA_SHARE_URL: "https://u:p@share.example.com" }), /plain/);
      assert.throws(() => protocol.shareBaseUrl({ CODARA_SHARE_URL: "https://share.example.com/?x=1" }), /plain/);
      assert.throws(() => protocol.shareBaseUrl({ CODARA_SHARE_URL: "not a url" }), /valid URL/);
    });

    await check("responses are parsed strictly and the link is built locally", () => {
      assert.deepEqual(protocol.parseRemotePage(remotePage(ID_A, { expiresAt: 5 })), remotePage(ID_A, { expiresAt: 5 }));
      assert.equal(protocol.parseRemotePage({ ...remotePage(ID_A), path: "/p/other" }), null);
      assert.equal(protocol.parseRemotePage({ ...remotePage(ID_A), size: -1 }), null);
      assert.equal(protocol.parseRemotePage({ ...remotePage("short") }), null);
      const list = protocol.parseRemotePageList({ pages: [remotePage(ID_A), { id: "bad" }] });
      assert.deepEqual(list.map((p) => p.id), [ID_A]);
      assert.equal(protocol.parseRemotePageList({ nope: [] }), null);
      assert.equal(protocol.pageLink("https://s.test", ID_A), `https://s.test/p/${ID_A}`);
    });

    await check("service errors read as plain sentences", () => {
      for (const [status, code] of [[401], [404], [413], [429, "page_limit"], [429, "daily_limit"], [429, "rate_limit"], [503], [507], [500]]) {
        const text = protocol.shareErrorMessage(status, code);
        assert.ok(text.length > 10 && /[.)]$/.test(text), `${status} ${code}: ${text}`);
        assert.doesNotMatch(text, /[–—]/, "no em or en dashes in user copy");
      }
      assert.match(protocol.shareErrorMessage(429, "page_limit"), /Settings, Shared pages/);
    });

    await check("ShareService uploads, records, lists, extends and deletes", async () => {
      const dir = path.join(tmp, "service", "share");
      const calls = [];
      const pages = new Map();
      const fakeFetch = async (url, init) => {
        const u = new URL(url);
        const target = u.pathname + u.search;
        const body = init.body ? Buffer.from(init.body) : undefined;
        assert.ok(verifyWithNode(init.headers, init.method, target, body), `signed ${init.method} ${target}`);
        assert.equal(init.redirect, "error", "redirects are never followed");
        calls.push(`${init.method} ${target}`);
        if (init.method === "POST") {
          const page = remotePage(ID_A, { size: body.length });
          pages.set(ID_A, page);
          return jsonResponse(201, { ...page, url: "https://attacker.test/p/x" });
        }
        if (init.method === "GET") return jsonResponse(200, { pages: [...pages.values()] });
        if (init.method === "PATCH") {
          const page = pages.get(u.pathname.split("/").pop());
          if (!page) return jsonResponse(404, { error: "not found" });
          page.expiresAt = 42_000;
          return jsonResponse(200, page);
        }
        if (init.method === "DELETE") {
          const existed = pages.delete(u.pathname.split("/").pop());
          return existed ? new Response(null, { status: 204 }) : jsonResponse(404, { error: "not found" });
        }
        throw new Error("unexpected");
      };
      const log = [];
      const service = new serviceMod.ShareService({
        shareDir: dir,
        fetchImpl: fakeFetch,
        baseUrl: () => "https://s.test",
        log: (line) => log.push(line),
      });
      const created = await service.create({ html: "<p>x</p>", title: "report\u0007.md", ttlDays: 30 });
      assert.equal(created.url, `https://s.test/p/${ID_A}`, "the link comes from Studio's base URL, not the reply");
      assert.equal(created.title, "report .md", "control characters are removed from titles");
      assert.equal(records.readShareRecords(dir)[0].id, ID_A);
      assert.ok(log.every((line) => !line.includes(ID_A) && !line.includes("s.test")), "logs carry no link or id");
      const listed = await service.list();
      assert.equal(listed.offline, false);
      assert.equal(listed.pages[0].title, "report .md", "the local title joins the service's list");
      const extended = await service.setExpiry(ID_A, 90);
      assert.equal(extended.expiresAt, 42_000);
      await service.delete(ID_A);
      assert.deepEqual(records.readShareRecords(dir), []);
      await service.delete(ID_A);
      assert.deepEqual(calls.filter((c) => c.startsWith("DELETE")).length, 2, "deleting a page already gone is fine");
      await assert.rejects(service.create({ html: "", title: "x", ttlDays: 30 }), /nothing to share/);
      await assert.rejects(service.create({ html: "x", title: "x", ttlDays: 31 }), /7, 30 or 90/);
      await assert.rejects(service.create({ html: "x".repeat(5 * 1024 * 1024 + 1), title: "x", ttlDays: 30 }), /5 MB/);
      await assert.rejects(service.delete("../../x"), /page id/);
      assert.ok(!calls.some((c) => c.includes("..")), "a bad id never reaches the network");
    });

    await check("ShareService keeps the local list while the service is unreachable", async () => {
      const dir = path.join(tmp, "offline", "share");
      records.upsertShareRecord(dir, { id: ID_A, url: `https://s.test/p/${ID_A}`, title: "a.md", size: 1, createdAt: 1, expiresAt: Date.now() + 60_000 });
      records.upsertShareRecord(dir, { id: ID_B, url: `https://s.test/p/${ID_B}`, title: "b.md", size: 1, createdAt: 2, expiresAt: Date.now() - 1 });
      const down = new serviceMod.ShareService({
        shareDir: dir,
        fetchImpl: async () => {
          throw new TypeError("fetch failed");
        },
        baseUrl: () => "https://s.test",
      });
      const listed = await down.list();
      assert.equal(listed.offline, true);
      assert.deepEqual(listed.pages.map((p) => p.id), [ID_A], "expired pages are hidden offline");
      assert.match(listed.error, /Could not reach/);
      await assert.rejects(down.create({ html: "<p>x</p>", title: "x", ttlDays: 7 }), /Could not reach the share service/);
      const limited = new serviceMod.ShareService({
        shareDir: dir,
        fetchImpl: async () => jsonResponse(429, { error: "too many", code: "page_limit" }),
        baseUrl: () => "https://s.test",
      });
      await assert.rejects(limited.create({ html: "<p>x</p>", title: "x", ttlDays: 7 }), /limit of shared pages/);
    });

    await check("an agent's offer names an existing page the app may read, once per caller per window", async () => {
      const dir = fs.mkdtempSync(path.join(tmp, "offer-"));
      const page = path.join(dir, "report.md");
      fs.writeFileSync(page, "# hi");
      fs.writeFileSync(path.join(dir, "notes.txt"), "x");
      fs.writeFileSync(path.join(dir, "big.html"), Buffer.alloc(5 * 1024 * 1024 + 1, 32));
      let now = 1_000_000;
      const allowedRoot = dir;
      const gate = new offerMod.ShareOfferGate({
        assertReadable: async (p) => {
          if (!p.startsWith(allowedRoot + path.sep)) throw new Error("Path not allowed");
        },
        now: () => now,
      });
      const ok = await gate.check(page, "pane:1");
      assert.deepEqual(ok, { ok: true, path: fs.realpathSync(page) });
      assert.equal((await gate.check(page, "pane:1")).reason, "rate_limited");
      assert.equal((await gate.check(page, "pane:2")).ok, true, "another caller has its own window");
      now += offerMod.SHARE_OFFER_MIN_INTERVAL_MS;
      assert.equal((await gate.check(page, "pane:1")).ok, true);
      assert.equal((await gate.check("report.md", "pane:3")).reason, "invalid");
      assert.equal((await gate.check("ssh://host/x.md", "pane:3")).reason, "invalid");
      assert.equal((await gate.check(42, "pane:3")).reason, "invalid");
      assert.equal((await gate.check(path.join(dir, "notes.txt"), "pane:3")).reason, "not_shareable");
      assert.equal((await gate.check(path.join(dir, "missing.md"), "pane:3")).reason, "missing");
      assert.equal((await gate.check(path.join(dir, "big.html"), "pane:3")).reason, "too_large");
      assert.equal((await gate.check(dir + ".md", "pane:3")).reason, "missing");
      const outside = path.join(tmp, "outside.md");
      fs.writeFileSync(outside, "# secret");
      assert.equal((await gate.check(outside, "pane:4")).reason, "not_allowed");
      if (process.platform !== "win32") {
        const key = path.join(dir, "id_ed25519");
        fs.writeFileSync(key, "PRIVATE");
        fs.symlinkSync(key, path.join(dir, "looks-like.md"));
        assert.equal((await gate.check(path.join(dir, "looks-like.md"), "pane:5")).reason, "not_shareable", "the link target decides");
        fs.symlinkSync(outside, path.join(dir, "inside-link.md"));
        assert.equal((await gate.check(path.join(dir, "inside-link.md"), "pane:6")).reason, "not_allowed", "a link out of the folder is refused");
      }
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
