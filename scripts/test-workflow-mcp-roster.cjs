// Guards who may run workflows: the codara_workflow_* tools are on Cora's
// execute roster only (never a worker's, an automation's, a plain terminal's
// or an imported pull request's), the socket refuses workflow.* for imported
// pull requests and blocks the mutating verbs mid-compaction, and
// workflow.run and workflow.save post the consent question before they start
// or write anything.
//
//   node scripts/test-workflow-mcp-roster.cjs

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { check, finish } = require("./workflow-test-harness.cjs");

const SERVER = path.join(__dirname, "..", "resources", "codara-studio-mcp", "server.js");
const SOCKET = path.join(__dirname, "..", "src", "main", "agent-socket.ts");
const WORKFLOW_TOOLS = [
  "codara_workflow_list",
  "codara_workflow_get",
  "codara_workflow_check",
  "codara_workflow_run",
  "codara_workflow_status",
  "codara_workflow_wait",
  "codara_workflow_stop",
  "codara_workflow_resume",
  "codara_workflow_save",
];

const home = fs.mkdtempSync(path.join(os.tmpdir(), "codara-workflow-roster-"));
fs.writeFileSync(path.join(home, "agent-socket.json"), JSON.stringify({ url: "http://127.0.0.1:1", token: "f".repeat(64) }));

function roster(env) {
  const saved = { ...process.env };
  for (const key of ["SPARK_MCP_MODE", "SPARK_RUN_ID", "CODARA_PI_PROJECT_POLICY"]) delete process.env[key];
  Object.assign(process.env, { SPARK_HOME_DIR: home }, env);
  delete require.cache[require.resolve(SERVER)];
  try {
    return new Set(require(SERVER).listTools().map((tool) => tool.name));
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

try {
  const execute = roster({ SPARK_MCP_MODE: "execute", SPARK_RUN_ID: "run-x" });
  check("execute carries every workflow tool", WORKFLOW_TOOLS.every((name) => execute.has(name)), [...execute].filter((n) => n.includes("workflow")));
  for (const mode of ["worker", "automation", "talk"]) {
    const tools = roster({ SPARK_MCP_MODE: mode, SPARK_RUN_ID: "run-x" });
    check(`${mode} carries no workflow tool`, WORKFLOW_TOOLS.every((name) => !tools.has(name)));
  }
  const terminal = roster({});
  check("a plain terminal session carries no workflow tool", WORKFLOW_TOOLS.every((name) => !terminal.has(name)));
  const untrusted = roster({
    SPARK_MCP_MODE: "execute",
    SPARK_RUN_ID: "run-x",
    CODARA_PI_PROJECT_POLICY: "untrusted-pull-request",
  });
  check("an imported pull request carries no workflow tool", WORKFLOW_TOOLS.every((name) => !untrusted.has(name)));

  const socket = fs.readFileSync(SOCKET, "utf8");
  check(
    "the socket refuses workflow.* for imported pull requests",
    /method\.startsWith\("workflow\."\)/.test(socket.slice(socket.indexOf("function isUntrustedPullRequestBlockedMethod"))),
  );
  const midCompaction = socket.slice(
    socket.indexOf("const MID_COMPACTION_BLOCKED_METHODS"),
    socket.indexOf("]);", socket.indexOf("const MID_COMPACTION_BLOCKED_METHODS")),
  );
  for (const verb of ["workflow.run", "workflow.stop", "workflow.resume", "workflow.save"]) {
    check(`${verb} waits out a compaction`, midCompaction.includes(`"${verb}"`));
  }
  const body = (name) => {
    const start = socket.indexOf(`async function ${name}(`);
    return start < 0 ? "" : socket.slice(start, socket.indexOf("\nasync function ", start + 10));
  };
  const run = body("handleWorkflowRun");
  check(
    "workflow.run asks before it starts anything",
    run.includes("requestUserConsent(") && run.indexOf("requestUserConsent(") < run.indexOf("startWorkflowRun("),
  );
  check("workflow.run stops on a declined consent", /if \(!consent\.approved\) return consent\.response;/.test(run));
  const save = body("handleWorkflowSave");
  check(
    "workflow.save asks before it writes",
    save.includes("requestUserConsent(") && save.indexOf("requestUserConsent(") < save.indexOf("saveWorkflow("),
  );
  const caller = body("resolveWorkflowCallerRun");
  check("a workflow or loom run cannot start workflows", /run\.workflow \|\| run\.automationId/.test(caller));
} catch (err) {
  check("suite crashed", false, err && err.stack ? err.stack : String(err));
} finally {
  fs.rmSync(home, { recursive: true, force: true });
  finish();
}
