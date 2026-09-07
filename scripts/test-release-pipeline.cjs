"use strict";

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const yaml = require("js-yaml");
const { createBundle, verifyBundle, hash } = require("./release-bundle.cjs");
const { publishBundle } = require("./publish-release-bundle.cjs");
const { releaseTag, sourceArtifact } = require("./release-github.cjs");

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codara-release-tests-"));
after(() => {
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
  fs.rmSync(temporary, { recursive: true, force: true });
});
const metadata = { version: "1.6.13", sha: "a".repeat(40), runId: "123" };

function fixture() {
  const root = fs.mkdtempSync(path.join(temporary, "case-"));
  const dist = path.join(root, "dist"), bundle = path.join(root, "bundle");
  fs.mkdirSync(dist);
  for (const name of ["Codara-1.6.13.dmg", "Codara-1.6.13.zip", "Codara-1.6.13.exe", "Codara-1.6.13.exe.blockmap"]) {
    fs.writeFileSync(path.join(dist, name), `binary contents of ${name}`);
  }
  for (const [name, binary] of [["latest.yml", "Codara-1.6.13.exe"], ["latest-mac.yml", "Codara-1.6.13.zip"]]) {
    const body = fs.readFileSync(path.join(dist, binary));
    fs.writeFileSync(path.join(dist, name), yaml.dump({ version: metadata.version,
      files: [{ url: binary, size: body.length, sha512: hash(body) }], path: binary, sha512: hash(body) }));
  }
  const manifest = createBundle(dist, bundle, metadata);
  return { dist, bundle, manifest };
}

function storageFixture() {
  const objects = new Map(), requests = [];
  let revision = 0, fail = () => false;
  const storage = async (method, name, body, headers = {}) => {
    requests.push({ method, name, headers });
    if (fail(method, name)) return { status: 503, headers: {}, body: Buffer.alloc(0) };
    const previous = objects.get(name);
    if (["GET", "HEAD"].includes(method)) return previous
      ? { status: 200, ...previous } : { status: 404, headers: {}, body: Buffer.alloc(0) };
    if ((headers["if-none-match"] === "*" && previous) ||
        (headers["if-match"] && headers["if-match"] !== previous?.headers.etag)) {
      return { status: 412, headers: {}, body: Buffer.alloc(0) };
    }
    objects.set(name, { body, headers: { ...headers, "content-length": String(body.length), etag: `"${++revision}"` } });
    return { status: 200, headers: {}, body: Buffer.alloc(0) };
  };
  return { storage, objects, requests, fail: (predicate) => { fail = predicate; } };
}

test("bundle seals both platforms, feeds and blockmaps with source identity", () => {
  const { bundle, manifest } = fixture();
  assert.deepEqual(verifyBundle(bundle, metadata), manifest);
  assert.ok(manifest.files.some((file) => file.name.endsWith(".blockmap")));
  assert.throws(() => verifyBundle(bundle, { runId: "999" }), /does not match/);
  assert.throws(() => verifyBundle(bundle, { sha: "b".repeat(40) }), /does not match/);
});

test("changed or extra artifacts cannot be published", () => {
  const { bundle } = fixture();
  fs.writeFileSync(path.join(bundle, "Codara-1.6.13.exe"), "changed");
  assert.throws(() => verifyBundle(bundle), /checksum mismatch/);
  fs.writeFileSync(path.join(bundle, "unexpected.exe"), "extra");
  assert.throws(() => verifyBundle(bundle), /Unexpected or missing/);
});

test("bundle creation rejects mismatching feed checksums and traversal", () => {
  const { dist } = fixture();
  const destination = path.join(path.dirname(dist), "invalid");
  fs.writeFileSync(path.join(dist, "Codara-1.6.13.exe"), "changed");
  assert.throws(() => createBundle(dist, destination, metadata), /Invalid feed checksum/);
  const feed = yaml.load(fs.readFileSync(path.join(dist, "latest.yml"), "utf8"));
  feed.files[0].url = "../outside.exe";
  fs.writeFileSync(path.join(dist, "latest.yml"), yaml.dump(feed));
  assert.throws(() => createBundle(dist, destination, metadata), /Unsafe artifact/);
});

