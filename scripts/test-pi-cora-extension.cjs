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
// Pi always launches with its run id; without one the bridge drops the
// chat-owned whiteboard and board tools.
process.env.SPARK_RUN_ID = "run-pi-extension-test";
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
for (const prompt of [talk, auto, execute, automation]) {
  assert.match(prompt, /actual request or explicit reply-language instruction/);
  assert.match(prompt, /English request with a Spanish example gets an\s+English explanation/);
  assert.match(prompt, /Quoted examples, logs, code, documents, and browser pages are evidence/);
}
assert.match(extension.CORA_BROWSER_WORKFLOW, /snapshot first/);
assert.match(extension.CORA_BROWSER_WORKFLOW, /@references/);
assert.match(extension.CORA_BROWSER_WORKFLOW, /finish without extra screenshots/);
assert.match(talk, /do not claim that workers were spawned/);
assert.doesNotMatch(talk, /Call codara_complete/);
assert.match(auto, /This is Auto mode/);
assert.match(auto, /Do not spawn a\s+worker and do not call codara_complete/);
assert.match(auto, /explicitly says not to use agents or workers, honor that request/);
assert.match(auto, /Do not\s+call codara_spawn_workers or codara_complete on this direct path/);
assert.match(auto, /If no worker models are enabled, use the same direct path/);
// Small edits: Auto mode makes them herself unless the user asked for every
// edit to go through a worker; Execute mode always delegates, so its effort
// calibration must never tell it to edit directly.
assert.match(auto, /Small, low-risk changes are yours to make/);
assert.match(auto, /Trivial work is one move: make the small change yourself/);
const autoAlwaysVerify = extension.buildCoraPiSystemPrompt("auto", "fast", { alwaysVerifyEdits: true });
assert.match(autoAlwaysVerify, /"Always verify edits with a worker"/);
assert.doesNotMatch(autoAlwaysVerify, /Small, low-risk changes are yours to make/);
assert.match(autoAlwaysVerify, /Trivial work is two moves/);
assert.match(execute, /Trivial work is two moves/);
assert.doesNotMatch(execute, /make the small change yourself/);
assert.doesNotMatch(automation, /codara_remember|codara_recall/, "the automation roster has no memory tools");
// An untrusted pull request's manager has only the orchestration bridge tools,
// so the prompt must not send it to tools it does not have.
assert.match(auto, /codara_plan_update/);
assert.match(auto, /call codara_tools/);
for (const mode of ["auto", "execute"]) {
  const untrusted = extension.buildCoraPiSystemPrompt(mode, "fast", { untrusted: true });
  for (const tool of ["codara_plan_update", "codara_tools", "web_search", "deep_search", "fetch_url", "codara_remember", "codara_recall"]) {
    assert.doesNotMatch(untrusted, new RegExp(`\\b${tool}\\b`), `untrusted ${mode} prompt names ${tool}`);
  }
}
// Memory guidance names both tiers and asks for an immediate save on a
// correction, which is what makes the global tier ever get written.
assert.match(auto, /save it right away with\s+codara_remember: scope global for the user's own preferences/);
assert.match(auto, /scope workspace for facts about this repository/);
assert.match(auto, /codara_recall/);
assert.doesNotMatch(auto, /most runs teach nothing/);
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
  "npx playwright codegen https://example.com",
  "npx playwright test --headed",
  "echo ready; open https://example.com",
  // A shell's -c script and an eval string are command lines of their own;
  // quote-aware splitting must not hide a launch inside them.
  'bash -c "cd app && open http://localhost:3000"',
  "sh -lc 'npm run build; xdg-open http://localhost:3000'",
  "eval 'open https://example.com'",
  "BROWSER=1 open https://example.com",
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
  "npx playwright test tests/e2e/chat.spec.ts",
  "npx playwright install chromium",
  "pnpm exec playwright test",
  "git commit -m 'docs: explain; open the panel first'",
  'echo "step one; open the settings"',
  'bash -c "npx playwright test && echo done"',
  "CI=1 npx playwright test",
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
assert.match(
  workerExtensionSource,
  /if \(!untrustedPullRequest\) \{\s*registerScratchpadTool\(pi, process\.env\.CODARA_PI_SCRATCHPAD_PATH/,
);
assert.match(workerExtensionSource, /never hidden reasoning/);
assert.match(workerExtensionSource, /For greetings, opinions, and questions/);
assert.match(workerExtensionSource, /The result summary\s+is shown to the user verbatim/);
assert.doesNotMatch(workerExtensionSource, /One concise outcome sentence/);
assert.doesNotMatch(workerExtensionSource, /promptSnippet: tool\.description/);
assert.doesNotMatch(managerExtensionSource, /promptSnippet: tool\.description/);
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

for (const automation of [false, true]) {
  assert.equal(policy.isWorkerSafeBridgeTool("codara_remember", automation, {}), false);
  assert.equal(policy.isWorkerSafeBridgeTool("codara_remember", automation, { CODARA_PI_DIRECT_TASK: "1" }), !automation);
}
assert.equal(policy.isWorkerSafeBridgeTool("codara_remember", false, { CODARA_PI_DIRECT_TASK: "1", CODARA_PI_PROJECT_POLICY: "untrusted-pull-request" }), false);
for (const tool of ["codara_worktree_create", "codara_worktree_list", "codara_worktree_remove"]) {
  assert.equal(policy.isWorkerSafeBridgeTool(tool, false, {}), false, `${tool} stays out of chat workers`);
  assert.equal(policy.isWorkerSafeBridgeTool(tool, true, { CODARA_PI_DIRECT_TASK: "1" }), false, `${tool} stays out of loom workers`);
  assert.equal(policy.isWorkerSafeBridgeTool(tool, false, { CODARA_PI_DIRECT_TASK: "1" }), true, `${tool} reaches a direct task`);
  assert.equal(
    policy.isWorkerSafeBridgeTool(tool, false, { CODARA_PI_DIRECT_TASK: "1", CODARA_PI_PROJECT_POLICY: "untrusted-pull-request" }),
    false,
  );
}
assert.match(workerExtensionSource, /CODARA_PI_DIRECT_STUDIO_TOOLS !== "1" &&\s+tool.name !== "codara_remember" &&\s+tool.name !== "codara_recall"/);
assert.equal(policy.isWorkerSafeBridgeTool("codara_recall", false, { CODARA_PI_DIRECT_TASK: "1" }), true);
assert.equal(policy.isWorkerSafeBridgeTool("codara_recall", false, {}), false, "delegated workers get memory in the prompt, not the search tool");
assert.equal(policy.isWorkerSafeBridgeTool("codara_recall", true, { CODARA_PI_DIRECT_TASK: "1" }), false);

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

// The access fence. Names are asserted against Pi 0.84.4's REAL tool
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
  assert.equal(blocked("fetch_url")?.block, true, "readonly blocks fetch_url");
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
  assert.equal(blocked("fetch_url")?.block, true, "edits blocks fetch_url (no network)");
  assert.equal(
    policy.fenceDecision("fetch_url", noInput, policy.fencedToolNames({ CODARA_PI_WORKER_BLOCKED_TOOLS: "WebFetch" }), {})?.block,
    true,
    "a bare WebFetch block also covers fetch_url",
  );
  assert.equal(blocked("codara_terminal_create")?.block, true, "edits blocks terminal create");
  assert.equal(blocked("codara_terminal_run")?.block, true, "edits blocks terminal run, which executes a command");
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
  const env = { CODARA_PI_WORKER_BLOCKED_TOOLS: "codara_preview_evaluate,codara_preview_type" };
  const fence = policy.fencedToolNames(env);
  const decide = (steps) => policy.fenceDecision("codara_preview_run", { steps }, fence, env);
  assert.equal(decide([{ action: "snapshot" }, { action: "click", selector: "#open" }]), undefined);
  for (const action of ["evaluate", "type"]) {
    const result = decide([{ action: "click", selector: "#submit" }, { action }, { action: "snapshot" }]);
    assert.equal(result?.block, true, `a blocked ${action} must veto the whole batch before its earlier mutation`);
    assert.match(result.reason, /step 2/);
    assert.match(result.reason, /No batch steps were run/);
  }
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

  const hostHandlers = new Map();
  const entries = [];
  let aborts = 0;
  compaction.registerContextCompaction({ on: (event, handler) => hostHandlers.set(event, handler), appendEntry: (...args) => entries.push(args) }, { CODARA_PI_HOST_COMPACTION: "1", CODARA_PI_COMPACT_AT_TOKENS: "1000" });
  assert.equal(hostHandlers.has("agent_end"), false, "host-owned workers must not race an asynchronous extension compaction");
  const hostContext = { getContextUsage: () => ({ tokens: 1500, contextWindow: 1000000 }), abort: () => { aborts += 1; } };
  const turnEnd = hostHandlers.get("turn_end");
  turnEnd({ toolResults: [] }, hostContext);
  turnEnd({ toolResults: [{ toolName: "submit_result" }] }, hostContext);
  assert.equal(aborts, 0, "completed answers and submitted results do not need a continuation");
  turnEnd({ toolResults: [{ toolName: "read" }] }, hostContext);
  turnEnd({ toolResults: [{ toolName: "read" }] }, hostContext);
  assert.equal(aborts, 1);
  assert.equal(entries[0][0], "codara-context-pause");
  assert.equal(entries[0][1].reason, "threshold");
  hostHandlers.get("session_compact")({});
  turnEnd({ toolResults: [{ toolName: "read" }] }, hostContext);
  assert.equal(aborts, 2, "a completed compaction re-arms later tool rounds");

  const managerHandlers = new Map();
  const managerEntries = [];
  compaction.registerContextCompaction({ on: (event, handler) => managerHandlers.set(event, handler), appendEntry: (...args) => managerEntries.push(args) }, { CODARA_PI_HOST_COMPACTION: "settled", CODARA_PI_COMPACT_AT_TOKENS: "1000" });
  assert.equal(managerHandlers.has("turn_end"), false);
  managerHandlers.get("agent_end")({}, hostContext);
  managerHandlers.get("agent_end")({}, hostContext);
  assert.equal(managerEntries.length, 1, "manager marks one request for host settlement");
  assert.equal(aborts, 2, "manager compaction cannot abort its completed answer");
  managerHandlers.get("session_compact_failed")({});
  managerHandlers.get("agent_end")({}, hostContext);
  assert.equal(managerEntries.length, 2, "failed native compaction cannot disable the early trigger forever");

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

// ── Fast mode (resources/pi-cora/service-tier.ts) ──────────────────────────
// One opt-in setting: OpenAI's priority tier, or Anthropic's `speed: "fast"`
// on the Claude models that accept it. The extension's before_provider_request
// hook is the last code to touch the request body, so this is where it is
// decided, for the manager and for every worker.
{
  const tier = loadTypeScriptModule(
    path.join(__dirname, "..", "resources", "pi-cora", "service-tier.ts"),
  );
  const shared = loadTypeScriptModule(
    path.join(__dirname, "..", "src", "shared", "fast-mode.ts"),
  );
  const apply = tier.applyServiceTierPolicy;
  const FAST = tier.OPENAI_FAST_SERVICE_TIER;
  const BETA = "fast-mode-2026-02-01";
  // "priority" and "fast" are OpenAI aliases for the same tier (renamed to
  // "Fast mode" on 2026-07-30). We send "priority": it is the spelling pi-ai
  // types and prices, and the only one in the OpenAI Responses service_tier
  // union.
  assert.equal(FAST, "priority", "pi-ai types and prices the 'priority' spelling");

  // The extension cannot import src/shared, so its copies must not drift.
  assert.deepEqual([...tier.ANTHROPIC_FAST_MODE_MODELS], [...shared.ANTHROPIC_FAST_MODE_MODELS]);
  assert.equal(tier.ANTHROPIC_FAST_MODE_BETA, shared.ANTHROPIC_FAST_MODE_BETA);
  assert.equal(tier.ANTHROPIC_FAST_MODE_BETA, BETA);
  assert.equal(tier.FAST_MODE_FALLBACK_MARKER, shared.FAST_MODE_FALLBACK_MARKER);
  for (const model of [
    "claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "Claude-Opus-5", "claude-opus-5:1m",
    "claude-opus-4-8-20260601", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-5",
    "claude-sonnet-5-5", "claude-fable-5-1", "claude-haiku-5-5", "", undefined, 42,
  ]) {
    assert.equal(
      tier.anthropicModelSupportsFastMode(model),
      shared.anthropicModelSupportsFastMode(typeof model === "string" ? model : undefined),
      `extension and app disagree about ${String(model)}`,
    );
  }
  for (const model of ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"]) {
    assert.equal(tier.anthropicModelSupportsFastMode(model), true, `${model} supports fast mode`);
  }
  // Opus 4.7 errors on speed:fast and Opus 4.6 silently ignores it; every
  // Sonnet, Haiku and Fable rejects it.
  for (const model of ["claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-5", "claude-fable-5-1", "claude-haiku-4-5"]) {
    assert.equal(tier.anthropicModelSupportsFastMode(model), false, `${model} has no fast mode`);
  }

  // (a) Setting OFF: nothing fast-mode shaped on any request.
  for (const provider of ["openai-codex", "openai"]) {
    const body = apply({ model: "gpt-5.6-sol", input: [] }, provider, false);
    assert.equal("service_tier" in body, false, `${provider} must carry no tier when fast mode is off`);
  }
  assert.equal(
    "service_tier" in apply({ service_tier: "priority" }, "openai-codex", false),
    false,
    "fast mode off must strip a tier the body already carried",
  );
  {
    const body = apply(
      { model: "claude-opus-5", speed: "fast", betas: ["oauth-2025-04-20", BETA], messages: [] },
      "anthropic",
      false,
    );
    assert.equal("speed" in body, false, "fast mode off strips speed");
    assert.deepEqual(body.betas, ["oauth-2025-04-20"], "fast mode off strips only the fast beta");
    const lone = apply({ model: "claude-opus-5", betas: [BETA] }, "anthropic", false);
    assert.equal("betas" in lone, false, "an emptied beta list is removed, not sent empty");
  }

  // (b) Setting ON, OpenAI: the priority tier.
  for (const provider of ["openai-codex", "openai"]) {
    assert.equal(
      apply({ model: "gpt-5.6-sol", input: [] }, provider, true).service_tier,
      FAST,
      `${provider} must carry the fast tier when fast mode is on`,
    );
  }

  // (c) Setting ON, Anthropic, supported model: speed + beta, appended once
  // to whatever betas pi-ai already chose.
  for (const model of ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"]) {
    const body = apply(
      { model, betas: ["claude-code-20250219", "oauth-2025-04-20"], messages: [] },
      "anthropic",
      true,
    );
    assert.equal(body.speed, "fast", `${model} gets speed:fast`);
    assert.deepEqual(body.betas, ["claude-code-20250219", "oauth-2025-04-20", BETA]);
    assert.equal("service_tier" in body, false, "fast mode is not Anthropic's Priority Tier");
  }
  assert.deepEqual(apply({ model: "claude-opus-5" }, "anthropic", true).betas, [BETA]);
  assert.deepEqual(
    apply({ model: "claude-opus-5", betas: [BETA] }, "anthropic", true).betas,
    [BETA],
    "the beta is never duplicated",
  );

  // (d) Setting ON, Anthropic, unsupported model: standard speed, nothing
  // added, and a stray speed is removed, because those models answer it with
  // an error.
  for (const model of ["claude-sonnet-5", "claude-opus-4-7", "claude-fable-5-1", "claude-haiku-4-5"]) {
    const body = apply({ model, speed: "fast", betas: [BETA, "oauth-2025-04-20"] }, "anthropic", true);
    assert.equal("speed" in body, false, `${model} must not carry speed`);
    assert.deepEqual(body.betas, ["oauth-2025-04-20"], `${model} must not carry the fast beta`);
  }

  // (e) Anthropic never carries a service tier, either way.
  for (const fastMode of [false, true]) {
    for (const key of ["service_tier", "serviceTier"]) {
      const stripped = apply({ [key]: "priority", model: "claude-opus-5" }, "anthropic", fastMode);
      assert.equal(key in stripped, false, `anthropic must strip an inherited ${key} (fastMode=${fastMode})`);
    }
  }

  // (f) A declined model skips fast mode for either provider.
  assert.equal("speed" in apply({ model: "claude-opus-5" }, "anthropic", true, (m) => m === "claude-opus-5"), false);
  assert.equal("service_tier" in apply({ model: "gpt-5.6-sol" }, "openai-codex", true, () => true), false);

  assert.equal(tier.isAnthropicProvider("anthropic"), true);
  assert.equal(tier.isAnthropicProvider("ANTHROPIC"), true);
  assert.equal(tier.isAnthropicProvider("openai-codex"), false);
  assert.equal(tier.isOpenAiProvider("openai-codex"), true);
  assert.equal(tier.isOpenAiProvider("anthropic"), false);

  // An unknown provider never GAINS anything from Codara.
  for (const provider of ["some-future-provider", "openrouter", "xai"]) {
    const body = apply({ model: "claude-opus-5" }, provider, true);
    assert.equal("service_tier" in body || "speed" in body || "betas" in body, false, `${provider} gains nothing`);
  }

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
    assert.equal(apply(odd, "anthropic", true), odd);
  }

  // Refusal classification: only failures that can be about fast mode.
  const piAiDist = path.join(
    __dirname, "..", "node_modules", "@earendil-works", "pi-coding-agent", "node_modules",
    "@earendil-works", "pi-ai", "dist",
  );
  const { isRetryableAssistantError } = await import(
    require("node:url").pathToFileURL(path.join(piAiDist, "utils", "retry.js")).href
  );
  const { isContextOverflow } = await import(
    require("node:url").pathToFileURL(path.join(piAiDist, "utils", "overflow.js")).href
  );
  const refusals = [
    ['400 {"type":"error","error":{"type":"invalid_request_error","message":"speed: fast mode is not supported for this model"}}', false, "400"],
    ['429 {"type":"error","error":{"type":"rate_limit_error","message":"Fast mode rate limit exceeded"}}', true, "429"],
    ['529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', true, "529"],
    ['400 {"type":"error","error":{"type":"invalid_request_error","message":"Fast mode requires usage credits; check billing"}}', false, "400"],
    ['403 {"type":"error","error":{"type":"permission_error","message":"Fast mode has been disabled by your organization"}}', false, "403"],
    ["400 Unsupported service_tier: priority", false, "400"],
    // Matched on status alone: it may have nothing to do with fast mode, so it
    // only cools fast mode down instead of turning it off for the process.
    ['400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.0.content.1.image.source.base64: image exceeds 5 MB maximum"}}', true, "400"],
    ['404 {"type":"error","error":{"type":"not_found_error","message":"Not found"}}', true, "404"],
  ];
  for (const [error, transient, status] of refusals) {
    assert.deepEqual(tier.classifyFastModeRefusal(error), { transient, status }, error);
    const rewritten = tier.fastModeFallbackError("claude-opus-5", tier.classifyFastModeRefusal(error));
    assert.ok(rewritten.startsWith(tier.FAST_MODE_FALLBACK_MARKER));
    assert.doesNotMatch(rewritten, /billing/i, "the provider's own wording is never carried over");
    const failed = { role: "assistant", stopReason: "error", errorMessage: rewritten, content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    assert.equal(isRetryableAssistantError(failed), true, `Pi must retry after: ${error}`);
    assert.equal(isContextOverflow(failed, 200_000), false, "the fallback must not read as an overflow");
    const note = shared.fastModeFallbackNote(rewritten);
    assert.ok(note && note.includes("claude-opus-5 declined fast mode") && !note.includes(tier.FAST_MODE_FALLBACK_MARKER), note);
  }
  assert.equal(shared.fastModeFallbackNote("429 rate limited"), null);
  for (const unrelated of [
    '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    '400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 300000 tokens > 200000 maximum"}}',
    "socket hang up",
    "500 Internal server error",
    "",
    undefined,
    `${tier.FAST_MODE_FALLBACK_MARKER} claude-opus-5 declined fast mode (HTTP 400)`,
  ]) {
    assert.equal(tier.classifyFastModeRefusal(unrelated), null, `not a fast-mode refusal: ${unrelated}`);
  }

  // Declines: permanent for a refusal, a cooldown for a rate limit.
  {
    let clock = 1_000;
    const declines = tier.createFastModeDeclines(() => clock);
    declines.decline("claude-opus-4-7", { transient: false, status: "400" });
    declines.decline("claude-opus-5", { transient: true, status: "429" });
    assert.equal(declines.declined("claude-opus-4-7"), true);
    assert.equal(declines.declined("claude-opus-5"), true);
    assert.equal(declines.declined("gpt-5.6-sol"), false);
    clock += tier.FAST_MODE_COOLDOWN_MS + 1;
    assert.equal(declines.declined("claude-opus-5"), false, "a rate-limit decline cools down");
    assert.equal(declines.declined("claude-opus-4-7"), true, "a refusal lasts for the process");
  }

  // Registration: the hook shapes requests, and a refused fast request is
  // retried once at standard speed with the marker note.
  function register(env) {
    const handlers = new Map();
    tier.registerServiceTierPolicy({ on: (event, handler) => handlers.set(event, handler) }, env);
    return handlers;
  }
  {
    const handlers = register({ CODARA_PI_PROVIDER: "anthropic", CODARA_PI_FAST_MODE: "1" });
    const request = handlers.get("before_provider_request");
    const messageEnd = handlers.get("message_end");
    assert.ok(request, "before_provider_request must be the fast-mode seam");
    assert.ok(messageEnd, "message_end drives the fallback");
    assert.equal(
      "service_tier" in request({ type: "before_provider_request", payload: { service_tier: "priority" } }),
      false,
      "an anthropic session never sends a service tier",
    );
    const first = request({ type: "before_provider_request", payload: { model: "claude-opus-5", betas: ["oauth-2025-04-20"] } });
    assert.equal(first.speed, "fast");
    const failed = {
      role: "assistant",
      stopReason: "error",
      errorMessage: '400 {"type":"error","error":{"type":"invalid_request_error","message":"speed is not available"}}',
      content: [],
    };
    const replaced = messageEnd({ type: "message_end", message: failed });
    assert.ok(replaced?.message, "a refused fast request is rewritten");
    assert.equal(replaced.message.role, "assistant", "the replacement keeps the role");
    assert.equal(replaced.message.stopReason, "error");
    assert.ok(replaced.message.errorMessage.startsWith(tier.FAST_MODE_FALLBACK_MARKER));
    // Pi's retry rebuilds the body and asks the hook again: standard speed now.
    const retry = request({ type: "before_provider_request", payload: { model: "claude-opus-5", betas: ["oauth-2025-04-20"] } });
    assert.equal("speed" in retry, false, "the retry runs at standard speed");
    assert.deepEqual(retry.betas, ["oauth-2025-04-20"]);
    // Only once: the retry's own failure is reported as it is.
    assert.equal(messageEnd({ type: "message_end", message: { ...failed } }), undefined);
    // A successful fast reply, a user message, or a request that never asked
    // for fast mode is left alone.
    const other = register({ CODARA_PI_PROVIDER: "anthropic", CODARA_PI_FAST_MODE: "1" });
    other.get("before_provider_request")({ type: "before_provider_request", payload: { model: "claude-opus-5" } });
    assert.equal(other.get("message_end")({ type: "message_end", message: { role: "user", content: [] } }), undefined);
    assert.equal(other.get("message_end")({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [] } }), undefined);
    const sonnet = register({ CODARA_PI_PROVIDER: "anthropic", CODARA_PI_FAST_MODE: "1" });
    sonnet.get("before_provider_request")({ type: "before_provider_request", payload: { model: "claude-sonnet-5" } });
    assert.equal(sonnet.get("message_end")({ type: "message_end", message: { ...failed } }), undefined);
  }
  {
    const handlers = register({ CODARA_PI_PROVIDER: "openai-codex", CODARA_PI_FAST_MODE: "1" });
    const request = handlers.get("before_provider_request");
    assert.equal(request({ type: "before_provider_request", payload: { model: "gpt-5.6-sol" } }).service_tier, FAST);
    const replaced = handlers.get("message_end")({
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "400 Unsupported service_tier: priority", content: [] },
    });
    assert.ok(replaced.message.errorMessage.startsWith(tier.FAST_MODE_FALLBACK_MARKER));
    assert.equal("service_tier" in request({ type: "before_provider_request", payload: { model: "gpt-5.6-sol" } }), false);
  }
  {
    // Fast mode off registers no fallback at all.
    const handlers = register({ CODARA_PI_PROVIDER: "anthropic" });
    assert.equal(handlers.has("message_end"), false);
    assert.equal("speed" in handlers.get("before_provider_request")({ payload: { model: "claude-opus-5" } }), false);
  }

  // The real request, offline: pi-ai's Anthropic builder runs the hook, and
  // the SDK it uses turns `betas` into the anthropic-beta header and sends
  // `speed` in the body. A stub fetch answers, so nothing leaves the machine.
  {
    const toUrl = (file) => require("node:url").pathToFileURL(path.join(piAiDist, file)).href;
    const anthropic = await import(toUrl("api/anthropic-messages.js"));
    const { getModel } = await import(toUrl("compat.js"));
    async function capture(modelId, fastMode) {
      const sent = [];
      const fetchStub = async (url, init) => {
        sent.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) });
        return new Response(
          JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "offline stub" } }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      };
      const stream = anthropic.stream(
        getModel("anthropic", modelId),
        { systemPrompt: "x", messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
        {
          apiKey: "sk-ant-oat01-offline-test",
          fetch: fetchStub,
          maxRetries: 0,
          onPayload: (payload) => apply(payload, "anthropic", fastMode),
        },
      );
      for await (const _event of stream) { /* drain */ }
      assert.equal(sent.length, 1, "exactly one request was attempted");
      return sent[0];
    }
    const fast = await capture("claude-opus-5", true);
    assert.equal(new URL(fast.url).hostname, "api.anthropic.com");
    assert.match(new URL(fast.url).search, /beta=true/, "fast mode needs the beta messages endpoint");
    assert.equal(fast.body.speed, "fast");
    assert.equal("betas" in fast.body, false, "betas travel as a header, not in the body");
    assert.ok(fast.headers.get("anthropic-beta").split(",").includes(BETA), fast.headers.get("anthropic-beta"));
    assert.ok(fast.headers.get("anthropic-beta").split(",").includes("oauth-2025-04-20"), "pi-ai's own betas survive");
    const standard = await capture("claude-opus-5", false);
    assert.equal("speed" in standard.body, false);
    assert.equal(standard.headers.get("anthropic-beta").split(",").includes(BETA), false);
    const sonnet = await capture("claude-sonnet-5", true);
    assert.equal("speed" in sonnet.body, false, "an unsupported model is never sent speed");
    assert.equal(sonnet.headers.get("anthropic-beta").split(",").includes(BETA), false);
  }

  // Both extensions must wire it up.
  for (const file of ["index.ts", "worker.ts"]) {
    const source = fs.readFileSync(
      path.join(__dirname, "..", "resources", "pi-cora", file),
      "utf8",
    );
    assert.match(
      source,
      /registerServiceTierPolicy\(pi\)/,
      `${file} must register the fast-mode policy`,
    );
  }
}

