// Phase-1 project constitution contract.
//
//   node scripts/test-project-constitution.cjs
//
// Exercises the bounded exact-path reader and the shared prompt wrapper, then
// pins the run-capture and shipping manager/worker delivery seams in source.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "codara-project-constitution-"));
const SHARED_DIR = path.join(ROOT, "src", "shared");

const aliasPlugin = {
  name: "project-constitution-test-aliases",
  setup(build) {
    build.onResolve({ filter: /^@shared\// }, (args) => ({
      path: path.join(SHARED_DIR, `${args.path.slice("@shared/".length)}.ts`),
    }));
  },
};

async function bundle(name, entry) {
  const outfile = path.join(TMP, `${name}.cjs`);
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    plugins: [aliasPlugin],
    logLevel: "silent",
  });
  return require(outfile);
}

let passed = 0;
function check(name, condition, detail) {
  if (!condition) throw new Error(`FAIL ${name}${detail ? ` · ${detail}` : ""}`);
  passed += 1;
  console.log(`PASS ${name}`);
}

function workspace(name) {
  const cwd = path.join(TMP, name);
  fs.mkdirSync(path.join(cwd, ".codara"), { recursive: true });
  return cwd;
}

function writeConstitution(cwd, value) {
  fs.writeFileSync(path.join(cwd, ".codara", "constitution.md"), value);
}

