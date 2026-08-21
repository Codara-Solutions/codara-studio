"use strict";

// Talk to the running Codara Studio app over its authenticated loopback
// socket. Discovery: read $CODARA_HOME_DIR/agent-socket.json (default
// ~/.Codara) for the URL + bearer token, then POST JSON-RPC to /rpc.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const { fail } = require("./ui.cjs");

function homeDir(flags = {}) {
  return (
    flags.home ||
    process.env.CODARA_HOME_DIR ||
    process.env.SPARK_HOME_DIR ||
    process.env.SPARK_USER_DATA_DIR ||
    path.join(os.homedir(), ".Codara")
  );
}

function readHandshake(flags) {
  const file = path.join(homeDir(flags), "agent-socket.json");
  let handshake;
  try {
    handshake = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(
      `Codara Studio isn't running — no socket handshake at ${file}\n` +
        "Open the app (contributors: `npm run dev`), or point --home / $CODARA_HOME_DIR at its home dir.",
    );
  }
  const url = typeof handshake?.url === "string" ? handshake.url : "";
  const token = typeof handshake?.token === "string" ? handshake.token : "";
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Malformed handshake file: ${file}`);
  }
  const port = Number(parsed.port);
  const safe =
    parsed.protocol === "http:" &&
    parsed.hostname === "127.0.0.1" &&
    parsed.pathname === "/" &&
    !parsed.search &&
    !parsed.hash &&
    Number.isInteger(port) &&
    port >= 1 &&
    port <= 65535 &&
    /^[a-f0-9]{64}$/i.test(token);
  if (!safe) throw new Error(`Unsafe or malformed handshake file: ${file}`);
  return { port, token };
}

/** Raw JSON-RPC request. Resolves to the full {result} / {error} envelope. */
async function rpcRaw(flags, method, params, { timeoutMs } = {}) {
  const { port, token } = readHandshake(flags);
  const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? {} });
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/rpc",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`non-JSON response (HTTP ${res.statusCode}): ${data.slice(0, 200)}`));
          }
        });
      },
    );
    if (timeoutMs) {
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`${method} got no response after ${Math.round(timeoutMs / 1000)}s`));
      });
    }
    req.on("error", (err) => reject(new Error(`cannot reach Codara Studio: ${err.message}`)));
    req.end(payload);
  });
}

/** JSON-RPC request that fails the CLI on an error envelope. Resolves to result. */
async function rpc(flags, method, params, opts) {
  const res = await rpcRaw(flags, method, params, opts).catch((err) => fail(err.message));
  if (res.error) fail(`${method}: ${res.error.message ?? JSON.stringify(res.error)}`);
  return res.result;
}

module.exports = { homeDir, rpc, rpcRaw };
