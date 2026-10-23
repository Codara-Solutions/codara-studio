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
  // A key that ends a sentence; a file name made of one is left alone.
  const token = "Zq8Xw2Lp9Rt4Vb7Nm3Kd6Hf1Gj5Sc0YaQ7pW2xK";
  assert.equal(scrub(`use ${token}.`), "use [redacted].");
  assert.equal(scrub(`use ${token}. Then deploy.`), "use [redacted]. Then deploy.");
  assert.equal(scrub(`open ${token}.json`), `open ${token}.json`);
}

// A path keeps its folders: only an opaque piece of it is replaced.
function pathsKeepTheirFolders() {
  const token = "Zq8Xw2Lp9Rt4Vb7Nm3Kd6Hf1Gj5Sc0YaQ7pW2xK";
  assert.equal(scrub(`file at /home/u/uploads/${token}/report`), "file at /home/u/uploads/[redacted]/report");
  assert.equal(scrub(`file at /home/u/uploads/${token}/report.txt`), "file at /home/u/uploads/[redacted]/report.txt");
  assert.equal(scrub(`file at uploads/${token}/report`), "file at uploads/[redacted]/report");
  assert.equal(scrub(`file at /tmp/${token}`), "file at /tmp/[redacted]");
  assert.equal(scrub(`cd ~/keys/${token} now`), "cd ~/keys/[redacted] now");
  assert.deepEqual(memory.secretsIn(`file at /tmp/${token}`), [token]);
  const plainPath = "/home/u/Documents/codara-studio2/src/main/orchestration/run-store.ts";
  assert.equal(scrub(`open ${plainPath}`), `open ${plainPath}`);
  assert.equal(scrub(scrub(`file at /tmp/${token}`)), "file at /tmp/[redacted]");
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
    "run id is 4532015112830366",
    "order_id=4532015112830366",
    "the task ID: 4532015112830366 failed",
  ]) {
    assert.equal(scrub(plain), plain, plain);
  }
  // Card numbers still go: Visa, Amex and Mastercard test numbers.
  assert.equal(scrub("visa 4012888888881881"), "visa [redacted]");
  assert.equal(scrub("amex 378282246310005"), "amex [redacted]");
  assert.equal(scrub("mc 5555-5555-5555-4444 ok"), "mc [redacted] ok");
  assert.ok(!memory.containsSecret("Discord channel 1296016829456515086"), "a Discord id is not a card");
  assert.ok(memory.containsSecret("card 4012888888881881"));
  // A number labelled as an id is one, even when it passes Luhn.
  assert.ok(!memory.containsSecret("run id is 4532015112830366"));
  assert.equal(scrub("card 4532015112830366, run id 7"), "card [redacted], run id 7");
  assert.equal(scrub("paid 4532015112830366 for the valid run"), "paid [redacted] for the valid run");
  assert.equal(scrub("a short icon data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk ok"), "a short icon data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk ok");
  // Quotes around a value stay, so a pasted config line still reads as one.
  assert.equal(scrub("SECRET_TOKEN: 'aB3dEf9hIjK2'"), "SECRET_TOKEN: '[redacted]'");
  assert.equal(scrub('password="Tr0ub4dor&3",'), 'password="[redacted]",');
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
  "SECRET_TOKEN: 'aB3dEf9hIjK2'",
  'password="Tr0ub4dor&3",',
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
  const other = "sk-proj-Ab1Xw2Lp9Rt4Vb7Nm3Kd6Hf1Gj5Sc0Yb";
  const raw = `  deploy with ${key} please `;
  const stored = pasted.scrubPastedText(raw, "run-a");
  assert.equal(stored, "  deploy with [redacted] please ");
  assert.equal(pasted.scrubPastedText("no key here", "run-a"), "no key here");
  assert.equal(pasted.livePastedText("run-a", "deploy with [redacted] please"), raw.trim(), "the live prompt gets the raw text");

  // Another chat's identical-looking message never gets this chat's key.
  pasted.scrubPastedText(`deploy with ${other} please`, "run-b");
  assert.equal(pasted.livePastedText("run-a", "deploy with [redacted] please"), raw.trim());
  assert.equal(pasted.livePastedText("run-b", "deploy with [redacted] please"), `deploy with ${other} please`);
  assert.equal(pasted.withPastedText("run-c", "Task:\ndeploy with [redacted] please\n").used.length, 0, "a third chat gets nothing");

  // A new chat's first message is scrubbed before its run exists; the run
  // claims it when the message is stored (already scrubbed).
  const first = pasted.scrubPastedText(`rotate ${key} now`);
  assert.equal(pasted.scrubPastedText(first, "run-new"), first);
  assert.equal(pasted.livePastedText("run-new", first), `rotate ${key} now`);
  assert.equal(pasted.livePastedText("", first), undefined, "claimed once");

  // A direct-lane worker prompt read back from disk: the newest copy is
  // this turn's message, an older copy is history and stays scrubbed.
  const prompt = `History:\nuser: deploy with [redacted] please\n\nTask:\ndeploy with [redacted] please\n`;
  const live = pasted.withPastedText("run-a", prompt);
  assert.equal(live.prompt, `History:\nuser: deploy with [redacted] please\n\nTask:\n${raw.trim()}\n`);
  assert.deepEqual(live.used, ["deploy with [redacted] please"]);
  pasted.forgetPastedText("run-a", live.used);
  assert.equal(pasted.livePastedText("run-a", "deploy with [redacted] please"), undefined, "once delivered, gone");
  assert.equal(pasted.withPastedText("run-a", prompt).prompt, prompt, "a relaunch reads the scrubbed text");

  pasted.scrubPastedText(`x ${key.replace("Zq8", "Cd3")}`, "run-t", 1_000);
  assert.ok(pasted.livePastedText("run-t", "x [redacted]", 1_000 + 60_000), "kept for the turn");
  assert.equal(pasted.livePastedText("run-t", "x [redacted]", 1_000 + 2 * 60 * 60 * 1000), undefined, "dropped after an hour");

  // The model repeating the key, in text and in the values of JSON it
  // writes, in the run the key was pasted into.
  assert.equal(pasted.redactPastedSecrets("run-a", `stored ${key} as OPENAI_KEY`), "stored [redacted] as OPENAI_KEY");
  const tricky = 'password: Tr0ub"4dor\\3x';
  pasted.scrubPastedText(tricky, "run-a");
  const value = { text: `echo ${key} and Tr0ub"4dor\\3x` };
  assert.deepEqual(JSON.parse(JSON.stringify(pasted.redactPastedSecretsIn("run-a", value))), { text: "echo [redacted] and [redacted]" });
  assert.deepEqual(pasted.redactPastedSecretsIn("run-a", { a: [key] }), { a: ["[redacted]"] });
  assert.equal(pasted.redactPastedSecretsIn("run-a", value.text), "echo [redacted] and [redacted]");
  const untouched = { a: ["nothing"] };
  assert.equal(pasted.redactPastedSecretsIn("run-a", untouched), untouched, "the same value when nothing changed");
  // The first message's keys go to the run that claims it.
  assert.equal(pasted.redactPastedSecrets("run-new", `again ${key}`), "again [redacted]");

  // Numbers and short values are not remembered as keys.
  assert.equal(pasted.scrubPastedText("set max token: 128000 and date: 2026-10-23", "run-a"), "set max token: 128000 and date: 2026-10-23");
  pasted.scrubPastedText("pwd: ab12cd", "run-a");
  const settings = { contextWindow: 128000, at: "2026-10-23", note: "ab12cd stays" };
  assert.equal(pasted.redactPastedSecretsIn("run-a", settings), settings);
}