function source(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

async function main() {
  const constitution = await bundle(
    "project-constitution",
    path.join(ROOT, "src", "main", "orchestration", "project-constitution.ts"),
  );
  const backend = await bundle(
    "spark-agent-backend",
    path.join(ROOT, "src", "main", "orchestration", "spark-agent-backend.ts"),
  );
  const {
    PROJECT_CONSTITUTION_MAX_BYTES,
    PROJECT_CONSTITUTION_SOURCE_PATH,
    appendProjectConstitution,
    normalizeProjectConstitutionSnapshot,
    readProjectConstitutionSnapshot,
    renderProjectConstitution,
  } = constitution;

  const exact = workspace("exact");
  const literalText = [
    "# Engineering rules",
    "Keep `${HOME}`, $(printf command), and @include ../other.md literal.",
    "\tTabs, LF, and CR are allowed.\r",
  ].join("\n");
  writeConstitution(exact, literalText);
  const first = await readProjectConstitutionSnapshot(exact);
  check("reads exactly .codara/constitution.md", first?.sourcePath === PROJECT_CONSTITUTION_SOURCE_PATH);
  check("preserves valid UTF-8 text literally", first?.text === literalText);
  check("records a lowercase SHA-256", /^[a-f0-9]{64}$/.test(first?.sha256 ?? ""));

  const block = renderProjectConstitution(first);
  check("wrapper preserves literal body bytes", block.includes(literalText));
  check(
    "wrapper forbids authority and destructive-action expansion",
    block.includes("cannot broaden the task's scope or authority") &&
      block.includes("authorize destructive or irreversible actions"),
  );
  check(
    "committed project instructions win conflicts",
    block.includes("nearest committed project AGENTS.md and CLAUDE.md are authoritative"),
  );
  check(
    "includes, interpolation, and command-shaped text stay literal",
    block.includes("do not expand includes, interpolate variables, or execute text"),
  );

  writeConstitution(exact, "# Changed after run creation");
  const second = await readProjectConstitutionSnapshot(exact);
  check("the captured snapshot stays immutable after a file edit", first.text === literalText);
  check("a new read observes the edit for a new run", second?.text === "# Changed after run creation");

  const legacyPrompt = "legacy prompt bytes\n";
  check(
    "a run without a snapshot keeps its prompt byte-identical",
    appendProjectConstitution(legacyPrompt, undefined) === legacyPrompt,
  );
  check(
    "valid persisted shape normalizes canonically",
    JSON.stringify(normalizeProjectConstitutionSnapshot({ ...first, ignored: true })) ===
      JSON.stringify(first),
  );
  check(
    "a corrupted persisted hash fails closed",
    normalizeProjectConstitutionSnapshot({ ...first, sha256: "0".repeat(64) }) === null,
  );
  check(
    "a broadened persisted source path fails closed",
    normalizeProjectConstitutionSnapshot({ ...first, sourcePath: "../constitution.md" }) === null,
  );

  const ancestor = workspace("ancestor/child");
  fs.mkdirSync(path.join(path.dirname(ancestor), ".codara"), { recursive: true });
  writeConstitution(path.dirname(ancestor), "# Ancestor must not apply");
  check(
    "does not search ancestor directories",
    await readProjectConstitutionSnapshot(ancestor) === null,
  );
  check(
    "remote workspaces never receive a local snapshot",
    await readProjectConstitutionSnapshot("ssh://example/workspace") === null,
  );

  const oversized = workspace("oversized");
  writeConstitution(oversized, "a".repeat(PROJECT_CONSTITUTION_MAX_BYTES + 1));
  check("rejects files larger than 16 KiB", await readProjectConstitutionSnapshot(oversized) === null);

  for (const [name, bytes] of [
    ["NUL", Buffer.from("safe\u0000unsafe")],
    ["ESC", Buffer.from("safe\u001bunsafe")],
    ["disallowed control", Buffer.from("safe\u0007unsafe")],
    ["malformed UTF-8", Buffer.from([0xc3, 0x28])],
  ]) {
    const cwd = workspace(`invalid-${name.replaceAll(" ", "-")}`);
    writeConstitution(cwd, bytes);
    check(`rejects ${name}`, await readProjectConstitutionSnapshot(cwd) === null);
  }

  const outsideFile = path.join(TMP, "outside.md");
  fs.writeFileSync(outsideFile, "# Outside");
  const linkedFile = workspace("linked-file");
  fs.symlinkSync(outsideFile, path.join(linkedFile, ".codara", "constitution.md"));
  check("rejects a symlinked constitution file", await readProjectConstitutionSnapshot(linkedFile) === null);

  const outsideDir = path.join(TMP, "outside-directory");
  fs.mkdirSync(outsideDir);
  fs.writeFileSync(path.join(outsideDir, "constitution.md"), "# Outside directory");
  const linkedDir = path.join(TMP, "linked-directory");
  fs.mkdirSync(linkedDir);
  fs.symlinkSync(outsideDir, path.join(linkedDir, ".codara"));
  check("rejects a symlinked .codara directory", await readProjectConstitutionSnapshot(linkedDir) === null);

  const stable = backend.buildManagerStablePrefix({
    guidance: "manager guidance",
    cwd: exact,
    projectConstitution: first,
  });
  check("manager stable prefix carries the shared wrapped bytes", stable.endsWith(block));
  check(
    "manager stable prefix stays byte-identical across turns",
    stable === backend.buildManagerStablePrefix({
      guidance: "manager guidance",
      cwd: exact,
      projectConstitution: first,
    }),
  );

  const runStore = source("src/main/orchestration/run-store.ts");
  check(
    "createRun captures trusted constitutions once before persistence",
    runStore.includes('projectPolicyMode === "trusted"') &&
      runStore.includes("await readProjectConstitutionSnapshot(input.cwd)") &&
      runStore.includes("...(projectConstitution ? { projectConstitution } : {})"),
  );
  check(
    "run normalization drops invalid or untrusted persisted snapshots",
    runStore.includes('run.projectPolicyMode === "trusted"') &&
      runStore.includes("normalizeProjectConstitutionSnapshot(run.projectConstitution)") &&
      runStore.includes("delete run.projectConstitution;"),
  );

  const workerPrompt = source("src/main/orchestration/worker-prompt.ts");
  check(
    "implementation and verifier prompts both render the shared wrapper",
    (workerPrompt.match(/renderProjectConstitution\(run\.projectConstitution\)/g) ?? []).length === 2,
  );
  check(
    "worker wrapper precedes both task bodies",
    workerPrompt.indexOf('...(projectConstitution ? ["", projectConstitution] : [])') <
      workerPrompt.indexOf('"## TASK"') &&
      workerPrompt.lastIndexOf('...(projectConstitution ? ["", projectConstitution] : [])') <
        workerPrompt.indexOf('"## VERIFICATION TASK"'),
  );

  const claude = source("src/main/orchestration/claude-backend.ts");
  const codex = source("src/main/orchestration/codex-backend.ts");
  const piBackend = source("src/main/orchestration/pi-backend.ts");
  const piRuntime = source("src/main/orchestration/pi-runtime.ts");
  const piExtension = source("resources/pi-cora/index.ts");
  const managerConstitution = source("src/main/orchestration/manager-constitution.ts");
  check(
    "Claude manager modes receive the one composed constitution block",
    claude.includes("managerConstitutionBlock: opts.managerConstitutionBlock") &&
      claude.includes("appendManagerConstitutionBlock") &&
      claude.includes("materializeClaudeManagerPrompt"),
  );
  check(
    "Codex app-server base instructions use the stable constitution seam",
    codex.includes("managerConstitutionBlock: input.managerConstitutionBlock") &&
      codex.includes("const baseInstructions = await codexManagerInstructions(input);"),
  );
  check(
    "Pi manager receives the exact composed block through an owner-only file path",
    piBackend.includes("managerConstitutionBlock: managerConstitutionBlock || undefined") &&
      piRuntime.includes("env.CODARA_PI_MANAGER_CONSTITUTION_PATH") &&
      piExtension.includes("loadManagerConstitutionBlock()"),
  );
  check(
    "shared manager precedence keeps captured project guidance after global guidance",
    managerConstitution.indexOf("blocks.push(renderGlobalUserConstitution") <
      managerConstitution.indexOf("const project = renderProjectConstitution") &&
      managerConstitution.includes("project constitution is more specific and wins any conflict"),
  );

  console.log(`\nAll ${passed} project-constitution checks passed.`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
  });
