#!/usr/bin/env node
"use strict";

// codara-pane: open a terminal over the Codara pane this runs in, or in a new
// tab of that pane's workspace. Codara exports SPARK_PANE_SOCKET and
// SPARK_PANE_TOKEN into each of its terminals; the token is good for this one
// request kind and always names the pane it was minted for, so the helper
// cannot reach any other pane or any other part of the app. Codara puts the
// `codara-pane` wrapper (<codaraHome>/integrations/bin) on PATH in its own
// panes only; nothing is installed into the user's shell setup.

const http = require("node:http");

const USAGE = `Usage:
  codara-pane overlay [--cwd DIR] [--title TEXT] [--] COMMAND [ARG...]
  codara-pane tab [--cwd DIR] [--title TEXT] [--] [COMMAND [ARG...]]
  codara-pane overlay|tab ... -c 'SHELL COMMAND LINE'

overlay  covers this pane with a terminal running COMMAND; it has the
         keyboard while open and closes when COMMAND exits.
tab      opens a new terminal tab beside this pane, running COMMAND if given.

Prints the new terminal's pane id. Exit status: 0 opened, 1 Codara refused
or is unreachable, 2 usage error, 3 not inside a Codara terminal.`;

const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const EXIT_NOT_IN_PANE = 3;
const REQUEST_TIMEOUT_MS = 30_000;

class UsageError extends Error {}

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  if (mode === "-h" || mode === "--help" || mode === "help") return { help: true };
  if (mode !== "overlay" && mode !== "tab") {
    throw new UsageError(mode ? `unknown mode '${mode}'` : "missing mode");
  }
  const options = { mode, argv: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--") {
      options.argv = rest.slice(i + 1);
      break;
    }
    const takesValue = arg === "--cwd" || arg === "--title" || arg === "-c" || arg === "--command";
    if (takesValue) {
      if (i + 1 >= rest.length) throw new UsageError(`${arg} needs a value`);
      const value = rest[(i += 1)];
      if (arg === "--cwd") options.cwd = value;
      else if (arg === "--title") options.title = value;
      else options.command = value;
      continue;
    }
    if (arg.startsWith("-") && options.argv.length === 0 && arg !== "-") {
      throw new UsageError(`unknown option '${arg}'`);
    }
    options.argv = rest.slice(i);
    break;
  }
  if (options.command !== undefined && options.argv.length > 0) {
    throw new UsageError("give either -c COMMAND_LINE or COMMAND [ARG...], not both");
  }
  if (mode === "overlay" && options.command === undefined && options.argv.length === 0) {
    throw new UsageError("overlay needs a command to run");
  }
  return options;
}

// Panes run the user's shell, a POSIX one everywhere but Windows.
function quoteArg(arg, platform = process.platform) {
  if (platform === "win32") {
    return /^[A-Za-z0-9_@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`;
  }
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

function commandLine(options, platform = process.platform) {
  if (options.command !== undefined) return options.command;
  return options.argv.map((arg) => quoteArg(arg, platform)).join(" ");
}

function paneConnection(env = process.env) {
  const socket = (env.SPARK_PANE_SOCKET || "").trim();
  const token = (env.SPARK_PANE_TOKEN || "").trim();
  if (!socket || !token) return null;
  let url;
  try {
    url = new URL(socket);
  } catch {
    return null;
  }
  const port = Number(url.port);
  const safe =
    url.protocol === "http:" &&
    url.hostname === "127.0.0.1" &&
    Number.isInteger(port) &&
    port >= 1 &&
    port <= 65535 &&
    /^[a-f0-9]{64}$/.test(token);
  return safe ? { port, token } : null;
}

function request(connection, method, params) {
  const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: connection.port,
        path: "/rpc",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Authorization: `Bearer ${connection.token}`,
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode === 401) {
            reject(new Error("Codara did not accept this pane's credential (was Codara restarted?)"));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`unexpected reply from Codara (HTTP ${res.statusCode})`));
          }
        });
      },
    );
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error("Codara did not answer in time")));
    req.on("error", reject);
    req.end(payload);
  });
}

async function main(argv = process.argv.slice(2), io = { env: process.env, cwd: process.cwd(), stdout: process.stdout, stderr: process.stderr }) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    io.stderr.write(`codara-pane: ${err.message}\n\n${USAGE}\n`);
    return EXIT_USAGE;
  }
  if (options.help) {
    io.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const connection = paneConnection(io.env);
  if (!connection) {
    io.stderr.write("codara-pane: not inside a Codara Studio terminal\n");
    return EXIT_NOT_IN_PANE;
  }
  const command = commandLine(options);
  const params = {
    mode: options.mode,
    cwd: options.cwd ?? io.cwd,
    ...(command ? { command } : {}),
    ...(options.title ? { title: options.title } : {}),
  };
  let response;
  try {
    response = await request(connection, "pane.open", params);
  } catch (err) {
    io.stderr.write(`codara-pane: ${err.message}\n`);
    return EXIT_FAILED;
  }
  if (response && response.error) {
    io.stderr.write(`codara-pane: ${response.error.message || "Codara refused the request"}\n`);
    return EXIT_FAILED;
  }
  const paneId = response && response.result && response.result.paneId;
  if (typeof paneId !== "string") {
    io.stderr.write("codara-pane: unexpected reply from Codara\n");
    return EXIT_FAILED;
  }
  io.stdout.write(`${paneId}\n`);
  return 0;
}

module.exports = { parseArgs, quoteArg, commandLine, paneConnection, main, USAGE };

if (require.main === module) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`codara-pane: ${err && err.message ? err.message : err}\n`);
      process.exitCode = EXIT_FAILED;
    },
  );
}
