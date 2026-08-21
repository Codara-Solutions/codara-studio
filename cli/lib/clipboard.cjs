"use strict";

// Keep terminal clipboard access tiny and dependency-free. Each command reads
// the value from stdin, so run ids never pass through a shell or process args.

const { spawnSync } = require("node:child_process");

function clipboardCommands(platform = process.platform) {
  if (platform === "darwin") return [["pbcopy"]];
  if (platform === "win32") return [["clip.exe"]];
  return [
    ["wl-copy"],
    ["xclip", "-selection", "clipboard"],
    ["xsel", "--clipboard", "--input"],
  ];
}

function copyText(value, platform = process.platform) {
  const text = String(value ?? "");
  for (const [command, ...args] of clipboardCommands(platform)) {
    const result = spawnSync(command, args, {
      input: text,
      encoding: "utf8",
      stdio: ["pipe", "ignore", "ignore"],
      timeout: 3_000,
    });
    if (!result.error && result.status === 0) return;
  }
  throw new Error("No system clipboard command is available.");
}

module.exports = { clipboardCommands, copyText };
