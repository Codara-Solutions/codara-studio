// Hidden gate 04: $VAR-style references inside arguments must not be
// expanded by the target shell.
//
// We check that the quoter, when given "$HOME ${USER} $(whoami) `whoami`",
// returns a string that, after a real shell pass, is delivered to the
// receiving program as the literal bytes (not the expansion).
//
// We exercise both bash (POSIX) and pwsh (Windows). On other platforms we
// fall back to a structural check on the quoted bytes.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { findExportedFunction } = require("./_lib.cjs");

const PAYLOAD = "$HOME ${USER} $(whoami) `whoami` %USERNAME%";

module.exports = {
  id: "04-env-var-no-expansion",
  description: "$VAR references inside args are not expanded",
  async run({ finalRepoPath }) {
    const found = findExportedFunction(finalRepoPath, (name) =>
      /quoteForShell|quoteShellArg|quoteArg/i.test(name),
    );
    if (!found) {
      return {
        ok: false,
        message: "No quoter export found.",
      };
    }
    let bashOk = null;
    let pwshOk = null;
    let bashMessage = "";
    let pwshMessage = "";

    // bash arm
    const bash = process.platform === "win32" ? findGitBash() : "/bin/bash";
    if (bash) {
      let quotedBash;
      try {
        quotedBash = found.fn(PAYLOAD, "bash");
        if (typeof quotedBash !== "string") quotedBash = found.fn(PAYLOAD);
      } catch (err) {
        return { ok: false, message: `bash quoter threw: ${err && err.message}` };
      }
      const cmd = `node -e ${shellSingleQuote("process.stdout.write(JSON.stringify(process.argv[2]))")} -- ${quotedBash}`;
      const res = spawnSync(bash, ["-c", cmd], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 15_000,
        env: { ...process.env, USER: "ROOT_USER_LITERAL", HOME: "/literal-home" },
      });
      if (res.status !== 0) {
        bashOk = false;
        bashMessage = `bash exited ${res.status}: ${res.stderr}`;
      } else {
        try {
          const argv = JSON.parse(res.stdout);
          if (argv === PAYLOAD) {
            bashOk = true;
            bashMessage = "bash preserved literal";
          } else {
            bashOk = false;
            bashMessage = `bash expanded payload: ${JSON.stringify(argv)}`;
          }
        } catch (err) {
          bashOk = false;
          bashMessage = `bash output was not parseable: ${res.stdout}`;
        }
      }
    } else {
      bashOk = null;
      bashMessage = "bash not available";
    }

    // pwsh arm (only on Windows)
    if (process.platform === "win32") {
      const pwsh = findPwsh();
      if (pwsh) {
        let quotedPwsh;
        try {
          quotedPwsh = found.fn(PAYLOAD, "pwsh");
        } catch (err) {
          return { ok: false, message: `pwsh quoter threw: ${err && err.message}` };
        }
        if (typeof quotedPwsh !== "string") {
          // Quoter did not differentiate by family; structural test only.
          pwshOk = null;
          pwshMessage = "quoter did not return a string for pwsh family";
        } else {
          // pwsh single-quote rule: doubling. We feed the quoted token through
          // a small pwsh script that echoes argv via $args.
          const script = `param([string]$x); [Console]::Out.Write([string]$x)`;
          const wrapped = `& { param([string]$x); [Console]::Out.Write([string]$x) } ${quotedPwsh}`;
          const res = spawnSync(pwsh, ["-NoLogo", "-NoProfile", "-Command", wrapped], {
            encoding: "utf8",
            windowsHide: true,
            timeout: 15_000,
            env: {
              ...process.env,
              USERNAME: "ROOT_USER_LITERAL",
              HOMEPATH: "\\literal-home",
            },
          });
          if (res.status !== 0) {
            pwshOk = false;
            pwshMessage = `pwsh exited ${res.status}: ${res.stderr}`;
          } else if (res.stdout.includes("ROOT_USER_LITERAL") || res.stdout.includes("\\literal-home")) {
            pwshOk = false;
            pwshMessage = `pwsh expanded variable: ${res.stdout}`;
          } else if (!res.stdout.includes("$HOME") && !res.stdout.includes("`whoami`")) {
            pwshOk = false;
            pwshMessage = `pwsh stripped literal markers: ${res.stdout}`;
          } else {
            pwshOk = true;
            pwshMessage = "pwsh preserved literal";
          }
        }
      } else {
        pwshOk = null;
        pwshMessage = "pwsh not available";
      }
    }

    const arms = [];
    if (bashOk !== null) arms.push({ ok: bashOk, message: `bash: ${bashMessage}` });
    if (pwshOk !== null) arms.push({ ok: pwshOk, message: `pwsh: ${pwshMessage}` });
    if (arms.length === 0) {
      return {
        ok: false,
        message: "neither bash nor pwsh available; cannot exercise expansion test",
      };
    }
    const failed = arms.filter((a) => !a.ok);
    if (failed.length === 0) {
      return { ok: true, message: arms.map((a) => a.message).join("; ") };
    }
    return { ok: false, message: arms.map((a) => a.message).join("; ") };
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

function findGitBash() {
  for (const p of [
    "C:/Program Files/Git/bin/bash.exe",
    "C:/Program Files/Git/usr/bin/bash.exe",
  ]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function shellSingleQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
