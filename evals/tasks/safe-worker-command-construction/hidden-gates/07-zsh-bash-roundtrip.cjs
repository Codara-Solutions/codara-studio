// Hidden gate 07: zsh and bash share most semantics but zsh has its own
// quirks (precmd, history expansion). The agent should treat the family
// uniformly — there's nothing zsh-specific that requires diverging from
// bash quoting. This gate just verifies the quoter doesn't reject zsh and
// that a payload with `!history` (which zsh would otherwise expand inside
// double quotes) is preserved when single-quoted.
//
// We exercise via /bin/zsh if available, otherwise structural-only.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { findExportedFunction } = require("./_lib.cjs");

const PAYLOAD = "!! and !$ and !1 and {a,b} and ~/path";

module.exports = {
  id: "07-zsh-bash-roundtrip",
  description: "zsh quoting preserves history-expansion-looking literals",
  async run({ finalRepoPath }) {
    const found = findExportedFunction(finalRepoPath, (name) =>
      /quoteForShell|quoteShellArg|quoteArg/i.test(name),
    );
    if (!found) {
      return { ok: false, message: "No quoter export found." };
    }
    let zshQuote;
    try {
      zshQuote = found.fn(PAYLOAD, "zsh");
      if (typeof zshQuote !== "string") zshQuote = found.fn(PAYLOAD, "bash");
    } catch (err) {
      return { ok: false, message: `quoter threw on zsh family: ${err && err.message}` };
    }
    if (typeof zshQuote !== "string") {
      return { ok: false, message: "quoter did not return a string for zsh family" };
    }

    // Structural: must single-quote (or otherwise preserve) the !history-style
    // and brace-expansion literals.
    if (!/^'.*'$/s.test(zshQuote)) {
      return {
        ok: false,
        message: `expected single-quoted token to suppress zsh expansion. Got: ${zshQuote}`,
      };
    }
    const inner = zshQuote.slice(1, -1);
    for (const literal of ["!!", "!$", "!1", "{a,b}", "~/path"]) {
      if (!inner.includes(literal)) {
        return {
          ok: false,
          message: `quoted form lost '${literal}' literal: ${zshQuote}`,
        };
      }
    }

    // Best-effort: actually run via zsh if installed.
    const zsh = process.platform === "win32" ? null : "/bin/zsh";
    if (zsh && fs.existsSync(zsh)) {
      const cmd = `node -e ${shellSingleQuote("process.stdout.write(JSON.stringify(process.argv[2]))")} -- ${zshQuote}`;
      const res = spawnSync(zsh, ["-c", cmd], {
        encoding: "utf8",
        timeout: 15_000,
      });
      if (res.status === 0) {
        try {
          const parsed = JSON.parse(res.stdout);
          if (parsed !== PAYLOAD) {
            return {
              ok: false,
              message: `zsh round-trip mismatch: got ${JSON.stringify(parsed)}, expected ${JSON.stringify(PAYLOAD)}`,
            };
          }
        } catch {
          /* fall through */
        }
      }
    }
    return { ok: true, message: "zsh structural check passed" };
  },
};

function shellSingleQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
