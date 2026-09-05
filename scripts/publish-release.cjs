#!/usr/bin/env node
// Publish built installers + electron-updater feed files to the private R2
// bucket behind https://studio.codarasolutions.com/releases.
//
//   node scripts/publish-release.cjs mac   # after package:mac
//   node scripts/publish-release.cjs win   # after package:win
//   (or: npm run release:mac / release:win — builds then publishes)
//
// Credentials come from .env.releases in the repo root (gitignored) or the
// environment: RELEASES_BUCKET, RELEASES_S3_ENDPOINT, RELEASES_S3_REGION,
// RELEASES_S3_ACCESS_KEY_ID, RELEASES_S3_SECRET_ACCESS_KEY.
//
// Zero dependencies on purpose — AWS SigV4 is implemented with node:crypto so
// publishing never depends on dev tooling being installed.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");

const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");

// --------------------------------------------------------------------------
// env
// --------------------------------------------------------------------------

function loadEnvFile() {
  const file = path.join(ROOT, ".env.releases");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnvFile();

const BUCKET = process.env.RELEASES_BUCKET;
const ENDPOINT = process.env.RELEASES_S3_ENDPOINT;
const REGION = process.env.RELEASES_S3_REGION || "auto";
const ACCESS_KEY = process.env.RELEASES_S3_ACCESS_KEY_ID;
const SECRET_KEY = process.env.RELEASES_S3_SECRET_ACCESS_KEY;

if (!BUCKET || !ENDPOINT || !ACCESS_KEY || !SECRET_KEY) {
  console.error(
    "Missing release credentials. Provide RELEASES_BUCKET / RELEASES_S3_ENDPOINT /\n" +
      "RELEASES_S3_ACCESS_KEY_ID / RELEASES_S3_SECRET_ACCESS_KEY via env or .env.releases",
  );
  process.exit(1);
}

// --------------------------------------------------------------------------
// artifact selection
// --------------------------------------------------------------------------

const platform = process.argv[2];
if (platform !== "mac" && platform !== "win") {
  console.error("Usage: publish-release.cjs <mac|win>");
  process.exit(1);
}

const patterns =
  platform === "mac"
    ? [/^latest-mac\.yml$/, /\.dmg$/, /\.dmg\.blockmap$/, /-mac\.zip$/, /\.zip\.blockmap$/, /\.zip$/]
    : [/^latest\.yml$/, /\.exe$/, /\.exe\.blockmap$/];

const files = fs
  .readdirSync(DIST)
  .filter((name) => patterns.some((p) => p.test(name)))
  .filter((name) => fs.statSync(path.join(DIST, name)).isFile());

if (files.length === 0) {
  console.error(`No ${platform} artifacts found in dist/ — run the package script first.`);
  process.exit(1);
}

// Feed ymls last: clients only see the new version once every binary it
// points at is already uploaded, so a mid-upload check can never 404.
files.sort((a, b) => Number(a.endsWith(".yml")) - Number(b.endsWith(".yml")));

// --------------------------------------------------------------------------
// SigV4 PUT
// --------------------------------------------------------------------------

const endpoint = new URL(ENDPOINT);

function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest();
}
function sha256hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function contentTypeFor(name) {
  if (name.endsWith(".yml")) return "text/yaml";
  if (name.endsWith(".dmg")) return "application/x-apple-diskimage";
  if (name.endsWith(".zip")) return "application/zip";
  if (name.endsWith(".exe")) return "application/vnd.microsoft.portable-executable";
  return "application/octet-stream";
}

function putObject(key, body, contentType) {
  return new Promise((resolve, reject) => {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256hex(body);

    // Path-style addressing: /<bucket>/<key>. Keys contain only safe chars
    // (enforced below), but spaces still need escaping.
    const canonicalUri = `/${BUCKET}/${key}`.replace(/[^A-Za-z0-9\-._~/]/g, (c) =>
      `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
    );

    const headers = {
      host: endpoint.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      "content-type": contentType,
      "content-length": String(body.length),
    };
    const signedHeaderNames = ["host", "x-amz-content-sha256", "x-amz-date"];
    const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headers[h]}\n`).join("");
    const signedHeaders = signedHeaderNames.join(";");

    const canonicalRequest = [
      "PUT",
      canonicalUri,
      "",
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");

    const scope = `${dateStamp}/${REGION}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join(
      "\n",
    );

    const kDate = hmac(`AWS4${SECRET_KEY}`, dateStamp);
    const kRegion = hmac(kDate, REGION);
    const kService = hmac(kRegion, "s3");
    const kSigning = hmac(kService, "aws4_request");
    const signature = crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex");

    headers.authorization =
      `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const req = https.request(
      { host: endpoint.host, path: canonicalUri, method: "PUT", headers },
      (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve();
          else reject(new Error(`PUT ${key} -> ${res.statusCode}: ${out.slice(0, 300)}`));
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

// --------------------------------------------------------------------------
// run
// --------------------------------------------------------------------------

(async () => {
  console.log(`Publishing ${files.length} ${platform} artifact(s) to ${BUCKET}/releases/\n`);
  for (const name of files) {
    if (!/^[A-Za-z0-9._ +-]+$/.test(name)) {
      throw new Error(`refusing to upload artifact with unexpected name: ${name}`);
    }
    const body = fs.readFileSync(path.join(DIST, name));
    const mb = (body.length / (1024 * 1024)).toFixed(1);
    process.stdout.write(`  ${name} (${mb} MB)… `);
    await putObject(`releases/${name}`, body, contentTypeFor(name));
    console.log("ok");
  }
  try {
    const notified = await require("./notify-release.cjs").notifyRelease();
    console.log(notified ? "Release event delivered." : "Published. The website will discover the feed within a minute.");
  } catch (err) {
    console.warn(`Published; immediate notification failed (${err.message}). The website poll will retry.`);
  }
})().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});
