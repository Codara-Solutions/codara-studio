const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const esbuild = require("esbuild");

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-startup-"));
  try {
    const outfile = path.join(dir, "startup.cjs");
    await esbuild.build({
      entryPoints: [path.resolve(__dirname, "../src/main/manual-agent-startup.ts")],
      bundle: true, platform: "node", format: "cjs", outfile, logLevel: "silent",
    });
    const { parseManualAgentStartupCommand, formatManualAgentStartup } = require(outfile);
    const source = 'codex resume 12345678 --yolo -m gpt-5 -c "model_reasoning_effort=high"';
    const parsed = parseManualAgentStartupCommand(source);
    assert.ok(parsed);
    for (const unsafe of ["codex --yolo; touch marker", "codex --yolo $(whoami)", "codex --unknown"]) {
      assert.equal(parseManualAgentStartupCommand(unsafe), null);
    }
    assert.equal(
      formatManualAgentStartup(parsed, "C:\\Program Files\\Codex\\codex.exe", "pwsh"),
      "& 'C:\\Program Files\\Codex\\codex.exe' 'resume' '12345678' '--yolo' '-m' 'gpt-5' '-c' 'model_reasoning_effort=high'",
    );
    assert.ok(formatManualAgentStartup(parsed, "C:\\Program Files\\Codex\\codex.cmd", "cmd")
      .startsWith('"C:\\Program Files\\Codex\\codex.cmd" "resume"'));

    if (process.platform !== "win32") {
      const binary = path.join(dir, "agent's tools $(false)", "codex");
      fs.mkdirSync(path.dirname(binary));
      fs.writeFileSync(binary, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
      for (const family of ["sh", "bash", "zsh", "fish"]) {
        const shell = spawnSync("which", [family], { encoding: "utf8" }).stdout.trim();
        if (!shell) continue;
        const command = formatManualAgentStartup(parsed, binary, family);
        const args = family === "bash" ? ["--noprofile", "--norc", "-c", command]
          : family === "zsh" ? ["-f", "-c", command]
          : family === "fish" ? ["--no-config", "-c", command] : ["-c", command];
        const result = spawnSync(shell, args, {
          env: { PATH: "/usr/bin:/bin", HOME: dir }, encoding: "utf8", timeout: 5000,
        });
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(result.stdout.trim().split("\n"), parsed.childArgv.slice(1));
        console.log(`PASS ${family} launches the resolved executable and preserves resume arguments`);
      }
    }
    console.log("PASS manual launch parsing and shell quoting");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
