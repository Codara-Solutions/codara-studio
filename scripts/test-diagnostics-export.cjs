#!/usr/bin/env node
"use strict";

// "Export diagnostics" (src/main/diagnostics/export-bundle.ts, redact.ts,
// zip.ts): what leaves the computer when a user attaches the zip to a bug
// report.
//
// - redaction: provider keys and tokens, bearer and basic credentials, URL
//   passwords and query secrets, key=value secrets, private keys, opaque
//   blobs, email addresses, the user's home folder in every spelling (POSIX,
//   Windows, JSON-escaped, file: URL) and other users' homes; commit hashes,
//   UUIDs and ordinary log text survive
// - settings: values under secret-looking keys are replaced, the rest is
//   kept so the settings still help
// - the bundle built from a fake Codara home holds the expected files, lists
//   crash dumps without their contents, and contains none of the planted
//   secrets
// - the zip opens with Codara's own reader and, when installed, passes
//   `unzip -t` and Python's zipfile CRC check
// - the About page summary line
//
//   node scripts/test-diagnostics-export.cjs

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-diagnostics-export-"));
process.on("exit", () => fs.rmSync(TMP, { recursive: true, force: true }));

const ELECTRON_STUB = path.join(TMP, "electron-stub.cjs");
fs.writeFileSync(ELECTRON_STUB, "module.exports = { app: { getPath: () => process.env.CODARA_HOME_DIR } };\n");

function bundle(entry, name) {
  const outfile = path.join(TMP, `${name}.cjs`);
  esbuild.buildSync({
    entryPoints: [path.join(ROOT, entry)],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    logLevel: "silent",
    alias: { "@shared": path.join(ROOT, "src", "shared"), electron: ELECTRON_STUB },
  });
  return require(outfile);
}

const redact = bundle("src/main/diagnostics/redact.ts", "redact");
const zip = bundle("src/main/diagnostics/zip.ts", "zip");
const exporter = bundle("src/main/diagnostics/export-bundle.ts", "export-bundle");
const shared = bundle("src/shared/diagnostics.ts", "shared-diagnostics");
const skillImport = bundle("src/main/skill-import.ts", "skill-import");

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`not ok - ${name}`);
    console.error(error && error.stack ? error.stack : error);
  }
}

const CTX = { homeDirs: ["/home/ann", "C:\\Users\\Ann"] };
const r = (text) => redact.redactText(text, CTX);

const SECRETS = {
  anthropic: "sk-ant-api03-AbCdEfGh1234567890_xyz",
  openrouter: "sk-or-v1-0123456789abcdef0123456789abcdef",
  github: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  githubPat: "github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
  slack: "xoxb-1234567890-abcdefghij",
  aws: "AKIAIOSFODNN7EXAMPLE",
  // Joined at runtime so the secret scanner does not take this fake for a key.
  jwt: ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"].join("."),
  opaque: "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
};