// Studio renews the Claude login: a trusted Claude process asks over the
// agent socket instead of spending its refresh token.
{
  const renewal = loadTypeScriptModule(
    path.join(__dirname, "..", "resources", "pi-cora", "anthropic-refresh.ts"),
  );
  const trusted = {
    CODARA_PI_PROVIDER: "anthropic",
    CODARA_PI_PROJECT_POLICY: "trusted",
    CODARA_PI_ACCOUNT_PROFILE_ID: "acct-1",
  };
  assert.equal(renewal.codaraAnthropicRenewalAccount(trusted), "acct-1");
  assert.equal(
    renewal.codaraAnthropicRenewalAccount({ ...trusted, CODARA_PI_PROVIDER: "openai-codex" }),
    null,
  );
  assert.equal(
    renewal.codaraAnthropicRenewalAccount({
      ...trusted,
      CODARA_PI_PROJECT_POLICY: "untrusted-pull-request",
      SPARK_AGENT_CAPABILITY: "scoped",
    }),
    "acct-1",
    "an imported-PR process renews through its scoped capability too",
  );
  assert.equal(renewal.codaraAnthropicRenewalAccount({ ...trusted, CODARA_PI_ACCOUNT_PROFILE_ID: " " }), null);

  const registered = [];
  const requests = [];
  let answer = { access: "access-new", refresh: "refresh-new", expires: 1234 };
  renewal.registerCodaraAnthropicRenewal(
    { registerProvider: (name, config) => registered.push({ name, config }) },
    {
      accountProfileId: "acct-1",
      request: async (method, params, timeoutMs) => {
        requests.push({ method, params, timeoutMs });
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  );
  assert.equal(registered.length, 1);
  assert.equal(registered[0].name, "anthropic");
  const oauth = registered[0].config.oauth;
  assert.deepEqual(Object.keys(registered[0].config), ["oauth"], "models, base URL and API-key login stay Pi's");
  const stored = { type: "oauth", access: "access-old", refresh: "refresh-old", expires: 1 };
  const refreshed = await oauth.refreshToken(stored);
  assert.deepEqual(refreshed, { type: "oauth", access: "access-new", refresh: "refresh-new", expires: 1234 });
  assert.equal(requests[0].method, "accounts.anthropic.renew");
  assert.deepEqual(requests[0].params, { accountProfileId: "acct-1", refreshToken: "refresh-old" });
  assert.equal(oauth.getApiKey(refreshed), "access-new");
  await assert.rejects(oauth.login({}), /account settings/);
  answer = new Error("Codara agent socket unreachable: ECONNREFUSED");
  await assert.rejects(oauth.refreshToken(stored), /Codara could not renew the Claude login: .*ECONNREFUSED/);
  answer = { access: "", refresh: "x", expires: 1 };
  await assert.rejects(oauth.refreshToken(stored), /no access token/);
  // Pi 0.87 bounds the refresh with its own signal; the renewal gives way.
  answer = { access: "late", refresh: "late", expires: 1 };
  const deadline = new AbortController();
  const slow = renewal.registerCodaraAnthropicRenewal;
  const slowRegistered = [];
  slow(
    { registerProvider: (name, config) => slowRegistered.push(config) },
    { accountProfileId: "acct-1", request: () => new Promise(() => {}) },
  );
  const pending = slowRegistered[0].oauth.refreshToken(stored, deadline.signal);
  deadline.abort();
  await assert.rejects(pending, /deadline/);

  for (const file of ["index.ts", "worker.ts"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", "resources", "pi-cora", file), "utf8");
    assert.match(source, /registerCodaraAnthropicRenewal\(pi,/, `${file} must route the Claude refresh to Studio`);
  }
  assert.equal(typeof studioBridge.requestCodara, "function", "the bridge exposes the socket call");
}

{
  const families = loadTypeScriptModule(
    path.join(__dirname, "..", "resources", "pi-cora", "tool-families.ts"),
  );
  process.env.SPARK_MCP_MODE = "execute";
  delete require.cache[require.resolve(studioBridgePath)];
  const managerTools = require(studioBridgePath).listTools();
  const byFamily = {};
  for (const tool of managerTools) {
    const family = families.studioToolFamily(tool.name);
    if (family) byFamily[family] = (byFamily[family] ?? 0) + 1;
    const snippet = families.toolPromptSnippet(tool.description);
    assert.ok(snippet.length > 0 && snippet.length <= 100, `${tool.name} snippet stays one short line`);
    assert.doesNotMatch(snippet, /\n/, `${tool.name} snippet is a single line`);
  }
  for (const family of families.STUDIO_TOOL_FAMILIES) {
    assert.ok(byFamily[family] > 0, `the manager roster has ${family} tools`);
    assert.ok(families.STUDIO_FAMILY_GUIDANCE[family].length > 0);
  }
  for (const core of ["codara_spawn_workers", "codara_complete", "codara_ask_user", "codara_remember", "codara_wait_for_workers"]) {
    assert.equal(families.studioToolFamily(core), null, `${core} is never deferred`);
  }
  assert.equal(families.studioToolFamily("codara_list_automations"), "automations");
  assert.equal(families.studioToolFamily("codara_set_automation_enabled"), "automations");
  assert.equal(families.studioToolFamily("codara_worktree_remove"), "worktrees");
  assert.equal(
    families.toolPromptSnippet("Spawn workers now. They run in parallel and report back."),
    "Spawn workers now.",
  );
  assert.match(families.toolPromptSnippet("x ".repeat(200)), /\.\.\.$/);

  assert.deepEqual(families.familiesForRequest("hi, what does run-store.ts do?"), []);
  assert.deepEqual(families.familiesForRequest("draw me a diagram of the auth flow"), ["whiteboard"]);
  assert.deepEqual(families.familiesForRequest("start the dev server and check localhost:5173"), ["browser", "terminal"]);
  assert.deepEqual(families.familiesForRequest("every monday summarize open PRs"), ["automations"]);
  assert.deepEqual(families.familiesForRequest("move the card to done on the board"), ["board"]);
  assert.deepEqual(families.familiesForRequest("do this in separate worktrees"), ["worktrees"]);

  const branch = [
    { type: "message", message: { role: "user", content: "hello" } },
    {
      type: "message",
      message: { role: "assistant", content: [{ type: "toolCall", name: "codara_tools", arguments: {} }] },
    },
    {
      type: "message",
      message: { role: "toolResult", toolName: "codara_tools", addedToolNames: ["codara_whiteboard_get"] },
    },
    {
      type: "message",
      message: { role: "assistant", content: [{ type: "toolCall", name: "codara_preview_navigate" }] },
    },
    { type: "custom", message: { role: "assistant", content: [{ type: "toolCall", name: "codara_board_get" }] } },
  ];
  assert.deepEqual([...families.familiesUsedInBranch(branch)].sort(), ["browser", "whiteboard"]);
  assert.equal(families.branchHasAssistantTurn(branch), true);
  assert.equal(families.branchHasAssistantTurn(branch.slice(0, 1)), false);

  assert.match(managerExtensionSource, /name: STUDIO_TOOL_LOADER_NAME/);
  assert.match(managerExtensionSource, /familiesUsedInBranch\(ctx\.sessionManager\.getBranch\(\)\)/);
  assert.match(managerExtensionSource, /CODARA_PI_ALWAYS_VERIFY_EDITS/);
  console.log("pi manager Studio tool families (lazy loading): ok");
}

console.log("pi Cora mode + execution-policy prompts: ok");
console.log("pi Claude login renewal (through Studio): ok");
console.log("pi worker policy (roster + access fence): ok");
console.log("pi session compaction (256k trigger): ok");
console.log("pi fast mode (opt-in, OpenAI tier + Claude Opus speed, standard-speed fallback): ok");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
