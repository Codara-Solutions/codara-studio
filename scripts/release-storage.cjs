"use strict";

const crypto = require("node:crypto");
const https = require("node:https");

function createStorage(env = process.env) {
  const { RELEASES_BUCKET: bucket, RELEASES_S3_ENDPOINT: endpointUrl,
    RELEASES_S3_ACCESS_KEY_ID: accessKey, RELEASES_S3_SECRET_ACCESS_KEY: secretKey } = env;
  const region = env.RELEASES_S3_REGION || "auto";
  if (!bucket || !endpointUrl || !accessKey || !secretKey) throw new Error("Release bucket credentials are missing");
  const endpoint = new URL(endpointUrl);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.pathname !== "/") {
    throw new Error("Release storage requires an HTTPS origin");
  }
  const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();
  const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

  return (method, name, body = Buffer.alloc(0), extraHeaders = {}) => new Promise((resolve, reject) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._ +-]*$/.test(name)) return reject(new Error("Invalid storage key"));
    const uri = `/${bucket}/releases/${name}`.split("/").map(encodeURIComponent).join("/");
    const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const day = timestamp.slice(0, 8);
    const headers = { host: endpoint.host, "x-amz-date": timestamp, "x-amz-content-sha256": sha256(body), ...extraHeaders };
    const keys = Object.keys(headers).sort();
    const signedHeaders = keys.join(";");
    const canonical = [method, uri, "", keys.map((key) => `${key}:${headers[key]}\n`).join(""), signedHeaders, sha256(body)].join("\n");
    const scope = `${day}/${region}/s3/aws4_request`;
    const key = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, day), region), "s3"), "aws4_request");
    const signature = crypto.createHmac("sha256", key).update(`AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${sha256(canonical)}`).digest("hex");
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    if (method === "PUT") headers["content-length"] = String(body.length);
    const req = https.request({ hostname: endpoint.hostname, port: endpoint.port || 443, path: uri, method, headers }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) res.destroy(new Error("Unexpectedly large storage response"));
        else chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(120_000, () => req.destroy(new Error("Release storage request timed out")));
    req.on("error", reject);
    req.end(body);
  });
}

module.exports = { createStorage };
