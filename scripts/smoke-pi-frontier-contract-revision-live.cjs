#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

if (process.env.CODARA_ALLOW_LIVE_PI_SMOKE !== "1") {
  console.error("Refusing live subscription inference without CODARA_ALLOW_LIVE_PI_SMOKE=1");
  process.exit(2);
}

const productRoot = path.resolve(__dirname, "..");
const buildDir = fs.mkdtempSync(path.join(productRoot, ".codara-frontier-contract-revision-entry-"));
const output = path.join(buildDir, "main.cjs");
try {
  esbuild.buildSync({
    entryPoints: [path.join(__dirname, "smoke-pi-frontier-contract-revision-live.ts")],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    packages: "external",
    external: ["electron"],
    sourcemap: "inline",
    tsconfig: path.join(productRoot, "tsconfig.node.json"),
    logLevel: "warning",
  });
  const electron = require("electron");
  const env = {
    ...process.env,
    CODARA_PI_SMOKE_NODE: process.execPath,
    CODARA_PI_SMOKE_PRODUCT_ROOT: productRoot,
    ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
    NODE_PATH: [path.join(productRoot, "node_modules"), process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnSync(electron, [output, "--no-sandbox"], {
    cwd: productRoot,
    env,
    stdio: "inherit",
  });
  if (child.error) throw child.error;
  process.exitCode = child.status === null ? 1 : child.status;
} finally {
  fs.rmSync(buildDir, { recursive: true, force: true });
}