test("a binary upload failure leaves both feeds untouched", async () => {
  const { bundle } = fixture(), remote = storageFixture();
  remote.fail((method, name) => method === "PUT" && name.endsWith(".exe"));
  await assert.rejects(publishBundle(bundle, remote.storage, metadata), /Upload/);
  assert.equal(remote.requests.some((r) => r.method === "PUT" && r.name.endsWith(".yml")), false);
});

test("partial publication resumes identical binaries and completes both feeds", async () => {
  const { bundle, manifest } = fixture(), remote = storageFixture();
  remote.fail((method, name) => method === "PUT" && name === "latest.yml");
  await assert.rejects(publishBundle(bundle, remote.storage, metadata), /Promote/);
  assert.ok(remote.objects.has("latest-mac.yml"));
  assert.ok(!remote.objects.has("latest.yml"));
  const before = new Map(remote.objects);
  remote.fail(() => false);
  await publishBundle(bundle, remote.storage, metadata);
  for (const file of manifest.files) assert.equal(hash(remote.objects.get(file.name).body), file.sha512);
  for (const [name, entry] of before) assert.equal(remote.objects.get(name), entry);
  const firstFeed = remote.requests.findIndex((r) => r.method === "PUT" && r.name.endsWith(".yml"));
  assert.ok(remote.requests.slice(0, firstFeed).filter((r) => r.method === "PUT").length >= 4);
  await publishBundle(bundle, remote.storage, metadata);
});

test("a newer feed aborts before any upload", async () => {
  const { bundle } = fixture(), remote = storageFixture();
  remote.objects.set("latest.yml", { body: Buffer.from("version: 1.7.0\n"), headers: { etag: '"new"' } });
  await assert.rejects(publishBundle(bundle, remote.storage, metadata), /roll back/);
  assert.ok(remote.requests.every((r) => r.method === "GET"));
});

test("same-version feed with different contents is not replaced", async () => {
  const { bundle } = fixture(), remote = storageFixture();
  remote.objects.set("latest.yml", { body: Buffer.from("version: 1.6.13\n"), headers: { etag: '"old"' } });
  await assert.rejects(publishBundle(bundle, remote.storage, metadata), /Published feed differs/);
});

test("existing binary without matching identity is not replaced", async () => {
  const { bundle } = fixture(), remote = storageFixture();
  const existing = { body: Buffer.from("different"), headers: { etag: '"existing"' } };
  remote.objects.set("Codara-1.6.13.exe", existing);
  await assert.rejects(publishBundle(bundle, remote.storage, metadata), /Refusing to overwrite/);
  assert.equal(remote.objects.get("Codara-1.6.13.exe"), existing);
  assert.ok(!remote.objects.has("latest.yml"));
});

test("feed promotion uses an ETag condition and fails if it changes", async () => {
  const { bundle } = fixture(), remote = storageFixture();
  for (const name of ["latest.yml", "latest-mac.yml"]) {
    remote.objects.set(name, { body: Buffer.from("version: 1.6.12\n"), headers: { etag: '"old"' } });
  }
  const storage = async (method, name, body, headers) => {
    if (method === "PUT" && name.endsWith(".yml")) {
      assert.equal(headers["if-match"], '"old"');
      remote.objects.get(name).headers.etag = '"concurrent"';
    }
    return remote.storage(method, name, body, headers);
  };
  await assert.rejects(publishBundle(bundle, storage, metadata), /HTTP 412/);
  assert.equal(remote.objects.get("latest-mac.yml").body.toString(), "version: 1.6.12\n");
});

