#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");

function loadTypeScriptModule(sourcePath) {
  const source = fs.readFileSync(sourcePath, "utf8");
  const output = ts.transpileModule(source, {
    fileName: sourcePath,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const loaded = new Module(sourcePath, module);
  loaded.filename = sourcePath;
  loaded.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  loaded._compile(output, sourcePath);
  return loaded.exports;
}

(async () => {
const extension = loadTypeScriptModule(
  path.join(__dirname, "..", "resources", "pi-cora", "prompt.ts"),
);
const policies = loadTypeScriptModule(
  path.join(__dirname, "..", "src", "shared", "cora-execution-policy.ts"),
);
const browserPolicy = loadTypeScriptModule(
  path.join(__dirname, "..", "resources", "pi-cora", "studio-browser-policy.ts"),
);
const managerExtensionSource = fs.readFileSync(
  path.join(__dirname, "..", "resources", "pi-cora", "index.ts"),
  "utf8",
);
assert.match(managerExtensionSource, /tool_call.*studioBrowserOnlyDecision/);
process.env.SPARK_MCP_MODE = "talk";
const studioBridge = require(path.join(
  __dirname,
  "..",
  "resources",
  "codara-studio-mcp",
  "server.js",
));

const talk = extension.buildCoraPiSystemPrompt("talk");
const auto = extension.buildCoraPiSystemPrompt("auto");
const execute = extension.buildCoraPiSystemPrompt("execute");
const automation = extension.buildCoraPiSystemPrompt("automation");
const deep = extension.buildCoraPiSystemPrompt("execute", "deep");

assert.match(talk, /This is Talk mode/);
assert.match(talk, /do not claim that workers were spawned/);
assert.doesNotMatch(talk, /Call codara_complete/);
assert.match(auto, /This is Auto mode/);
assert.match(auto, /Do not spawn a\s+worker and do not call codara_complete/);
assert.match(auto, /explicitly says not to use agents or workers, honor that request/);
assert.match(auto, /Do not\s+call codara_spawn_workers or codara_complete on this direct path/);
assert.match(auto, /If no worker models are enabled, use the same direct path/);
assert.match(auto, /direct-work exception remains binding here/);
assert.match(auto, /do not spawn a plan verifier/);
assert.match(auto, /at least one\s+bounded worker/);
assert.match(auto, /Never call codara_complete merely to end a conversational turn/);
assert.match(execute, /This is Execute mode/);
assert.match(execute, /Call codara_complete only after/);
assert.match(execute, /Treat worker reports as claims/);
const orchestration = execute.slice(
  execute.indexOf("How you orchestrate:"),
  execute.indexOf("Effort calibration:"),
);
assert.ok(orchestration.length < 3500, `orchestration prompt stays compact (${orchestration.length} chars)`);
assert.match(automation, /This is Automation mode/);
assert.match(automation, /Do not spawn coding workers/);
assert.doesNotMatch(automation, /Call codara_complete/);
assert.match(deep, /Deep execution policy/);
assert.match(deep, /actively seek a counterexample/);
assert.match(execute, /codara_whiteboard_update/);
assert.match(execute, /Codara Studio's built-in Browser tab/);
assert.match(execute, /codara_preview_\*/);
const studioToolNames = new Set(studioBridge.listTools().map((tool) => tool.name));
assert.equal(studioToolNames.has("codara_whiteboard_get"), true);
assert.equal(studioToolNames.has("codara_whiteboard_update"), true);
assert.equal(policies.normalizeCoraExecutionPolicy("deep"), "deep");
// Retired frontier policy values migrate to deep on read.
assert.equal(policies.normalizeCoraExecutionPolicy("frontier"), "deep");
assert.equal(policies.normalizeCoraExecutionPolicy("invalid"), "fast");
// The picker is gone: the policy is derived in main from taskComplexity, so
// the shared module keeps normalization only.
assert.equal(policies.effectiveCoraExecutionPolicy, undefined);
assert.equal(policies.coraExecutionPolicyProfile, undefined);
assert.equal(policies.CORA_EXECUTION_POLICIES, undefined);

// The complexity contract is the manager's only channel into the tier now, so
// it must reach every orchestrating mode and must NOT leak into Talk.
assert.match(auto, /Task complexity contract/);
assert.match(execute, /Task complexity contract/);
assert.match(execute, /Set taskComplexity on the first codara_spawn_workers/);
assert.match(execute, /do not bid for budget/);
assert.doesNotMatch(talk, /Task complexity contract/);
assert.doesNotMatch(automation, /Task complexity contract/);

// The spawn tool must actually accept the classification the prompt demands.
// The roster is picked once at module load from SPARK_MCP_MODE, so re-require
// the bridge in execute mode to see the orchestration tools.
const studioBridgePath = path.join(
  __dirname,
  "..",
  "resources",
  "codara-studio-mcp",
  "server.js",
);
process.env.SPARK_MCP_MODE = "execute";
delete require.cache[require.resolve(studioBridgePath)];
const executeBridge = require(studioBridgePath);
const executeToolNames = new Set(executeBridge.listTools().map((tool) => tool.name));
for (const browserTool of [
  "codara_preview_list",
  "codara_preview_navigate",
  "codara_preview_snapshot",
  "codara_preview_screenshot",
  "codara_preview_mouse",
  "codara_preview_scroll",
  "codara_preview_hover",
  "codara_preview_drag",
  "codara_preview_key",
  "codara_preview_upload",
  "codara_preview_console",
  "codara_preview_network",
  "codara_preview_resize",
  "codara_preview_run",
]) {
  assert.equal(executeToolNames.has(browserTool), true, `execute mode exposes ${browserTool}`);
}
const spawnTool = executeBridge.listTools().find((tool) => tool.name === "codara_spawn_workers");
assert.ok(spawnTool, "codara_spawn_workers is not exposed in execute mode");
assert.deepEqual(spawnTool.inputSchema.properties.taskComplexity.enum, [
  "trivial",
  "standard",
  "complex",
]);
assert.equal(spawnTool.inputSchema.properties.workers.items.properties.verifier.type, "string");
assert.ok(
  spawnTool.inputSchema.properties.workers.items.properties.verifier.description.length < 500,
  "declared-verifier tool guidance stays compact",
);

// Browser computer-use has one home: Codara Studio's mounted Browser webview.
// The shell remains useful for code and HTTP, but cannot open a parallel GUI
// browser that the user cannot see or control from the Studio tab.
for (const command of [
  "open https://example.com",
  "/usr/bin/open -a 'Google Chrome' https://example.com",
  "env FOO=1 xdg-open https://example.com",
  "/usr/bin/gio open https://example.com",
  `osascript -e 'open location "https://example.com"'`,
  "google-chrome https://example.com",
  "/usr/bin/firefox https://example.com",
  '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" https://example.com',
  "cmd.exe /c start https://example.com",
  "powershell Start-Process https://example.com",
  "python3 -m webbrowser https://example.com",
  "python3 -c 'import webbrowser; webbrowser.open(\"https://example.com\")'",
  "npx playwright open https://example.com",
]) {
  assert.equal(browserPolicy.launchesExternalBrowser(command), true, `blocks external browser: ${command}`);
  assert.equal(
    browserPolicy.studioBrowserOnlyDecision("bash", { command })?.block,
    true,
    `bash guard blocks: ${command}`,
  );
}
for (const command of [
  "curl https://example.com",
  "git grep 'open https'",
  "printf 'open https://example.com'",
  "npm run build",
]) {
  assert.equal(browserPolicy.launchesExternalBrowser(command), false, `allows non-GUI shell work: ${command}`);
}
assert.equal(
  browserPolicy.studioBrowserOnlyDecision("read", { path: "open https://example.com" }),
  undefined,
);

// ── Worker policy (resources/pi-cora/worker-policy.ts): roster + fence ──────
// The pure policy behind worker.ts: which bridge tools a worker registers and
// which Pi tools the automation access fence vetoes.
const policy = loadTypeScriptModule(
  path.join(__dirname, "..", "resources", "pi-cora", "worker-policy.ts"),
);
const workerExtensionSource = fs.readFileSync(
  path.join(__dirname, "..", "resources", "pi-cora", "worker.ts"),
  "utf8",
);
assert.match(workerExtensionSource, /tool_call.*studioBrowserOnlyDecision/);
assert.match(workerExtensionSource, /const SCRATCHPAD_MAX_CHARS = 4_000/);
assert.match(workerExtensionSource, /name: "scratchpad"/);
assert.match(workerExtensionSource, /if \(!untrustedPullRequest\) registerScratchpadTool\(pi\)/);
assert.match(workerExtensionSource, /never hidden reasoning/);
assert.match(workerExtensionSource, /For greetings, opinions, and questions/);
assert.match(workerExtensionSource, /The result summary\s+is shown to the user verbatim/);
assert.match(workerExtensionSource, /Do not inspect the repository or say "acknowledged"/);

// Automation detection is the SPARK_AUTOMATION_ID stamp.
assert.equal(policy.isAutomationWorker({}), false);
assert.equal(policy.isAutomationWorker({ SPARK_AUTOMATION_ID: "  " }), false);
assert.equal(policy.isAutomationWorker({ SPARK_AUTOMATION_ID: "job-1" }), true);

// Chat worker roster: studio surface only (whiteboard + board reads are
// harmless context, scoped to the calling run), no lifecycle tools.
assert.equal(policy.isWorkerSafeBridgeTool("codara_preview_snapshot", false), true);
assert.equal(policy.isWorkerSafeBridgeTool("codara_terminal_create", false), true);
assert.equal(policy.isWorkerSafeBridgeTool("codara_terminal_close", false), true);
assert.equal(policy.isWorkerSafeBridgeTool("codara_whiteboard_get", false), true);
assert.equal(policy.isWorkerSafeBridgeTool("codara_whiteboard_update", false), false);
assert.equal(policy.isWorkerSafeBridgeTool("codara_ask_user", false), false);
assert.equal(policy.isWorkerSafeBridgeTool("codara_request_next_iteration", false), false);
assert.equal(policy.isWorkerSafeBridgeTool("codara_board_get", false), true);
assert.equal(policy.isWorkerSafeBridgeTool("codara_board_update", false), false);

// Automation worker roster: lifecycle pair + board read appear; manager
// orchestration and mutating board/whiteboard tools stay out.
assert.equal(policy.isWorkerSafeBridgeTool("codara_ask_user", true), true);
assert.equal(policy.isWorkerSafeBridgeTool("codara_request_next_iteration", true), true);
assert.equal(policy.isWorkerSafeBridgeTool("codara_board_get", true), true);
assert.equal(policy.isWorkerSafeBridgeTool("codara_board_update", true), false);
assert.equal(policy.isWorkerSafeBridgeTool("codara_whiteboard_update", true), false);
assert.equal(policy.isWorkerSafeBridgeTool("codara_spawn_workers", true), false);
assert.equal(policy.isWorkerSafeBridgeTool("codara_complete", true), false);
assert.equal(
  policy.isWorkerSafeBridgeTool("codara_preview_snapshot", false, {
    CODARA_PI_PROJECT_POLICY: "untrusted-pull-request",
  }),
  false,
  "an imported PR worker receives no Codara bridge tools",
);

// Every WORKER-mode bridge tool must pass the allowlist for an automation
// worker: the roster and the allowlist may not drift apart, or a loom worker
// silently loses tools its prompt references.
process.env.SPARK_MCP_MODE = "worker";
delete require.cache[require.resolve(studioBridgePath)];
const workerBridge = require(studioBridgePath);
for (const tool of workerBridge.listTools()) {
  assert.equal(
    policy.isWorkerSafeBridgeTool(tool.name, true),
    true,
    `worker-mode bridge tool ${tool.name} must pass the automation allowlist`,
  );
}

// Imported PR defense in depth: even if the launcher selects execute mode,
// the bridge itself exposes only the bounded manager coordination roster.
process.env.SPARK_MCP_MODE = "execute";
process.env.CODARA_PI_PROJECT_POLICY = "untrusted-pull-request";
delete require.cache[require.resolve(studioBridgePath)];
const untrustedBridge = require(studioBridgePath);
const untrustedNames = new Set(untrustedBridge.listTools().map((tool) => tool.name));
for (const forbidden of [
  "codara_terminal_create",
  "codara_terminal_read",
  "codara_preview_evaluate",
  "codara_remember",
  "codara_list_automations",
  "codara_create_automation",
]) {
  assert.equal(
    untrustedNames.has(forbidden),
    false,
    `untrusted PR roster must omit ${forbidden}`,
  );
}
for (const allowed of [
  "codara_spawn_workers",
  "codara_get_worker_status",
  "codara_wait_for_workers",
  "codara_complete",
]) {
  assert.equal(untrustedNames.has(allowed), true, `untrusted PR roster keeps ${allowed}`);
}
await assert.rejects(
  untrustedBridge.callToolByName("codara_terminal_create", { command: "id" }),
  /unavailable for an imported pull-request run/,
);
delete process.env.CODARA_PI_PROJECT_POLICY;

// The access fence. Names are asserted against Pi 0.84.2's REAL tool
// inventory (bash, edit, find, grep, ls, read, write natively; web_search +
// url_context from pi-web-search; deep_search bundled) plus the codara_*
// bridge roster.
const noInput = {};
{
  const env = {
    CODARA_PI_WORKER_ACCESS: "readonly",
    CODARA_PI_WORKER_BLOCKED_TOOLS: "Grep",
  };
  const fence = policy.fencedToolNames(env);
  const blocked = (name, input = noInput) => policy.fenceDecision(name, input, fence, env);
  assert.equal(blocked("bash")?.block, true, "readonly blocks bash");
  assert.equal(blocked("edit")?.block, true, "readonly blocks edit");
  assert.equal(blocked("web_search")?.block, true, "readonly blocks web_search");
  assert.equal(blocked("deep_search")?.block, true, "readonly blocks deep_search");
  assert.equal(blocked("url_context")?.block, true, "readonly blocks url_context");
  assert.equal(blocked("grep")?.block, true, "blockedTools Grep maps to grep");
  assert.equal(blocked("read"), undefined, "read stays available");
  assert.equal(blocked("write"), undefined, "write (no path arg) stays available for the final report");
  assert.match(blocked("bash").reason, /disabled for this automation worker/);
  assert.match(blocked("bash").reason, /access preset "readonly"/);
  // Bridge fencing: shell-equivalent bridge tools blocked for ANY preset,
  // mutating preview tools additionally blocked for readonly. Read-ish
  // preview tools stay.
  assert.equal(blocked("codara_terminal_create")?.block, true, "readonly blocks terminal create");
  assert.equal(blocked("codara_terminal_write")?.block, true, "readonly blocks terminal write");
  assert.equal(blocked("codara_terminal_close")?.block, true, "readonly blocks terminal close");
  assert.equal(blocked("codara_preview_evaluate")?.block, true, "readonly blocks preview evaluate");
  assert.equal(blocked("codara_preview_run")?.block, true, "readonly blocks preview run (can embed evaluate steps)");
  assert.equal(blocked("codara_preview_click")?.block, true, "readonly blocks preview click");
  assert.equal(blocked("codara_preview_type")?.block, true, "readonly blocks preview type");
  assert.equal(blocked("codara_preview_screenshot"), undefined, "readonly keeps preview screenshot");
  assert.equal(blocked("codara_preview_navigate"), undefined, "readonly keeps preview navigate");
  assert.equal(blocked("codara_ask_user"), undefined, "readonly keeps ask_user");
}
{
  const env = {
    CODARA_PI_WORKER_ACCESS: "edits",
    CODARA_PI_WORKER_BLOCKED_TOOLS: "WebFetch",
  };
  const fence = policy.fencedToolNames(env);
  const blocked = (name, input = noInput) => policy.fenceDecision(name, input, fence, env);
  assert.equal(blocked("edit", { path: process.cwd() + "/x.txt" }), undefined, "edits keeps the edit tool inside the workspace");
  assert.equal(blocked("bash")?.block, true, "edits blocks bash");
  assert.equal(blocked("url_context")?.block, true, "WebFetch maps to url_context");
  assert.equal(blocked("codara_terminal_create")?.block, true, "edits blocks terminal create");
  assert.equal(blocked("codara_terminal_close")?.block, true, "edits blocks terminal close");
  assert.equal(blocked("codara_preview_evaluate")?.block, true, "edits blocks preview evaluate");
  assert.equal(blocked("codara_preview_click"), undefined, "edits keeps preview click");
}
{
  // Alias mapping onto REAL tool names: Glob -> find, MultiEdit -> edit.
  const env = { CODARA_PI_WORKER_BLOCKED_TOOLS: "Glob,MultiEdit" };
  const fence = policy.fencedToolNames(env);
  const blocked = (name) => policy.fenceDecision(name, noInput, fence, env);
  assert.equal(blocked("find")?.block, true, "Glob maps to find");
  assert.equal(blocked("edit")?.block, true, "MultiEdit maps to edit");
}
{
  // Bare blockedTools with no preset: camelCase maps to snake_case; Write is
  // blockable explicitly (that is what silences the chat board for a node),
  // and no preset means no bridge fencing and no containment.
  const env = { CODARA_PI_WORKER_BLOCKED_TOOLS: "Write,WebSearch" };
  const fence = policy.fencedToolNames(env);
  const blocked = (name, input = noInput) => policy.fenceDecision(name, input, fence, env);
  assert.equal(blocked("write")?.block, true, "explicit Write block maps to write");
  assert.equal(blocked("web_search")?.block, true, "WebSearch maps to web_search");
  assert.equal(blocked("bash"), undefined, "no preset means shell stays available");
  assert.equal(blocked("codara_terminal_create"), undefined, "no preset means bridge tools stay");
  assert.equal(blocked("codara_terminal_close"), undefined, "no preset keeps terminal close");
  assert.equal(
    blocked("edit", { path: os.tmpdir() + "/anywhere.txt" }),
    undefined,
    "no preset means no write containment",
  );
  assert.match(blocked("write").reason, /blocked by its worker config/);
}
{
  // No fence env at all: empty set, nothing vetoed.
  assert.equal(policy.fencedToolNames({}).size, 0);
}

// Path containment for fenced workers: reads, searches, and mutations stay
// inside the session cwd plus the launcher's allow-listed dirs.
{
  const allowDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fence-allow-"));
  const env = {
    CODARA_PI_WORKER_ACCESS: "edits",
    CODARA_PI_WORKER_WRITE_ALLOW: JSON.stringify([allowDir]),
  };
  const fence = policy.fencedToolNames(env);
  const decide = (name, input) => policy.fenceDecision(name, input, fence, env);
  const cwd = process.cwd();
  assert.equal(decide("write", { path: path.join(cwd, "notes.md") }), undefined, "write inside cwd allowed");
  assert.equal(decide("write", { path: "relative/notes.md" }), undefined, "relative write resolves against cwd");
  assert.equal(decide("edit", { file_path: path.join(cwd, "src", "a.ts") }), undefined, "edit inside cwd allowed");
  assert.equal(decide("write", { path: path.join(allowDir, "final-report.json") }), undefined, "write to the allow-listed report dir allowed");
  assert.equal(
    decide("write", { path: path.join(os.tmpdir(), "pi-fence-escape.txt") })?.block,
    true,
    "write outside cwd + allow dirs blocked",
  );
  assert.equal(
    decide("write", { path: path.join(cwd, "..", "escape.txt") })?.block,
    true,
    "traversal out of cwd blocked",
  );
  assert.equal(
    decide("edit", { path: "/etc/hosts" })?.block,
    true,
    "absolute edit outside the workspace blocked",
  );
  assert.match(
    decide("write", { path: "/etc/hosts" }).reason,
    /outside this worker's workspace/,
  );
  assert.equal(
    decide("read", { path: "/etc/hosts" })?.block,
    true,
    "read cannot escape to local secrets",
  );
  assert.equal(
    decide("grep", { path: path.join(cwd, ".."), pattern: "secret" })?.block,
    true,
    "search cannot escape the workspace",
  );
  assert.equal(
    decide("find", { path: path.join(allowDir, "reports") }),
    undefined,
    "read/search may inspect an explicitly allowed report directory",
  );
  assert.equal(
    decide("ls", {}),
    undefined,
    "a read-ish tool with no explicit path defaults safely to cwd",
  );
  assert.equal(
    decide("write", { path: path.join(cwd, ".git", "config") })?.block,
    true,
    "a fenced worker cannot modify Git administrative data",
  );
  fs.rmSync(allowDir, { recursive: true, force: true });
}
{
  const exactDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fence-exact-"));
  const exactReport = path.join(exactDir, "final-report.json");
  const env = {
    CODARA_PI_WORKER_ACCESS: "edits",
    CODARA_PI_WORKER_WRITE_ALLOW_FILES: JSON.stringify([exactReport]),
  };
  const fence = policy.fencedToolNames(env);
  const decide = (name, input) => policy.fenceDecision(name, input, fence, env);
  assert.equal(
    decide("write", { path: exactReport }),
    undefined,
    "the exact app-owned final report remains writable",
  );
  assert.equal(
    decide("write", { path: path.join(exactDir, "sibling.json") })?.block,
    true,
    "the report capability does not grant its whole parent directory",
  );
  fs.rmSync(exactDir, { recursive: true, force: true });
}

// Roster vs fence cross-check: a fenced worker's blocked bridge tools must be
// REAL names from the worker-mode roster (no dead entries), and the shell set
// must actually cover the terminal tools the roster offers.
{
  const rosterNames = new Set(workerBridge.listTools().map((tool) => tool.name));
  const fenced = policy.fencedToolNames({ CODARA_PI_WORKER_ACCESS: "readonly" });
  for (const name of fenced) {
    if (!name.startsWith("codara_")) continue;
    assert.equal(rosterNames.has(name), true, `fenced bridge tool ${name} must exist in the worker roster`);
  }
  for (const name of rosterNames) {
    if (name.startsWith("codara_terminal_")) {
      assert.equal(fenced.has(name), true, `terminal tool ${name} must be fenced for readonly`);
    }
  }
  assert.equal(fenced.has("codara_preview_evaluate"), true, "preview evaluate must be fenced for readonly");
  assert.equal(fenced.has("codara_preview_run"), true, "preview run must be fenced for readonly");
}

// ── Early compaction (resources/pi-cora/compaction.ts) ─────────────────────
// Cora compacts her Pi sessions at ~256k tokens instead of waiting for Pi's
// own contextWindow - 16384 trigger. The decision is pure, so exercise it
// directly, then drive the real registration against a fake ExtensionAPI.
{
  const compaction = loadTypeScriptModule(
    path.join(__dirname, "..", "resources", "pi-cora", "compaction.ts"),
  );
  const DEFAULT = compaction.DEFAULT_COMPACT_AT_TOKENS;
  assert.equal(DEFAULT, 256000);

  // Three copies of the threshold exist and must agree: @shared (the meter and
  // the manager-level trigger), pi-runtime (what the launcher stamps), and the
  // extension (what enforces it). resources/ cannot import from src, which is
  // why the extension holds its own and why this assertion exists.
  const shared = loadTypeScriptModule(
    path.join(__dirname, "..", "src", "shared", "context-compaction.ts"),
  );
  assert.equal(
    shared.DEFAULT_PI_COMPACT_AT_TOKENS,
    DEFAULT,
    "@shared/context-compaction and the extension must agree on the default",
  );
  assert.equal(
    shared.PI_BUILTIN_COMPACT_HEADROOM_TOKENS,
    compaction.PI_BUILTIN_COMPACT_HEADROOM_TOKENS,
    "@shared and the extension must agree on Pi's own headroom",
  );
  // The shared cap helper must agree with the extension's, or the meter would
  // promise a ceiling the session does not actually compact at.
  for (const [window, threshold] of [
    [1_000_000, DEFAULT],
    [200_000, DEFAULT],
    [400_000, DEFAULT],
    [8_000, DEFAULT],
    [1_000_000, 120_000],
  ]) {
    assert.equal(
      shared.effectiveCompactionCapTokens(window, threshold),
      compaction.effectiveCompactAtTokens(window, threshold),
      `cap helpers disagree for window=${window} threshold=${threshold}`,
    );
  }
  // Absurd overrides resolve identically on both sides.
  for (const raw of ["", "0", "-1", "NaN", "nonsense", "120000", "80000.9"]) {
    assert.equal(
      shared.resolveCompactAtTokens(raw),
      compaction.resolveCompactAtTokens({ CODARA_PI_COMPACT_AT_TOKENS: raw }),
      `override parsers disagree for ${JSON.stringify(raw)}`,
    );
  }

  // The chat capacity the meter renders.
  const capacity = shared.chatContextCapacityTokens;
  assert.equal(
    capacity({ contextWindowTokens: 400_000 }),
    256_000,
    "a gpt-5 Pi chat reads against 256k, not its 400k window",
  );
  assert.equal(
    capacity({ contextWindowTokens: 1_000_000 }),
    256_000,
    "a 1M-window Pi chat reads against 256k",
  );
  assert.equal(
    capacity({ contextWindowTokens: 1_000_000, compactAtTokens: 120_000 }),
    120_000,
    "a stamped override drives the meter",
  );
  // A window smaller than the cap can never reach it, so it shows its own
  // (smaller) effective ceiling rather than a 256k promise it cannot keep.
  assert.equal(
    capacity({ contextWindowTokens: 128_000 }),
    128_000 - shared.PI_BUILTIN_COMPACT_HEADROOM_TOKENS,
    "a sub-threshold window reports Pi's own earlier trigger",
  );
  assert.equal(
    capacity({ contextWindowTokens: 8_000 }),
    8_000,
    "a window below even the headroom never exceeds itself",
  );

  // Threshold resolution: default, override, and absurd values.
  assert.equal(compaction.resolveCompactAtTokens({}), DEFAULT);
  assert.equal(compaction.resolveCompactAtTokens({ CODARA_PI_COMPACT_AT_TOKENS: "" }), DEFAULT);
  assert.equal(compaction.resolveCompactAtTokens({ CODARA_PI_COMPACT_AT_TOKENS: "  " }), DEFAULT);
  assert.equal(compaction.resolveCompactAtTokens({ CODARA_PI_COMPACT_AT_TOKENS: "120000" }), 120000);
  assert.equal(compaction.resolveCompactAtTokens({ CODARA_PI_COMPACT_AT_TOKENS: " 90000 " }), 90000);
  assert.equal(compaction.resolveCompactAtTokens({ CODARA_PI_COMPACT_AT_TOKENS: "80000.9" }), 80000);
  for (const absurd of ["0", "-1", "-250000", "NaN", "nonsense", "Infinity", "-Infinity"]) {
    assert.equal(
      compaction.resolveCompactAtTokens({ CODARA_PI_COMPACT_AT_TOKENS: absurd }),
      DEFAULT,
      `absurd override ${absurd} must fall back to the default`,
    );
  }

  // Never DELAY Pi's own trigger: the effective threshold is the smaller of
  // Codara's number and contextWindow - 16384.
  assert.equal(compaction.effectiveCompactAtTokens(1000000, DEFAULT), DEFAULT);
  assert.equal(compaction.effectiveCompactAtTokens(200000, DEFAULT), 200000 - 16384);
  assert.equal(compaction.effectiveCompactAtTokens(8000, DEFAULT), DEFAULT);
  assert.equal(compaction.effectiveCompactAtTokens(undefined, DEFAULT), DEFAULT);

  const decide = (usage, compactionInFlight = false) =>
    compaction.shouldCompactNow({ usage, thresholdTokens: DEFAULT, compactionInFlight });
  assert.equal(decide({ tokens: 255999, contextWindow: 1000000 }), false, "below threshold is a no-op");
  assert.equal(decide({ tokens: DEFAULT, contextWindow: 1000000 }), false, "exactly at threshold is a no-op");
  assert.equal(decide({ tokens: 256001, contextWindow: 1000000 }), true, "above threshold compacts");
  assert.equal(decide({ tokens: 256001, contextWindow: 1000000 }, true), false, "in-flight suppresses");
  assert.equal(decide({ tokens: null, contextWindow: 1000000 }), false, "unknown usage is a no-op");
  assert.equal(decide(undefined), false, "absent usage is a no-op");
  // A small-window model still compacts on Pi's earlier trigger.
  assert.equal(decide({ tokens: 200000, contextWindow: 200000 }), true);

  // Registration: one compaction per crossing, and the in-flight latch holds
  // until the session_compact event (or the completion callback) clears it.
  const handlers = new Map();
  const pi = { on: (event, handler) => { handlers.set(event, handler); } };
  let usage = { tokens: 10, contextWindow: 1000000 };
  let compactCalls = 0;
  let lastOptions = null;
  const ctx = {
    getContextUsage: () => usage,
    compact: (options) => { compactCalls += 1; lastOptions = options; },
  };
  compaction.registerContextCompaction(pi, { CODARA_PI_COMPACT_AT_TOKENS: "1000" });
  const agentEnd = handlers.get("agent_end");
  assert.ok(agentEnd, "agent_end must be the compaction trigger");

  agentEnd({ type: "agent_end", messages: [] }, ctx);
  assert.equal(compactCalls, 0, "a small context must not compact");

  usage = { tokens: 1500, contextWindow: 1000000 };
  agentEnd({ type: "agent_end", messages: [] }, ctx);
  assert.equal(compactCalls, 1, "crossing the override threshold compacts");
  assert.equal(
    lastOptions.customInstructions,
    compaction.CORA_COMPACTION_INSTRUCTIONS,
    "automatic compaction uses Cora's continuation handoff prompt",
  );
  assert.match(lastOptions.customInstructions, /newest user intent/);
  assert.match(lastOptions.customInstructions, /exact files\/symbols\/commands\/IDs/);
  assert.match(lastOptions.customInstructions, /pending tasks/);
  agentEnd({ type: "agent_end", messages: [] }, ctx);
  assert.equal(compactCalls, 1, "an in-flight compaction suppresses a second request");

  // Pi's own threshold compaction latches the flag the same way.
  handlers.get("session_compact")({ type: "session_compact", reason: "threshold" });
  usage = { tokens: 20, contextWindow: 1000000 };
  agentEnd({ type: "agent_end", messages: [] }, ctx);
  assert.equal(compactCalls, 1, "usage is re-read after a compaction, not looped on");

  handlers.get("session_before_compact")({ type: "session_before_compact", reason: "threshold" });
  usage = { tokens: 1500, contextWindow: 1000000 };
  agentEnd({ type: "agent_end", messages: [] }, ctx);
  assert.equal(compactCalls, 1, "a Pi-initiated compaction suppresses ours while it runs");
  lastOptions.onComplete?.();
  handlers.get("session_compact")({ type: "session_compact", reason: "threshold" });
  agentEnd({ type: "agent_end", messages: [] }, ctx);
  assert.equal(compactCalls, 2, "the trigger re-arms once the compaction finishes");

  // Both Cora extensions must actually wire the trigger up.
  for (const file of ["index.ts", "worker.ts"]) {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "resources", "pi-cora", file),
      "utf8",
    );
    assert.match(
      source,
      /registerContextCompaction\(pi\)/,
      `${file} must register the early-compaction trigger`,
    );
  }
}

// ── Provider service tier (resources/pi-cora/service-tier.ts) ──────────────
// OpenAI's faster tier is opt-in from Settings; Anthropic can never carry a
// fast/priority tier at all. The extension's before_provider_request hook is
// the last code to touch the request body, so this is where both are decided.
{
  const tier = loadTypeScriptModule(
    path.join(__dirname, "..", "resources", "pi-cora", "service-tier.ts"),
  );
  const apply = tier.applyServiceTierPolicy;
  const FAST = tier.OPENAI_FAST_SERVICE_TIER;
  // "priority" and "fast" are OpenAI aliases for the same tier (renamed to
  // "Fast mode" on 2026-07-30). We send "priority": it is the spelling pi-ai
  // types and prices, and the only one in the OpenAI Responses service_tier
  // union.
  assert.equal(FAST, "priority", "pi-ai types and prices the 'priority' spelling");

  // (a) Setting OFF: no tier on an OpenAI request.
  for (const provider of ["openai-codex", "openai"]) {
    const body = apply({ model: "gpt-5.6-sol", input: [] }, provider, false);
    assert.equal("service_tier" in body, false, `${provider} must carry no tier when fast mode is off`);
  }
  // An inherited tier is removed rather than left to ride along.
  assert.equal(
    "service_tier" in apply({ service_tier: "priority" }, "openai-codex", false),
    false,
    "fast mode off must strip a tier the body already carried",
  );

  // (b) Setting ON: the fast tier is present on OpenAI requests.
  for (const provider of ["openai-codex", "openai"]) {
    assert.equal(
      apply({ model: "gpt-5.6-sol", input: [] }, provider, true).service_tier,
      FAST,
      `${provider} must carry the fast tier when fast mode is on`,
    );
  }

  // (c) Anthropic NEVER carries a fast tier, either way. Not gated on the
  // setting, not gated on anything a prompt or a future UI could reach.
  for (const fastMode of [false, true]) {
    const clean = apply({ model: "claude-opus-5", messages: [] }, "anthropic", fastMode);
    assert.equal(
      "service_tier" in clean,
      false,
      `anthropic must never carry a service tier (fastMode=${fastMode})`,
    );
    // Even when something upstream already put one there.
    for (const key of ["service_tier", "serviceTier"]) {
      const stripped = apply({ [key]: "priority", model: "claude-opus-5" }, "anthropic", fastMode);
      assert.equal(
        key in stripped,
        false,
        `anthropic must strip an inherited ${key} (fastMode=${fastMode})`,
      );
    }
  }

  // The guard keys off the provider Codara stamps, so verify the classifiers.
  assert.equal(tier.isAnthropicProvider("anthropic"), true);
  assert.equal(tier.isAnthropicProvider("ANTHROPIC"), true);
  assert.equal(tier.isAnthropicProvider("openai-codex"), false);
  assert.equal(tier.isOpenAiProvider("openai-codex"), true);
  assert.equal(tier.isOpenAiProvider("anthropic"), false);

  // An unknown provider never GAINS a tier from Codara.
  assert.equal(
    "service_tier" in apply({ model: "mystery" }, "some-future-provider", true),
    false,
    "an unrecognized provider must not be given a tier",
  );

  // Env reading: only the exact "1" stamp enables fast mode.
  assert.equal(tier.fastModeEnabled({}), false);
  for (const raw of ["", "0", "true", "yes", "priority"]) {
    assert.equal(
      tier.fastModeEnabled({ CODARA_PI_FAST_MODE: raw }),
      false,
      `CODARA_PI_FAST_MODE=${JSON.stringify(raw)} must not enable fast mode`,
    );
  }
  assert.equal(tier.fastModeEnabled({ CODARA_PI_FAST_MODE: "1" }), true);

  // A malformed payload passes through instead of failing the turn.
  for (const odd of [null, undefined, 42, "body", []]) {
    assert.equal(apply(odd, "openai-codex", true), odd);
  }

  // Registration wires the hook Pi actually consults.
  const handlers = new Map();
  tier.registerServiceTierPolicy(
    { on: (event, handler) => handlers.set(event, handler) },
    { CODARA_PI_PROVIDER: "anthropic", CODARA_PI_FAST_MODE: "1" },
  );
  const hook = handlers.get("before_provider_request");
  assert.ok(hook, "before_provider_request must be the service-tier seam");
  assert.equal(
    "service_tier" in hook({ type: "before_provider_request", payload: { service_tier: "priority" } }),
    false,
    "an anthropic session strips the tier even with fast mode stamped on",
  );

  // Both extensions must wire it up.
  for (const file of ["index.ts", "worker.ts"]) {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "resources", "pi-cora", file),
      "utf8",
    );
    assert.match(
      source,
      /registerServiceTierPolicy\(pi\)/,
      `${file} must register the service-tier policy`,
    );
  }
}

console.log("pi Cora mode + execution-policy prompts: ok");
console.log("pi worker policy (roster + access fence): ok");
console.log("pi session compaction (256k trigger): ok");
console.log("pi provider service tier (OpenAI opt-in, Anthropic never): ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
