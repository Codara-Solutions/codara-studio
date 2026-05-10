// Hidden gate 02: storage.ts exports `getAppSettings` with the right shape.
//
// We require the new name to be (a) exported from storage.ts via a
// `export async function getAppSettings` declaration (or `export
// function getAppSettings` with a Promise return), (b) callable as a
// zero-arg async function. We can't easily compile-and-load
// storage.ts because it imports Electron's `app`, which doesn't load
// outside an Electron host — so we stick to source-text checks.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SOURCE_PATH = "src/main/storage.ts";

module.exports = {
  id: "02-new-name-exported",
  description:
    "storage.ts exports `getAppSettings` as an async function returning Promise<AppSettings>",
  async run({ finalRepoPath }) {
    const abs = path.join(finalRepoPath, SOURCE_PATH);
    if (!fs.existsSync(abs)) {
      return { ok: false, message: `source file missing: ${SOURCE_PATH}` };
    }
    const text = fs.readFileSync(abs, "utf8");
    const decl = text.match(
      /export\s+async\s+function\s+getAppSettings\s*\(\s*\)\s*:\s*Promise\s*<\s*AppSettings\s*>/,
    );
    if (!decl) {
      // Tolerate a slightly broader signature too: explicit annotation
      // can vary (e.g. the agent might write `Promise<Readonly<AppSettings>>`).
      const broader = text.match(
        /export\s+async\s+function\s+getAppSettings\s*\(\s*\)\s*:\s*Promise\s*<[^>]+>/,
      );
      if (!broader) {
        return {
          ok: false,
          message:
            "no `export async function getAppSettings(): Promise<...>` declaration in storage.ts",
        };
      }
    }
    return { ok: true, message: "getAppSettings exported with expected shape" };
  },
};
