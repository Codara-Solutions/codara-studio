// The Codara extension for Firefox's unit tests (extensions/firefox/test/),
// in the test registry: the pages Firefox keeps extensions off, the protocol
// commands its hello lists, the manifest, and the assembly that takes the
// shared files from extensions/chrome without changing them.
//
//   node scripts/test-firefox-extension.mjs

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync(process.execPath, [join(root, "extensions", "firefox", "test", "run.mjs")], { stdio: "inherit" });
process.exitCode = result.status ?? 1;