async function main() {
  await check("provider keys and tokens are removed wherever they appear", () => {
    for (const [name, secret] of Object.entries(SECRETS)) {
      const out = r(`before ${secret} after`);
      assert.ok(!out.includes(secret), `${name}: ${out}`);
      assert.match(out, /^before \[redacted\] after$/, name);
    }
  });

  await check("credentials in headers, URLs, flags and key=value pairs are removed", () => {
    const cases = [
      ["Authorization: Bearer abc.def-ghi_jkl", "abc.def"],
      ["auth Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpw"],
      ["cloning https://ann:hunter2@example.com/repo.git", "hunter2"],
      ["GET https://relay.example/connect?token=s3cr3tvalue&x=1", "s3cr3tvalue"],
      ["callback #access_token=tok123456&state=1", "tok123456"],
      ['{"apiKey": "plain-secret-value", "model": "x"}', "plain-secret-value"],
      ["password=hunter2 user=ann", "hunter2"],
      ["x-api-key: k-123456", "k-123456"],
      ["cora --token abc123secret --verbose", "abc123secret"],
      ["client_secret: 'zzz-secret'", "zzz-secret"],
      ["-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3NzaC1yc2E\n-----END OPENSSH PRIVATE KEY-----", "AAAAB3NzaC1yc2E"],
    ];
    for (const [text, secret] of cases) {
      const out = r(text);
      assert.ok(!out.includes(secret), `${text} -> ${out}`);
      assert.ok(out.includes("[redacted]"), `${text} -> ${out}`);
    }
    assert.equal(r("cloning https://ann:hunter2@example.com/repo.git"), "cloning https://[redacted]@example.com/repo.git");
    assert.equal(r("GET https://relay.example/connect?token=s3cr3tvalue&x=1"), "GET https://relay.example/connect?token=[redacted]&x=1");
    assert.equal(r('{"apiKey": "plain-secret-value", "model": "x"}'), '{"apiKey": "[redacted]", "model": "x"}');
  });

  await check("email addresses are removed, an SSH remote is not an address", () => {
    assert.equal(r("signed in as ann.smith+codara@example.co.uk today"), "signed in as [email] today");
    assert.equal(r("Co-Authored-By: Claude <noreply@anthropic.com>"), "Co-Authored-By: Claude <[email]>");
    assert.equal(r("remote git@github.com:org/repo.git"), "remote git@github.com:org/repo.git");
  });

  await check("the home folder becomes ~ in every spelling, other users' homes lose their name", () => {
    assert.equal(r("cwd=/home/ann/projects/x"), "cwd=~/projects/x");
    assert.equal(r("home is /home/ann"), "home is ~");
    assert.equal(r('"cwd":"/home/ann/code"'), '"cwd":"~/code"');
    assert.equal(r("at file:///home/ann/app/out/main/index.js:1:2"), "at file://~/app/out/main/index.js:1:2");
    assert.equal(r("C:\\Users\\Ann\\AppData\\Roaming"), "~\\AppData\\Roaming");
    assert.equal(r("c:\\users\\ann\\x"), "~\\x");
    assert.equal(r('{"p":"C:\\\\Users\\\\Ann\\\\code"}'), '{"p":"~\\\\code"}');
    assert.equal(r("C:/Users/Ann/code"), "~/code");
    assert.equal(r("/home/anne/x"), "/home/<user>/x", "a longer name is someone else, not ~e");
    assert.equal(r("/Users/bob/Library and /home/carol"), "/Users/<user>/Library and /home/<user>");
    assert.equal(r("C:\\Users\\bob\\x"), "C:\\Users\\<user>\\x");
    assert.equal(r("/home/ann."), "/home/<user>", "no spelling leaves the name behind");
  });

  await check("commit hashes, UUIDs and ordinary log text survive", () => {
    const keep = [
      "2026-10-15T10:00:00.000Z [crash] renderer process gone: crashed (exitCode 132)",
      "commit 3f2a1b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a merged",
      "dump pending/ef8da38c-6c02-46af-b834-a5b0b01628f5.dmp",
      "env CODARA_HANG_WATCHDOG_THRESHOLD_MS=1500",
      "author: Ann wrote the keybindings",
      "/var/tmp/codara/run/out.log",
      "main process did not respond for 7.4 s and recovered; cpu 98%, rss 300 MB",
    ];
    for (const text of keep) assert.equal(r(text), text);
  });

  await check("secret-looking settings keys are replaced, the rest is kept", () => {
    const out = redact.redactJson(
      {
        defaultShellId: "zsh",
        openRouterApiKey: "enc:v1:abcdef",
        openRouterModel: "openai/gpt-5.5",
        openRouterVerifiedKeyHash: "a".repeat(64),
        coraWorkerModels: ["claude-opus-5-5", "gpt-5.5"],
        githubWebhook: { secret: "whsec_123", url: "https://x.example/hook?token=abc" },
        auth: { refresh: "r-1", access: "a-1" },
        requireAuth: true,
        emptyToken: "",
        accountEmail: "ann@example.com",
        workspaceRoots: ["/home/ann/code/app"],
        keybindings: { "app.quit": "Mod+Q" },
      },
      CTX,
    );
    assert.deepEqual(out, {
      defaultShellId: "zsh",
      openRouterApiKey: "[redacted]",
      openRouterModel: "openai/gpt-5.5",
      openRouterVerifiedKeyHash: "[redacted]",
      coraWorkerModels: ["claude-opus-5-5", "gpt-5.5"],
      githubWebhook: { secret: "[redacted]", url: "https://x.example/hook?token=[redacted]" },
      auth: "[redacted]",
      requireAuth: true,
      emptyToken: "",
      accountEmail: "[redacted]",
      workspaceRoots: ["~/code/app"],
      keybindings: { "app.quit": "Mod+Q" },
    });
    for (const key of ["apiKey", "OPENAI_API_KEY", "sessionKey", "cookies", "client_secret", "Authorization", "privateKey", "accessToken"]) {
      assert.equal(redact.isSensitiveKey(key), true, key);
    }
    for (const key of ["keybindings", "keyboardLayout", "monkey", "author", "theme", "tokenizerModel"]) {
      assert.equal(redact.isSensitiveKey(key), false, key);
    }
  });

  await check("the zip writer: CRC-32, store when deflate does not help, refuses unsafe names", () => {
    assert.equal(zip.crc32(Buffer.from("123456789")), 0xcbf43926);
    assert.throws(() => zip.createZip([{ name: "../escape.txt", data: "x" }]), /Invalid zip entry/);
    assert.throws(() => zip.createZip([{ name: "a.txt", data: "x" }, { name: "a.txt", data: "y" }]), /Duplicate/);
    const random = require("node:crypto").randomBytes(4096);
    const archive = zip.createZip([
      { name: "random.bin", data: random },
      { name: "text.txt", data: "hello ".repeat(1000) },
    ]);
    const entries = skillImport.readZipEntries(archive);
    assert.deepEqual(
      entries.map((entry) => [entry.name, entry.method]),
      [
        ["random.bin", 0],
        ["text.txt", 8],
      ],
    );
  });

  // ── The bundle, from a fake Codara home with planted secrets ─────────────
  const home = path.join(TMP, "home");
  const diagnosticsDir = path.join(home, "diagnostics");
  const crashDumpsDir = path.join(home, "crash-dumps");
  for (const dir of [path.join(home, "logs"), diagnosticsDir, path.join(crashDumpsDir, "pending"), path.join(crashDumpsDir, "completed")]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(
    path.join(home, "logs", "main.log"),
    [
      "2026-10-15T10:00:00.000Z [boot] app start pid=1 home=/home/ann/.codarastudio",
      `2026-10-15T10:00:01.000Z [accounts] signed in ann@example.com with ${SECRETS.anthropic}`,
      "2026-10-15T10:00:02.000Z [remote] relay https://relay.example/ws?token=abc123456",
      "2026-10-15T10:00:03.000Z [hang] main process did not respond for 7.4 s and recovered",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(home, "logs", "main.log.1"), `2026-10-14T09:00:00.000Z [boot] Authorization: Bearer ${SECRETS.github}\n`);
  const hang = {
    id: "1-2-1",
    startedAt: Date.parse("2026-10-15T10:00:00Z"),
    detectedAt: Date.parse("2026-10-15T10:00:05Z"),
    unresponsiveMs: 5000,
    durationMs: 7400,
    recovered: true,
    pid: 1,
    cpuPercent: 99,
    rssBytes: 1,
    loadAverage: [1, 1, 1],
    freeMemoryBytes: 1,
    totalMemoryBytes: 2,
    stack: [{ fn: "scan", url: "file:///home/ann/app/out/main/index.js", line: 3, column: 4 }],
    stackNote: null,
    breadcrumbs: [{ t: 1, category: "git", message: "fetch https://ann:hunter2@example.com/repo.git for ann@example.com" }],
  };
  fs.writeFileSync(path.join(diagnosticsDir, "hangs.jsonl"), `${JSON.stringify(hang)}\n{"torn":`);
  fs.writeFileSync(
    path.join(diagnosticsDir, "breadcrumbs.previous.json"),
    JSON.stringify({ pid: 1, breadcrumbs: [{ t: 1, category: "boot", message: `opened /home/ann/secret-project with ${SECRETS.githubPat}` }] }),
  );
  fs.writeFileSync(path.join(crashDumpsDir, "pending", "aaaa-1111.dmp"), Buffer.alloc(1000, 7));
  fs.writeFileSync(path.join(crashDumpsDir, "completed", "bbbb-2222.dmp"), Buffer.alloc(2000, 7));
  fs.writeFileSync(path.join(crashDumpsDir, "completed", "bbbb-2222.meta"), "meta");
  fs.writeFileSync(path.join(crashDumpsDir, "settings.dat"), "crashpad");
  fs.writeFileSync(
    path.join(home, "spark-settings.json"),
    JSON.stringify({ defaultShellId: "zsh", openRouterApiKey: "enc:v1:QUJDREVGRw==", openRouterModel: "openai/gpt-5.5" }),
  );
  fs.writeFileSync(path.join(home, "spark-preferences.json"), JSON.stringify({ theme: "codara-classic", lastFolder: "/home/ann/code" }));

  const now = new Date(2026, 9, 15, 14, 2);
  const entries = await exporter.buildDiagnosticsEntries({
    sources: { home, diagnosticsDir, crashDumpsDir },
    redaction: CTX,
    system: { app: { version: "1.2.3" }, blackBox: { crashDumpsFolder: "/home/ann/.codarastudio/crash-dumps" } },
    breadcrumbs: [{ t: 2, category: "boot", message: "user ann@example.com home /home/ann" }],
    eventLoop: [{ t: 3, windowMs: 60000, p50Ms: 0.4, p99Ms: 12, maxMs: 340 }],
    now,
  });
  const archive = zip.createZip(entries);
  const zipPath = path.join(TMP, exporter.diagnosticsFileName(now));
  fs.writeFileSync(zipPath, archive);
  const unpacked = path.join(TMP, "unpacked");
  fs.mkdirSync(unpacked);
  await skillImport.extractZipSafely(archive, unpacked);
  const read = (name) => fs.readFileSync(path.join(unpacked, ...name.split("/")), "utf8");

  await check("the bundle holds the expected files and its name carries the date", () => {
    assert.equal(path.basename(zipPath), "codara-diagnostics-20261015-1402.zip");
    assert.deepEqual(
      entries.map((entry) => entry.name).sort(),
      [
        "README.txt",
        "crash-dumps.json",
        "diagnostics/breadcrumbs.json",
        "diagnostics/breadcrumbs.previous.json",
        "diagnostics/event-loop.json",
        "diagnostics/hangs.jsonl",
        "logs/main.log",
        "logs/main.log.1",
        "settings/spark-preferences.json",
        "settings/spark-settings.json",
        "system.json",
      ],
    );
    assert.match(read("README.txt"), /did not upload/);
  });

  await check("no planted secret, address or home path survives anywhere in the zip", () => {
    const planted = [
      ...Object.values(SECRETS),
      "ann@example.com",
      "/home/ann",
      "hunter2",
      "abc123456",
      "QUJDREVGRw",
    ];
    for (const entry of entries) {
      const text = read(entry.name);
      for (const secret of planted) assert.ok(!text.includes(secret), `${entry.name} still has ${secret}`);
    }
    assert.ok(!archive.includes(Buffer.from("ann@example.com")), "not even in the raw archive");
  });

  await check("redacted files keep what helps: log lines, the stack, settings that are not secret", () => {
    const log = read("logs/main.log");
    assert.match(log, /\[boot\] app start pid=1 home=~\/\.codarastudio/);
    assert.match(log, /signed in \[email\] with \[redacted\]/);
    assert.match(log, /ws\?token=\[redacted\]/);
    assert.match(log, /\[hang\] main process did not respond for 7\.4 s and recovered/);
    const hangs = read("diagnostics/hangs.jsonl").split("\n");
    const first = JSON.parse(hangs[0]);
    assert.equal(first.stack[0].url, "file://~/app/out/main/index.js");
    assert.equal(first.breadcrumbs[0].message, "fetch https://[redacted]@example.com/repo.git for [email]");
    const settings = JSON.parse(read("settings/spark-settings.json"));
    assert.deepEqual(settings, { defaultShellId: "zsh", openRouterApiKey: "[redacted]", openRouterModel: "openai/gpt-5.5" });
    assert.deepEqual(JSON.parse(read("settings/spark-preferences.json")), { theme: "codara-classic", lastFolder: "~/code" });
    assert.equal(JSON.parse(read("system.json")).blackBox.crashDumpsFolder, "~/.codarastudio/crash-dumps");
    assert.deepEqual(JSON.parse(read("diagnostics/breadcrumbs.json")).breadcrumbs[0].message, "user [email] home ~");
    assert.equal(JSON.parse(read("diagnostics/event-loop.json")).windows[0].maxMs, 340);
  });

  await check("crash dumps are listed by path, size and time, never included", () => {
    const listed = JSON.parse(read("crash-dumps.json"));
    assert.deepEqual(
      listed.dumps.map((dump) => [dump.path, dump.bytes]).sort(),
      [
        ["completed/bbbb-2222.dmp", 2000],
        ["pending/aaaa-1111.dmp", 1000],
      ],
    );
    assert.ok(listed.dumps.every((dump) => !Number.isNaN(Date.parse(dump.modifiedAt))));
    assert.ok(entries.every((entry) => !entry.name.endsWith(".dmp")));
  });

  await check("the zip passes unzip -t and Python's zipfile CRC check when they are installed", () => {
    const unzip = spawnSync("unzip", ["-t", zipPath], { encoding: "utf8" });
    if (unzip.error) console.log("  SKIP unzip -t (not installed)");
    else assert.equal(unzip.status, 0, unzip.stdout + unzip.stderr);
    const python = spawnSync(
      "python3",
      ["-I", "-c", "import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); bad = z.testzip(); print(len(z.namelist())); sys.exit(1 if bad else 0)", zipPath],
      { encoding: "utf8" },
    );
    if (python.error) console.log("  SKIP python3 zipfile (not installed)");
    else {
      assert.equal(python.status, 0, python.stderr);
      assert.equal(python.stdout.trim(), String(entries.length));
    }
  });

  await check("freeze records are read across the rotation, skipping a torn line", async () => {
    fs.writeFileSync(path.join(diagnosticsDir, "hangs.jsonl.1"), `${JSON.stringify({ ...hang, id: "old", detectedAt: hang.detectedAt - 1000 })}\n`);
    const records = await exporter.readHangRecords(diagnosticsDir);
    assert.deepEqual(records.map((record) => record.id), ["old", "1-2-1"]);
  });

  await check("the About page summary line", () => {
    const day = 24 * 60 * 60 * 1000;
    const nowMs = Date.parse("2026-10-15T12:00:00Z");
    const fmt = (ms) => new Date(ms).toISOString().slice(0, 16);
    const flags = { watchdog: true, crashReporter: true };
    const none = exporter.summarizeDiagnostics([], [], flags, nowMs);
    assert.equal(shared.describeDiagnosticsSummary(none, fmt), "No freezes or crashes recorded.");
    const hangs = [
      { ...hang, detectedAt: nowMs - 30 * day, durationMs: 60_000 },
      { ...hang, detectedAt: nowMs - 2 * day, durationMs: 7_400 },
      { ...hang, detectedAt: nowMs - day, durationMs: 5_200, recovered: false },
    ];
    const dumps = [{ path: "pending/a.dmp", bytes: 3 * 1024 * 1024, modifiedAt: nowMs - day }];
    const summary = exporter.summarizeDiagnostics(hangs, dumps, flags, nowMs);
    assert.equal(summary.hangs.total, 3);
    assert.equal(summary.hangs.recent, 2);
    assert.equal(summary.hangs.longestRecentMs, 7_400);
    assert.equal(
      shared.describeDiagnosticsSummary(summary, fmt),
      "2 freezes in the last 7 days, the longest 7.4 s. Last one 2026-10-14T12:00, 5.2 s, did not recover. 1 crash report kept (3.0 MB), the last 2026-10-14T12:00.",
    );
    const old = exporter.summarizeDiagnostics([hangs[0]], [], { watchdog: false, crashReporter: false }, nowMs);
    assert.equal(
      shared.describeDiagnosticsSummary(old, fmt),
      "No freezes in the last 7 days. Last one 2026-09-15T12:00. Freeze detection is off. Crash reports are off.",
    );
    for (const text of [shared.describeDiagnosticsSummary(summary, fmt), shared.describeDiagnosticsSummary(old, fmt)]) {
      assert.ok(!/[\u2013\u2014]/.test(text), "no en or em dashes in UI copy");
    }
    assert.equal(shared.formatDuration(820), "820 ms");
    assert.equal(shared.formatDuration(125_000), "2 min 5 s");
    assert.equal(shared.formatBytes(640 * 1024), "640 KB");
  });

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall diagnostics export checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
