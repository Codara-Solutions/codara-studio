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

async function loadPasted() {
  const out = await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "main", "orchestration", "pasted-secrets.ts")],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
    plugins: [
      {
        name: "shared-alias",
        setup(build) {
          build.onResolve({ filter: /^@shared\// }, (args) => ({
            path: path.join(ROOT, "src", "shared", `${args.path.slice("@shared/".length)}.ts`),
          }));
        },
      },
    ],
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

// What the first scrubber replaced although nobody typed a credential:
// identifiers, base64 data, timestamps and ids that happen to pass Luhn. A
// variable name before a key is kept, so the text still says which key it was.
function fewerFalsePositives() {
  for (const plain of [
    "rename useWorkspaceTaskSummaryForRail2Helper to something shorter",
    "createVerifyGateCommandRunnerForWorkspace3 throws",
    "the TestCosTaskStoreReplaysTornLogLines2026Oct case",
    "MAX_RETRIES_FOR_THE_VERIFY_GATE_V2_FALLBACK is 3",
    "img src=data:image/png;base64,SqTLL8SyAnfDec7oq5iml8og0vZMBzpnzdZ3K0CgZUsPhnlU/8DzBWfFLP/XZq9/ztqUTe8td7fLTYdAM25slu0cj8mZdHRAP9jghkH6a95cTrvEXKNcuR3TL/C0jo/oXeZ3cuRVJrKIAAp5RkH+5o7kibQTTTypIRURVAbD+5o1JP18VFMo3aTXc+jif9XYi+em53kg",
    "SqTLL8SyAnfDec7oq5iml8og0vZMBzpnzdZ3K0CgZUsPhnlU/8DzBWfFLP/XZq9/ztqUTe8td7fLTYdAM25slu0cj8mZdHRAP9jghkH6a95cTrvEXKNcuR3TL/C0jo/oXeZ3cuRVJrKIAAp5RkH+5o7kibQTTTypIRURVAbD+5o1JP18VFMo3aTXc+jif9XYi+em53kg",
    "the run started at 1761177600000 and ended later",
    "ping the bot in channel 1296016829456515086",
  ]) {
    assert.equal(scrub(plain), plain, plain);
  }
  // Card numbers still go: Visa, Amex and Mastercard test numbers.
  assert.equal(scrub("visa 4012888888881881"), "visa [redacted]");
  assert.equal(scrub("amex 378282246310005"), "amex [redacted]");
  assert.equal(scrub("mc 5555-5555-5555-4444 ok"), "mc [redacted] ok");
  assert.ok(!memory.containsSecret("Discord channel 1296016829456515086"), "a Discord id is not a card");
  assert.ok(memory.containsSecret("card 4012888888881881"));
  const random = "aDCMbRgNdSV2WpcxjCoE5845BJMJ4dHtzLAFekOl";
  assert.equal(scrub(`STRIPE_SECRET_KEY=${"sk_" + "live"}_51HqLyjWDarjtT1zdp7dcXaBcDeFgHiJkLmNoPq`), "STRIPE_SECRET_KEY=[redacted]");
  assert.equal(scrub(`SENDGRID_KEY=${random}`), "SENDGRID_KEY=[redacted]");
  assert.equal(scrub(`export SENDGRID_KEY=${random}`), "export SENDGRID_KEY=[redacted]");
  assert.equal(scrub(`key ${random} here`), "key [redacted] here");
  assert.equal(scrub(`https://x.io/cb?state=${random}`), `https://x.io/cb?state=${random}`, "a piece of a link stays");
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
  "SENDGRID_KEY=aDCMbRgNdSV2WpcxjCoE5845BJMJ4dHtzLAFekOl",
  "Authorization: Bearer 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b",
  "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
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

// run-store redacts these exact pieces wherever a run writes later, in case
// the model repeats a key it was shown.
function listsWhatItReplaced() {
  const aws = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  const text = `AWS_SECRET_ACCESS_KEY=${aws} and postgres://admin:s3cretpw@db/x, card 4012888888881881, Bearer 9f86d081884c7d659a2feaa0c55ad015`;
  assert.deepEqual(memory.secretsIn(text).sort(), [aws, "admin:s3cretpw", "4012888888881881", "9f86d081884c7d659a2feaa0c55ad015"].sort());
  assert.deepEqual(memory.secretsIn("nothing to see here"), []);
  for (const secret of memory.secretsIn(text)) assert.ok(text.includes(secret), secret);
}

// The live-prompt side (src/main/orchestration/pasted-secrets.ts): the raw
// text for the one prompt that delivers it, then gone; the keys replaced in
// anything written later, JSON included.
async function pastedSecrets() {
  const pasted = await loadPasted();
  const key = "sk-proj-Zq8Xw2Lp9Rt4Vb7Nm3Kd6Hf1Gj5Sc0Ya";
  const raw = `  deploy with ${key} please `;
  const stored = pasted.scrubPastedText(raw);
  assert.equal(stored, "  deploy with [redacted] please ");
  assert.equal(pasted.scrubPastedText("no key here"), "no key here");
  assert.equal(pasted.livePastedText("deploy with [redacted] please"), raw.trim(), "the live prompt gets the raw text");

  // A direct-lane worker prompt read back from disk: the newest copy is
  // this turn's message, an older copy is history and stays scrubbed.
  const prompt = `History:\nuser: deploy with [redacted] please\n\nTask:\ndeploy with [redacted] please\n`;
  const live = pasted.withPastedText(prompt);
  assert.equal(live.prompt, `History:\nuser: deploy with [redacted] please\n\nTask:\n${raw.trim()}\n`);
  assert.deepEqual(live.used, ["deploy with [redacted] please"]);
  pasted.forgetPastedText(live.used);
  assert.equal(pasted.livePastedText("deploy with [redacted] please"), undefined, "once delivered, gone");
  assert.equal(pasted.withPastedText(prompt).prompt, prompt, "a relaunch reads the scrubbed text");

  const later = time => pasted.livePastedText("x [redacted]", time);
  pasted.scrubPastedText(`x ${key.replace("Zq8", "Ab1")}`, 1_000);
  assert.ok(later(1_000 + 60_000), "kept for the turn");
  assert.equal(later(1_000 + 2 * 60 * 60 * 1000), undefined, "dropped after an hour");

  // The model repeating the key, in text and in serialized JSON.
  assert.equal(pasted.redactPastedSecrets(`stored ${key} as OPENAI_KEY`), "stored [redacted] as OPENAI_KEY");
  const tricky = 'password: Tr0ub"4dor\\3x';
  pasted.scrubPastedText(tricky);
  const json = JSON.stringify({ text: `echo ${key} and Tr0ub"4dor\\3x` });
  const redacted = pasted.redactPastedSecrets(json, { json: true });
  assert.deepEqual(JSON.parse(redacted), { text: "echo [redacted] and [redacted]" }, "still valid JSON");
  assert.deepEqual(pasted.redactPastedSecretsIn({ a: [key] }), { a: ["[redacted]"] });
}

(async () => {
  memory = await load();
  const suites = { replacesCredentials, catchesEnvAndBearer, fewerFalsePositives, leavesProseAlone, idempotent, listsWhatItReplaced, pastedSecrets };
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
