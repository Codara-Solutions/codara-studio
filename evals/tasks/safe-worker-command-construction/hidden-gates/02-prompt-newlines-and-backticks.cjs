// Hidden gate 02: A multi-line prompt with backticks and shell metacharacters
// must reach the worker pasted with byte-for-byte fidelity.
//
// The plan invariant (1) says worker prompts are data, not commands. We
// invoke whatever paste function the agent uses (renamed or not) with a
// fake handle that captures every write, then assert the bytes that were
// pasted contained the literal payload between bracketed-paste markers
// (\x1b[200~ ... \x1b[201~).

"use strict";

const path = require("node:path");
const { findExportedFunction, grepMainSources } = require("./_lib.cjs");

const PAYLOAD = [
  "Here is a multi-line prompt with adversarial bytes.",
  "Backticks inside `console.log(\"hi\")` and a $VAR reference and ${expansion}.",
  "; rm -rf / && echo pwned",
  "Trailing newline-with-tab\there.",
].join("\n");

module.exports = {
  id: "02-prompt-newlines-and-backticks",
  description:
    "multi-line prompt with backticks/$/; survives bracketed-paste round-trip",
  async run({ finalRepoPath }) {
    // The plan does not rename pasteAndSubmit; the agent might keep the
    // existing function or rename to sendPromptToWorker. We accept any
    // exported async function whose name starts with paste/send/sendPrompt.
    const found = findExportedFunction(finalRepoPath, (name) =>
      /^(paste|sendPrompt|sendWorkerPrompt|writePrompt|deliverPrompt)/i.test(name),
    );
    if (!found) {
      // The plan requires the paste-and-submit boundary to remain a callable,
      // testable primitive. Refusing to expose it as an export means the
      // adversarial round-trip cannot be exercised at all, so this is a
      // hard fail. We also surface whether the bracketed-paste markers
      // survived in source, as a hint to the operator.
      const matches = grepMainSources(finalRepoPath, /\\x1b\[200~/);
      if (matches.length === 0) {
        return {
          ok: false,
          message:
            "No paste/sendPrompt export found, AND no bracketed-paste markers (\\x1b[200~) anywhere in src/main. Multi-line prompts would be interpreted as shell commands.",
        };
      }
      return {
        ok: false,
        message:
          "No paste/sendPrompt export found. The plan required the worker prompt boundary to be testable; bracketed-paste markers are still in source but the round-trip cannot be exercised.",
      };
    }
    const written = [];
    const handle = {
      write(chunk) {
        written.push(chunk);
      },
      kill() {},
    };
    try {
      await Promise.race([
        found.fn(handle, PAYLOAD, "claude"),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("pasteAndSubmit timed out")), 8_000),
        ),
      ]);
    } catch (err) {
      return { ok: false, message: `paste function threw: ${err && err.message}` };
    }
    const flat = written.join("");
    // Bracketed paste boundaries.
    if (!flat.includes("\x1b[200~") || !flat.includes("\x1b[201~")) {
      return {
        ok: false,
        message:
          "paste output did not include bracketed-paste markers; multi-line prompt would be interpreted as commands by the host shell",
      };
    }
    // The payload itself must appear between the markers, byte-for-byte.
    const start = flat.indexOf("\x1b[200~");
    const end = flat.indexOf("\x1b[201~");
    if (start < 0 || end < 0 || end < start) {
      return { ok: false, message: "paste markers were out of order" };
    }
    const inner = flat.slice(start + "\x1b[200~".length, end);
    // The implementation may normalize \r\n to \n and trim — check the
    // payload survives modulo the trim.
    if (!inner.includes("`console.log(\"hi\")`")) {
      return {
        ok: false,
        message:
          `bracketed-paste body lost backticks: got ${JSON.stringify(inner.slice(0, 200))}`,
      };
    }
    if (!inner.includes("$VAR") || !inner.includes("${expansion}")) {
      return {
        ok: false,
        message: "bracketed-paste body lost $VAR / ${expansion} literals",
      };
    }
    if (!inner.includes("; rm -rf / && echo pwned")) {
      return {
        ok: false,
        message:
          "bracketed-paste body lost shell-metacharacter line — quoting changed during paste, not safe",
      };
    }
    return { ok: true, message: "round-trip preserved adversarial payload" };
  },
};
