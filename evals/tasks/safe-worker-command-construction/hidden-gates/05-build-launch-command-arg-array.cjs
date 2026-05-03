// Hidden gate 05: launch command builder must accept an argument array (or
// produce a launch spec with explicit args), not concatenate strings via
// space-joining.
//
// Plan invariant 2: "Launch commands are constructed from argument arrays,
// not formatted strings." The reviewer cares about whether a model hint
// containing a quote silently fragments the command.
//
// We poke for any export that looks like a command builder (returns either
// a string or { command, args, ... } given a task-shape object), then feed
// it a model hint with a space + quote and verify either:
//   * each arg is correctly quoted in the resulting string, or
//   * the builder returns an args array with the literal hint as one entry.

"use strict";

const path = require("node:path");
const { findExportedFunction, grepMainSources } = require("./_lib.cjs");

module.exports = {
  id: "05-build-launch-command-arg-array",
  description:
    "launch command construction quotes args robustly when the model hint contains spaces/quotes",
  async run({ finalRepoPath }) {
    const found = findExportedFunction(finalRepoPath, (name) =>
      /buildLaunch|composeLaunch|launchCommand|workerLaunch|buildCommandLine/i.test(name),
    );

    // We need a representative task object the builder can consume.
    const task = {
      runtimePreference: "claude",
      modelHint: "claude-opus-4-7 'evil'",
      effortHint: "max",
      title: "test",
      description: "test",
      allowedPaths: [],
      forbiddenPaths: [],
      expectedOutputs: [],
      verificationCommands: [],
      canRunParallel: false,
      conflictsWith: [],
    };

    if (!found) {
      // Fall back: source must NOT contain the dangerous pattern "args.join(' ')"
      // applied to user-input strings without quoting. We do a heuristic
      // grep — at minimum, the agent should have introduced a single shell
      // quoter, applied to model/effort hints.
      const concatGrep = grepMainSources(
        finalRepoPath,
        /args\.join\(['"`] ['"`]\)|`\$\{[^}]*modelHint[^}]*\}\s+\$\{[^}]*effort/i,
      );
      if (concatGrep.length > 0) {
        return {
          ok: false,
          message:
            "found a string-concat launch builder (args.join with naive separator); plan invariant 2 not implemented",
        };
      }
      return {
        ok: false,
        message:
          "no launch-command builder export found, and no clear evidence of arg-array construction in src/main",
      };
    }

    let result;
    try {
      result = found.fn(task);
    } catch (err) {
      return { ok: false, message: `launch builder threw on adversarial hint: ${err && err.message}` };
    }
    if (result === null || result === undefined) {
      return { ok: false, message: "launch builder returned null for a claude task with a model hint" };
    }

    // Two acceptable shapes:
    if (typeof result === "object" && Array.isArray(result.args)) {
      // arg-array shape — confirm the literal hint is present as a single arg.
      const idx = result.args.findIndex((a) => a === task.modelHint);
      if (idx === -1) {
        return {
          ok: false,
          message: `args array did not contain the literal model hint as a single token; got args=${JSON.stringify(result.args)}`,
        };
      }
      return { ok: true, message: "arg array contains literal model hint" };
    }
    if (typeof result === "string") {
      // String shape — must contain a quoted form of the hint; raw concatenation
      // would result in `--model claude-opus-4-7 'evil'` with the inner ' ' as
      // a separator, which a downstream shell would parse as 4 tokens.
      if (!/(['"]).*claude-opus-4-7 [^'"]*evil[^'"]*\1/.test(result)) {
        return {
          ok: false,
          message: `launch string did not safely quote the model hint with embedded space + quote. Got: ${result}`,
        };
      }
      return { ok: true, message: "launch string safely quoted adversarial model hint" };
    }
    return {
      ok: false,
      message: `launch builder returned unexpected shape: ${typeof result}`,
    };
  },
};