function tagApi({ sha, newer = false, deny = false } = {}) {
  let ref = sha ? { object: { sha, type: "commit" } } : null;
  const calls = [];
  const api = async (route, method = "GET", body) => {
    calls.push({ route, method, body });
    if (route.startsWith("compare/")) return { status: "ahead" };
    if (route.startsWith("tags?")) return newer ? [{ name: "v1.6.14" }] : [];
    if (route.startsWith("git/ref/")) return ref;
    if (route === "git/refs") {
      if (deny) throw new Error("HTTP 403");
      ref = { object: { sha: body.sha, type: "commit" } };
      return ref;
    }
    throw new Error(`Unexpected request: ${route}`);
  };
  return { api, calls };
}

test("tagging is idempotent for the exact source commit", async () => {
  const { api, calls } = tagApi();
  await releaseTag(api, metadata, true);
  await releaseTag(api, metadata, true);
  await releaseTag(api, metadata, false);
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(calls.find((call) => call.method === "POST").body.sha, metadata.sha);
});

test("tag rejection, conflicting tag and superseded release fail closed", async () => {
  await assert.rejects(releaseTag(tagApi({ deny: true }).api, metadata, true), /403/);
  await assert.rejects(releaseTag(tagApi({ sha: "b".repeat(40) }).api, metadata, true), /different commit/);
  await assert.rejects(releaseTag(tagApi({ newer: true }).api, metadata, true), /newer release/);
  await assert.rejects(releaseTag(tagApi().api, metadata, false), /missing/);
  await assert.rejects(releaseTag(async () => ({ status: "diverged" }), metadata, true), /not on main/);
});

test("recovery accepts only the original main Release artifact", async () => {
  const run = { repository: { id: 42 }, head_repository: { id: 42 }, head_branch: "main",
    path: ".github/workflows/release.yml", event: "schedule", head_sha: metadata.sha };
  const artifact = { id: 57, name: "release-bundle", expired: false, workflow_run: { head_sha: metadata.sha } };
  const api = async (route) => route.includes("artifacts?") ? { artifacts: [artifact] } : run;
  assert.deepEqual(await sourceArtifact(api, "123", "42"), { sha: metadata.sha, artifactId: "57" });
  run.head_branch = "feature";
  await assert.rejects(sourceArtifact(api, "123", "42"), /main-branch/);
  run.head_branch = "main";
  run.event = "pull_request";
  await assert.rejects(sourceArtifact(api, "123", "42"), /main-branch/);
  run.event = "schedule";
  artifact.expired = true;
  await assert.rejects(sourceArtifact(api, "123", "42"), /unexpired/);
  await assert.rejects(sourceArtifact(api, "123; echo unsafe", "42"), /Invalid recovery/);
});

test("workflow isolates the App key and gates publication on a verified tag", () => {
  const workflow = yaml.load(fs.readFileSync(path.join(__dirname, "../.github/workflows/release.yml"), "utf8"));
  assert.deepEqual(workflow.on.schedule, [{ cron: "0 3 * * *" }]);
  assert.equal(workflow.on.pull_request_target, undefined);
  assert.equal(workflow.permissions.contents, "read");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.match(workflow.jobs.prepare.if, /refs\/heads\/main/);
  assert.equal(workflow.jobs.tag.environment, "release-tag");
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name !== "tag") assert.doesNotMatch(JSON.stringify(job), /RELEASE_APP_PRIVATE_KEY/);
    for (const step of job.steps) {
      if (step.uses?.startsWith("actions/checkout@")) assert.equal(step.with["persist-credentials"], false);
    }
  }
  assert.doesNotMatch(JSON.stringify(workflow.jobs.build), /RELEASES_S3_/);
  assert.match(workflow.jobs.publish.if, /needs\.tag\.result == 'success'/);
  assert.ok(workflow.jobs.build.steps.find((step) => step.with?.name === "release-bundle"));
  assert.match(JSON.stringify(workflow.jobs.prepare), /Re-run failed jobs/);
});
