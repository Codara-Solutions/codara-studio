"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { FEEDS, verifyBundle, hash, feedVersion, compareVersions } = require("./release-bundle.cjs");
const { createStorage } = require("./release-storage.cjs");

async function feedState(storage, file, version) {
  const current = await storage("GET", file.name);
  if (current.status === 404) return { "if-none-match": "*" };
  if (current.status !== 200) throw new Error(`Cannot read ${file.name}: HTTP ${current.status}`);
  const order = compareVersions(feedVersion(current.body), version);
  if (order > 0) throw new Error(`Refusing to roll back ${file.name}`);
  if (order === 0) {
    if (hash(current.body) !== file.sha512) throw new Error(`Published feed differs for v${version}: ${file.name}`);
    return null;
  }
  if (!current.headers.etag) throw new Error(`Missing ETag for ${file.name}`);
  return { "if-match": current.headers.etag };
}

async function publishBundle(dir, storage, expected) {
  const manifest = verifyBundle(dir, expected);
  const feeds = manifest.files.filter((file) => FEEDS.includes(file.name));
  const binaries = manifest.files.filter((file) => !FEEDS.includes(file.name));
  for (const file of feeds) await feedState(storage, file, manifest.version);
  for (const file of binaries) {
    const result = await storage("PUT", file.name, fs.readFileSync(path.join(dir, file.name)), {
      "if-none-match": "*", "x-amz-meta-sha512": file.sha512,
      "content-type": file.name.endsWith(".dmg") ? "application/x-apple-diskimage" :
        file.name.endsWith(".zip") ? "application/zip" : "application/octet-stream",
    });
    if (result.status === 412) {
      const existing = await storage("HEAD", file.name);
      if (existing.status !== 200 || existing.headers["x-amz-meta-sha512"] !== file.sha512 ||
          Number(existing.headers["content-length"]) !== file.size) {
        throw new Error(`Refusing to overwrite an existing artifact: ${file.name}`);
      }
    } else if (result.status < 200 || result.status >= 300) throw new Error(`Upload ${file.name}: HTTP ${result.status}`);
    console.log(`Verified uploaded artifact: ${file.name}`);
  }
  for (const file of feeds) {
    // Re-read before promotion: a manual publisher may have changed the feed during upload.
    const condition = await feedState(storage, file, manifest.version);
    if (!condition) continue;
    const result = await storage("PUT", file.name, fs.readFileSync(path.join(dir, file.name)), {
      ...condition, "content-type": "text/yaml", "cache-control": "no-cache",
    });
    if (result.status < 200 || result.status >= 300) throw new Error(`Promote ${file.name}: HTTP ${result.status}; resume the saved release`);
    console.log(`Published ${file.name}`);
  }
  return manifest;
}

module.exports = { publishBundle };

if (require.main === module) {
  (async () => {
    await publishBundle(process.argv[2] || "release-bundle", createStorage(), {
      sha: process.env.RELEASE_SHA, runId: process.env.RELEASE_RUN_ID,
    });
    try { await require("./notify-release.cjs").notifyRelease(); }
    catch { console.warn("Published; immediate notification failed. The website feed poll will retry."); }
  })().catch((err) => { console.error(err.message); process.exitCode = 1; });
}
