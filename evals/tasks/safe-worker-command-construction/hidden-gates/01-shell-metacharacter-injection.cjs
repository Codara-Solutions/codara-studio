// Hidden gate 01: shell metacharacters inside an argument must NOT be
// interpreted by the target shell.
//
// The plan asks for a `quoteForShell(arg, family)` helper. We exercise the
// bash branch by feeding it an argument that, if naively concatenated into a
// command string, would `; rm -rf /`. The quoted form must round-trip
// through `bash -c` such that the inner program sees the literal value as
// one argv slot.
//
// We don't actually run rm. We invoke `node -e <script>` from within a
// constructed bash command line that builds itself out of the agent's
// quoter, then assert the inner node process saw the bytes verbatim.

"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { findExportedFunction } = require("./_lib.cjs");

const PAYLOAD = '"; rm -rf /; echo OWNED #';

module.exports = {
  id: "01-shell-metacharacter-injection",
  description: "shell metacharacters inside arg are escaped, not interpreted",
  async run({ finalRepoPath }) {
    const found =
      findExportedFunction(finalRepoPath, (name) => /quoteForShell|quoteShellArg|quoteArg/i.test(name));
    if (!found) {
      return {
        ok: false,
        message:
          "No exported quoter found (expected something like quoteForShell(arg, family)). The plan required a single shell quoter helper.",
      };
    }
    let quoted;
    try {
      // Try (arg, "bash"), then (arg) — the agent might have sniffed family from process.platform.
      quoted = found.fn(PAYLOAD, "bash");
      if (typeof quoted !== "string") quoted = found.fn(PAYLOAD);
    } catch (err) {
      return { ok: false, message: `quoter threw: ${err && err.message}` };
    }
    if (typeof quoted !== "string" || !quoted.length) {
      return {
        ok: false,
        message: `quoter returned non-string for adversarial input: ${JSON.stringify(quoted)}`,
      };
    }

    // Now: actually round-trip through bash. We construct a bash command line
    // of the form `node -e '<reader>' <quoted>` so the bash parser must
    // honor the quoting. The inner node prints argv[1] as a JSON string.
    //
    // bash isn't on PATH on every CI machine; if absent we fall back to
    // verifying the quoted string contains no unescaped `;`/`\n`/$ chars.
    const reader =
      "process.stdout.write(JSON.stringify(process.argv[2]));";
    const bash = process.platform === "win32" ? findGitBash() : "/bin/bash";
    if (bash) {
      const cmd = `node -e ${shellSingleQuote(reader)} -- ${quoted}`;
      const res = spawnSync(bash, ["-c", cmd], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 15_000,
      });
      if (res.status !== 0) {
        return {
          ok: false,
          message: `bash -c exited ${res.status}; stderr=${res.stderr}; this means the quoting was broken and bash interpreted metacharacters.`,
        };
      }
      let parsed;
      try {
        parsed = JSON.parse(res.stdout.trim());
      } catch (err) {
        return {
          ok: false,
          message: `inner node could not parse argv: stdout=${JSON.stringify(res.stdout)}`,
        };
      }
      if (parsed !== PAYLOAD) {
        return {
          ok: false,
          message: `argv mismatch: got ${JSON.stringify(parsed)}, expected ${JSON.stringify(PAYLOAD)}`,
        };
      }
      return { ok: true, message: "bash round-trip preserved literal payload" };
    }
    // Fallback: structural check — quoted string must be a single token from
    // bash's perspective (single-quoted) and must contain no unescaped ;.
    if (!/^'.*'$/s.test(quoted)) {
      return {
        ok: false,
        message: `bash unavailable; structural check failed: quoter did not return a single-quoted token for adversarial input. Got: ${quoted}`,
      };
    }
    // Inside single quotes, only ' itself needs escaping. The literal ;rm
    // bytes are fine.
    return {
      ok: true,
      message: "bash unavailable; structural single-quote check passed",
    };
  },
};

function findGitBash() {
  for (const p of [
    "C:/Program Files/Git/bin/bash.exe",
    "C:/Program Files/Git/usr/bin/bash.exe",
    process.env.ProgramFiles ? `${process.env.ProgramFiles}\\Git\\bin\\bash.exe` : null,
  ].filter(Boolean)) {
    try {
      // eslint-disable-next-line global-require
      if (require("node:fs").existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function shellSingleQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
