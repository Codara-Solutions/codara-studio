# Make worker launching safe and shell-portable

Spark Agent launches worker tasks by typing a command line into a real PTY
shell — usually pwsh on Windows, bash/zsh on macOS/Linux. The current launch
path in `src/main/orchestration/run-store.ts` (`buildLaunchCommandLine` plus
`pasteAndSubmit`) and the supporting helpers in `src/main/pty-manager.ts` /
`src/main/shells.ts` work for the happy path, but they conflate "user-facing
prompt text" with "shell command syntax" in a way that's been bothering me
on review.

I want a senior-engineer cleanup of the worker-launching boundary so the
following invariants are unambiguous, defended, and tested:

1. **Worker prompts are data, not commands.** The text we paste into the
   worker (the markdown prompt the manager writes for the agent) must reach
   the agent CLI byte-for-byte. Backticks, dollar signs, semicolons,
   embedded newlines, and shell metacharacters (`;`, `&&`, `||`, `>`, `<`,
   `|`, `\`, `"`, `'`) inside the prompt must NOT be interpreted by the
   intermediate shell. This applies on Windows pwsh, Windows cmd.exe,
   Git Bash, and POSIX bash/zsh.

2. **Launch commands are constructed from argument arrays, not formatted
   strings.** Today, `buildLaunchCommandLine` builds a single string by
   concatenating `claude --dangerously-skip-permissions --model <hint>
   --effort <hint>`. If `modelHint` ever contains a quote, space, or
   backtick (e.g. someone copy-pastes `claude-opus-4-7` with smart quotes
   from a doc), the command silently fragments and the worker spawns wrong.
   I want the launcher to take an argument array and quote each piece for
   the target shell using a single source of truth — one `quoteForShell(arg,
   shellFamily)` helper rather than the ad-hoc `quoteShellArg`. Pwsh,
   bash, zsh, and cmd.exe all have different quoting rules; the helper
   must handle them.

3. **`allowedPaths` and `forbiddenPaths` cannot escape the worker root.**
   When a manager produces `allowedPaths: ['..']` or `allowedPaths:
   ['/etc/passwd']`, the prompt currently passes the strings through
   verbatim to the worker. They should be normalized + validated against
   the run's workspace cwd before they ever land in the worker prompt:
   any `..` segment that escapes cwd, absolute paths that aren't a child of
   cwd, and Windows-drive paths that point outside the workspace must be
   rejected with a clear error before the worker is launched.

4. **Effort and model hints don't corrupt prompt text.** The worker prompt
   text (`promptMd` content) is independent of the launch command line.
   Today they share the same shell pipe — if a model hint sneaks unsanitized
   into the launch command and breaks paste mode, the prompt body that
   follows lands in pwsh as cmdlets. The new design must keep these two
   surfaces separate: the launch command runs first, with quoted args; we
   wait for the agent TUI banner; only then do we send the prompt as a
   bracketed-paste payload.

5. **Tests pin all of the above.** Add unit tests for the
   `quoteForShell` helper covering pwsh, bash, zsh, cmd.exe. Add tests for
   the `allowedPaths` normalizer. Add a small integration smoke test that
   verifies a multi-line prompt with backticks survives a round-trip
   through `pasteAndSubmit` against a fake PTY handle that captures bytes.

## Constraints

- This is a library-quality refactor, not a feature. Do **not** invent new
  CLI flags or change the existing `WorkerTask` schema.
- Keep the change scoped to `src/main/pty-manager.ts`,
  `src/main/orchestration/run-store.ts`, `src/main/shells.ts`, and any new
  helper files under `src/main/` you create.
- The renderer-side changes (`src/renderer/`, `src/preload/`) are **out of
  scope** — do not touch them.
- Do not modify the orchestration manager profile JSON.
- Existing public gates must still pass: `npm run typecheck`.
- Use existing Spark patterns: TypeScript ESM in `src/main`, no new
  runtime dependencies, follow the conventions you see in the surrounding
  files.

## Deliverables

- Refactored launcher that builds launch commands from argument arrays.
- A new helper module exporting `quoteForShell(arg, family)` plus
  `normalizeAllowedPath(path, cwd)` (or equivalents — names are yours).
- Unit tests covering the quoting matrix and path-normalization.
- All existing tests still pass.

When you're done, write a brief summary of what you changed, what the new
boundary looks like, and which existing call sites you updated.
