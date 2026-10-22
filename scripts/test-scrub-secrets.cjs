"use strict";
// The secret scrubber (scrubSecrets in src/shared/memory-items.ts): what a
// person typed is rewritten before it is written to disk (run files, the task
// list), so it must replace every credential, leave ordinary text alone, and
// give the same text back when it runs again on its own output.
//
//   node scripts/test-scrub-secrets.cjs

const assert = require("node:assert/strict");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");

async function load() {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "shared", "memory-items.ts")],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

let memory;
const scrub = (text) => memory.scrubSecrets(text);

function replacesCredentials() {
  const key = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWx1234";
  const out = scrub(`use this key ${key} for the deploy`);
  assert.equal(out, "use this key [redacted] for the deploy");
  assert.ok(!memory.containsSecret(out));
  assert.equal(scrub("my password is hunter2hunter2 ok"), "my password is [redacted] ok");
  assert.equal(scrub("postgres://admin:s3cretpw@db:5432/x"), "postgres://[redacted]@db:5432/x");
  assert.equal(scrub("card 4111 1111 1111 1111 please"), "card [redacted] please");
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----";
  assert.ok(!memory.containsSecret(scrub(`here ${pem} done`)));
  assert.equal(scrub("password=Tr0ub4dor&3"), "password=[redacted]");
}

// Shapes the first scrubber let through: a keyword glued to a variable name
// by "_", a key holding "/", and a Bearer token made only of hex.
function catchesEnvAndBearer() {
  const aws = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  assert.equal(scrub(`AWS_SECRET_ACCESS_KEY=${aws}`), "AWS_SECRET_ACCESS_KEY=[redacted]");
  assert.equal(scrub(`export aws_secret_access_key = ${aws}`), "export aws_secret_access_key = [redacted]");
  assert.equal(scrub(`GITHUB_TOKEN=Zq8Xw2Lp9Rt4Vb7Nm3Kd`), "GITHUB_TOKEN=[redacted]");
  assert.equal(scrub(`DB_PASSWORD: hunter2hunter2`), "DB_PASSWORD: [redacted]");
  assert.equal(scrub(`the key is ${aws} ok`), "the key is [redacted] ok");
  assert.equal(scrub(`here ${aws}`), "here [redacted]");
  const hex = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
  assert.equal(scrub(`curl -H "Authorization: Bearer ${hex}" https://api.x.io`), `curl -H "Authorization: Bearer [redacted]" https://api.x.io`);
  assert.equal(scrub(`bearer ${hex.slice(0, 32)}`), "bearer [redacted]");
  for (const text of [`AWS_SECRET_ACCESS_KEY=${aws}`, `Bearer ${hex}`]) assert.ok(memory.containsSecret(text), text);
}

function leavesProseAlone() {
  for (const plain of [
    "run npm test in src/main and open PR #42",
    "the token is expired, can you refresh it",
    "the password is incorrect",
    "la clave es correcta",
    "https://github.com/Ed3scombe3s/codara-studio/pull/1234",
    "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abc/edit",
    "src/main/cos/TaskStore2Helpers/x.ts",
    "/Users/Etienne/code/app/worktrees/fix-login2",
    "use sk-learn-compatible-models here",
  ]) {
    assert.equal(scrub(plain), plain, plain);
  }
}

// The retry path and an answer sent through addRunMessage scrub the same
// text twice; the second pass must change nothing.
const SAMPLES = [
  "my password is hunter2hunter2 ok",
  "password=Tr0ub4dor&3",
  "password: Tr0ub4dor&3.",
  "the api key is sk-proj-AbCdEfGhIjKlMnOpQrStUvWx1234!",
  "token: ghp_AbCdEfGhIjKlMnOpQrStUvWx1234567890",
  "postgres://admin:s3cretpw@db:5432/x",
  "card 4111 1111 1111 1111 please",
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY----- done",
  "secret = [redacted] and passwd = [redacted]]",
];

function idempotent() {
  for (const sample of SAMPLES) {
    const once = scrub(sample);
    assert.equal(scrub(once), once, `a second pass changed ${JSON.stringify(once)}`);
    assert.equal(scrub(scrub(once)), once, `a third pass changed ${JSON.stringify(once)}`);
  }
  assert.equal(scrub("password is [redacted]"), "password is [redacted]");
  assert.equal(scrub("password=[redacted]."), "password=[redacted].");
}

(async () => {
  memory = await load();
  const suites = { replacesCredentials, catchesEnvAndBearer, leavesProseAlone, idempotent };
  let failed = 0;
  for (const [name, run] of Object.entries(suites)) {
    try {
      await run();
      console.log(`PASS ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${name}\n${error && error.message ? error.message : error}`);
    }
  }
  if (failed) process.exit(1);
  console.log("scrub secrets: all passed");
})();
