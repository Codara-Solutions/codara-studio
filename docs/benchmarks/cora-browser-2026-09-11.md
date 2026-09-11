# Cora browser workflow check, 2026-09-11

Compared the existing browser workflow with compact semantic snapshots,
page-scoped element references, stricter actions, and updated Cora guidance.
The browser comparison also used Codex's Chrome controls on the same local
fixture: actionable element IDs and change-only observations were the useful
features to bring into Studio.

Both Cora runs used gpt-5.6-sol, high effort, direct execution, the same task
prompt, and `cli/bench/browser/ticket-fixture.cjs`. Each had to find OPS-184,
change its priority and note, recover from a concurrent edit without replacing
the new owner, confirm the save, reopen it, and leave other tickets unchanged.

| Measurement | Before | After |
| --- | ---: | ---: |
| Wall time | 106.39 s | 72.20 s |
| Top-level tool calls | 25 | 18 |
| Uncached input tokens | 49,545 | 26,331 |
| Cached input tokens | 405,376 | 263,424 |
| Output tokens | 2,133 | 1,950 |
| Functional checks | 4/4 | 4/4 |

One trial per version: roughly 32% less time and 47% less uncached input in
this task, not a general performance guarantee. Cached tokens are reported
separately; the sum is not a count of freshly processed or fully billed tokens.
The baseline's overall `passed` flag was false because its tool allowlist
omitted browser resize, although the task prompt allowed browser interaction
tools. All functional checks passed. The harness now includes resize; the
prompt, fixture oracle, model, and task acceptance checks were unchanged.

Local evidence:

- `/tmp/codara-browser-before-20260911.json`, run `run-mtxcurnp-aso02l`
- `/tmp/codara-browser-after-20260911.json`, run `run-mtxdbmye-7p1cw6`
- `/tmp/codara-browser-dom-final.log`: real Studio checks for nested labels,
  controlled React input, password redaction, readonly controls, contentEditable,
  stale references after replacement/navigation, ambiguous buttons, overlays,
  delayed controls, focusable modal containers, scoped/diff snapshots, and byte
  limits. Also tests without `crypto.randomUUID`, which is unavailable on
  insecure HTTP origins.
- `/tmp/codara-language-after.json`: actual Cora responses in English for the
  reported English request with Spanish logs, Spanish for a Spanish request
  with an English example, and English when explicitly requested.

To repeat, with development Studio running:

```sh
CODARA_BROWSER_SMOKE_OUTPUT=/tmp/browser-trial.json node scripts/smoke-cora-browser.cjs
CODARA_BROWSER_SMOKE_RUN=RUN_ID_FROM_TRIAL node scripts/smoke-preview-dom.cjs
CODARA_BROWSER_SMOKE_RUN=RUN_ID_FROM_TRIAL CODARA_LANGUAGE_SMOKE_OUTPUT=/tmp/language-trial.json node scripts/smoke-cora-language.cjs
```

The task and language scripts invoke real Cora inference. The DOM regression
uses the disposable trial workspace and Studio's own browser, with no new
browser process or simulator. Temporary HTTP servers shut down on completion.
The regular test registry covers workspace ownership, MCP batch identity, and
serialized references in trusted mouse/keyboard probes without live inference.

Development hot reload exercised the renderer and new Cora extension prompts.
One later DOM-check attempt hit a 15-second preview RPC timeout; an unchanged
retry passed. That transient timeout was not isolated to a root cause.
Main-process workspace guards, trusted input reference support, and the updated
worker briefing require a Studio restart. Their integration was checked with
unit tests and typechecking; the running application was not restarted.
Snapshots do not traverse iframe or shadow-root content. Screenshots and
trusted input remain available for visual interaction. This check establishes
improvement on the tested workflow, not full Codex browser parity.
