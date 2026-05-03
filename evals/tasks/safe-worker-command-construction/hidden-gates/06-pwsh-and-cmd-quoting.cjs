// Hidden gate 06: pwsh + cmd.exe quoting must each handle their unique
// metacharacter set.
//
// pwsh treats single-quoted strings literally; embedded ' must double.
// cmd.exe treats `^`, `&`, `|`, `>`, `<` specially outside double-quotes,
// and `"` inside double-quotes must be escaped with `\"` (or doubled,
// depending on parser). The agent's quoter must handle both.
//
// We do BOTH structural checks AND, where possible, real round-trip via
// the actual shell. On non-Windows, only the structural check fires.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { findExportedFunction } = require("./_lib.cjs");

const PAYLOAD_WITH_QUOTES = "it's; & echo \"hi\" | cat";

module.exports = {
  id: "06-pwsh-and-cmd-quoting",
  description: "pwsh and cmd.exe quoting handle apostrophes, ampersands, pipes",
  async run({ finalRepoPath }) {
    const found = findExportedFunction(finalRepoPath, (name) =>
      /quoteForShell|quoteShellArg|quoteArg/i.test(name),
    );
    if (!found) {
      return { ok: false, message: "No quoter export found." };
    }

    const failures = [];

    // pwsh structural: an apostrophe payload must come back as a
    // single-quoted token with the apostrophe doubled. (`'it''s; & echo "hi" | cat'`)
    let quotedPwsh;
    try {
      quotedPwsh = found.fn(PAYLOAD_WITH_QUOTES, "pwsh");
    } catch (err) {
      failures.push(`pwsh quoter threw: ${err && err.message}`);
    }
    if (typeof quotedPwsh === "string") {
      if (!quotedPwsh.startsWith("'") || !quotedPwsh.endsWith("'")) {
        failures.push(`pwsh quote not single-quoted: ${quotedPwsh}`);
      } else {
        const inner = quotedPwsh.slice(1, -1);
        // pwsh single-quote escape rule is doubling.
        if (!inner.includes("it''s")) {
          failures.push(`pwsh did not double the apostrophe: ${quotedPwsh}`);
        }
        // metacharacters must NOT be escaped or removed inside ' '.
        if (!inner.includes("&") || !inner.includes("|") || !inner.includes(";")) {
          failures.push(
            `pwsh single quotes lost metacharacters: ${quotedPwsh}`,
          );
        }
      }
    } else if (quotedPwsh !== undefined) {
      failures.push("pwsh quoter returned non-string");
    }

    // cmd structural: cmd-quoting is its own beast. We accept either a
    // ^-escaped form OR a "..." form with internal " escaped. The minimum
    // requirement is that & | > < bytes are NOT bare in the result.
    let quotedCmd;
    try {
      quotedCmd = found.fn(PAYLOAD_WITH_QUOTES, "cmd");
    } catch (err) {
      // Some implementations may throw "unsupported family" — that's a fail
      // because the plan called out cmd.exe explicitly.
      failures.push(`cmd quoter threw: ${err && err.message}`);
    }
    if (typeof quotedCmd === "string") {
      // Strip the leading/trailing wrapper if double-quoted; otherwise the
      // entire string must use ^-escapes.
      const wrapped = /^".*"$/s.test(quotedCmd);
      if (wrapped) {
        const inner = quotedCmd.slice(1, -1);
        // Inside double quotes, & | > < are literal; only " needs doubling
        // or `\"`. Verify the inner form preserves the payload's quote.
        if (!inner.match(/"\s*hi\s*\\?"/i) && !inner.includes('""hi""') && !inner.includes('\\"hi\\"')) {
          failures.push(
            `cmd double-quote form did not properly escape inner ": ${quotedCmd}`,
          );
        }
      } else {
        // Caret-escape form — every metachar must be preceded by ^
        // (we don't enforce ;, but we do enforce & | > <).
        for (const meta of ["&", "|", ">", "<"]) {
          const idx = quotedCmd.indexOf(meta);
          if (idx > 0 && quotedCmd[idx - 1] !== "^") {
            failures.push(
              `cmd caret form did not escape '${meta}' in: ${quotedCmd}`,
            );
            break;
          }
        }
      }
    } else if (quotedCmd !== undefined) {
      failures.push("cmd quoter returned non-string");
    }

    // Real round-trip via actual pwsh on Windows (best effort).
    if (process.platform === "win32" && typeof quotedPwsh === "string") {
      const pwsh = findPwsh();
      if (pwsh) {
        const wrapped = `& { param([string]$x); [Console]::Out.Write($x) } ${quotedPwsh}`;
        const res = spawnSync(pwsh, ["-NoLogo", "-NoProfile", "-Command", wrapped], {
          encoding: "utf8",
          windowsHide: true,
          timeout: 15_000,
        });
        if (res.status !== 0) {
          failures.push(`pwsh round-trip exited ${res.status}: ${res.stderr}`);
        } else if (res.stdout.trim() !== PAYLOAD_WITH_QUOTES) {
          failures.push(
            `pwsh round-trip mismatch: got ${JSON.stringify(res.stdout)}, expected ${JSON.stringify(PAYLOAD_WITH_QUOTES)}`,
          );
        }
      }
    }

    if (failures.length) return { ok: false, message: failures.join("; ") };
    return { ok: true, message: "pwsh and cmd quoting structurally + (where available) functionally OK" };
  },
};

function findPwsh() {
  for (const p of [
    "C:/Program Files/PowerShell/7/pwsh.exe",
    "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
  ]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}