// The scrubber can take an ordinary word for a key: "token: codara-studio2"
// is the user's folder name. Remembering it must not rewrite another run, a
// JSON key, or a folder or id field of the run it was typed in.
async function pastedSecretsStayInTheirRun() {
  const pasted = await loadPasted();
  assert.equal(pasted.scrubPastedText("token: codara-studio2", "run-typed"), "token: [redacted]");
  const otherRun = {
    id: "run-other",
    cwd: "/home/u/Documents/codara-studio2",
    files: { "codara-studio2": { note: "codara-studio2 builds" } },
    messages: [{ message: "open codara-studio2" }],
  };
  assert.equal(pasted.redactPastedSecretsIn("run-other", otherRun), otherRun, "another run is never rewritten");
  assert.equal(pasted.redactPastedSecrets("run-other", "cd codara-studio2"), "cd codara-studio2");
  assert.equal(pasted.redactPastedSecretsIn(undefined, otherRun), otherRun);

  const ownRun = {
    id: "run-typed",
    cwd: "/home/u/Documents/codara-studio2",
    workspaceId: "codara-studio2",
    worktreePath: "/w/codara-studio2",
    meta: { "codara-studio2": 1 },
    messages: [{ message: "the model said codara-studio2", createdAt: "codara-studio2" }],
  };
  const written = pasted.redactPastedSecretsIn("run-typed", ownRun);
  assert.equal(written.cwd, ownRun.cwd, "cwd stays");
  assert.equal(written.workspaceId, ownRun.workspaceId, "ids stay");
  assert.equal(written.worktreePath, ownRun.worktreePath, "paths stay");
  assert.deepEqual(Object.keys(written.meta), ["codara-studio2"], "JSON keys stay");
  assert.equal(written.messages[0].message, "the model said [redacted]", "text the run writes is redacted");
  assert.equal(written.messages[0].createdAt, "codara-studio2", "times stay");
}

(async () => {
  memory = await load();
  const suites = { replacesCredentials, catchesEnvAndBearer, pathsKeepTheirFolders, fewerFalsePositives, leavesProseAlone, idempotent, listsWhatItReplaced, pastedSecrets, pastedSecretsStayInTheirRun };
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
