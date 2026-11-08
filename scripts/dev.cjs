#!/usr/bin/env node
"use strict";

// `npm run dev`: electron-vite with the harmless Chromium "Frame latency is
// negative" lines removed from stderr (see dev-log-filter.cjs). Only stderr is
// piped, so stdin and stdout stay on the terminal. A TTY stderr would lose its
// colours once piped, so FORCE_COLOR keeps them. Exit code and signals pass
// through. Dev only: packaged builds never run this.
const { spawn } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const { createLineFilter } = require("./dev-log-filter.cjs");

// The package's exports map hides bin/, so find it through package.json.
const pkgPath = require.resolve("electron-vite/package.json");
const pkg = require(pkgPath);
const bin = path.resolve(path.dirname(pkgPath), typeof pkg.bin === "string" ? pkg.bin : pkg.bin["electron-vite"]);
const env = { ...process.env };
if (process.stderr.isTTY && !env.NO_COLOR && !env.FORCE_COLOR) env.FORCE_COLOR = "1";

const child = spawn(process.execPath, [bin, "dev", ...process.argv.slice(2)], {
  stdio: ["inherit", "inherit", "pipe"],
  env,
});

const filter = createLineFilter((text) => process.stderr.write(text));
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => filter.push(chunk));

// The terminal already sends Ctrl+C to the whole foreground group; forwarding
// keeps the child informed when the signal reaches only this process.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  });
}

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
child.on("close", (code, signal) => {
  filter.flush();
  process.exitCode = code ?? 128 + (os.constants.signals[signal] || 0);
});
