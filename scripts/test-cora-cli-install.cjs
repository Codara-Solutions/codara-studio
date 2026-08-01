#!/usr/bin/env node
// Structural contract for the packaged, app-managed Cora CLI. The behavioral
// CLI transport suite lives in test-cora-cli.cjs; this suite guards the
// privileged packaging/install/ownership wiring without mutating the machine.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
let failures = 0;

function check(name, condition) {
  console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
  if (!condition) failures += 1;
}

const pkg = JSON.parse(read("package.json"));
const installer = read("src/main/cora-cli-install.ts");
const shared = read("src/shared/cora-cli.ts");
const ipc = read("src/main/ipc.ts");
const preload = read("src/preload/index.ts");
const settings = read("src/renderer/src/components/SettingsDialog.tsx");
const atomic = read("src/main/fs-atomic.ts");
const home = read("src/main/spark-home.ts");
const socket = read("src/main/agent-socket.ts");
const cli = read("bin/cora.cjs");

const resource = pkg.build.extraResources.find(
  (entry) => typeof entry === "object" && entry.to === "cora-cli/cora.cjs",
);
check("packaged build includes the CLI payload", resource?.from === "bin/cora.cjs");
check("installer records a random ownership id", /randomUUID\(\)/.test(installer));
check("launcher embeds an ownership marker", /OWNER_MARKER/.test(installer));
check("foreign commands are never overwritten", /Refusing to overwrite/.test(installer));
check("symlink launchers are not accepted as owned", /isSymbolicLink\(\)/.test(installer));
check("uninstall requires manifest and launcher ownership", /launcherOwnedBy/.test(installer));
check("Linux AppImage uses the durable outer executable", /process\.env\.APPIMAGE/.test(installer));
check("POSIX wrapper preserves argument boundaries", /"\$@"/.test(installer));
check("launcher and manifest are atomic writes", /writeFileAtomic\(p\.launcher/.test(installer) && /writeFileAtomic\(p\.manifest/.test(installer));
check("manifest is owner-readable only", /p\.manifest[\s\S]*mode: 0o600/.test(installer));
check("shared status distinguishes conflict and repair", /"needs-repair"/.test(shared) && /"conflict"/.test(shared));
check("trusted IPC exposes status/install/uninstall", /cora-cli:status/.test(ipc) && /cora-cli:install/.test(ipc) && /cora-cli:uninstall/.test(ipc));
check("preload exposes the bounded CLI surface", /coraCli:\s*\{/.test(preload));
check("Settings exposes install and uninstall controls", /CommandLineSettings/.test(settings) && /Uninstall command/.test(settings));
check(
  "Settings explains agent-to-agent orchestration",
  /start Cora sessions and spawn or steer sibling workers/.test(settings) &&
    /cora start "Fix the failing tests" --cwd \. --wait/.test(settings) &&
    /cora agent spawn <run>/.test(settings) &&
    /cora agent message <run> all/.test(settings),
);
check("atomic writes support exact creation modes", /options\?: \{ mode\?: number \}/.test(atomic) && /handle\.chmod/.test(atomic));
check("Codara home is owner-only on POSIX", /chmodSync\(dir, 0o700\)/.test(home));
check("socket handshake is written mode 0600", /handshakeFilePath\(\), payload, \{ mode: 0o600 \}/.test(socket));
check("CLI accepts only 127.0.0.1 handshakes", /parsed\.hostname !== "127\.0\.0\.1"/.test(cli));
check("CLI requires a 64-character bearer token", /\^\[a-f0-9\]\{64\}\$/.test(cli));

if (failures) {
  console.error(`\n${failures} Cora CLI install check(s) failed.`);
  process.exit(1);
}
console.log("\nAll Cora CLI install checks passed.");
