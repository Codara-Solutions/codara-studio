"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "codara-cora-profiles-"));
let failures = 0;

function check(name, condition, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : `: ${detail}`}`);
  if (!condition) failures += 1;
}

const homeStub = {
  name: "cora-profile-home",
  setup(build) {
    build.onResolve({ filter: /\/codara-home$/ }, () => ({
      path: "codara-home-stub",
      namespace: "stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: `export const codaraHome = () => ${JSON.stringify(HOME)};`,
      loader: "js",
    }));
  },
};

async function load(relative) {
  const result = await esbuild.build({
    entryPoints: [path.join(ROOT, relative)],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    logLevel: "silent",
    plugins: [homeStub],
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", result.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

async function main() {
  const profiles = await load("src/main/orchestration/cora-profiles.ts");
  const memory = await load("src/main/orchestration/cora-memory.ts");

  check("the built-in profile is the initial default", profiles.resolveCoraProfile().id === "default");
  check(
    "the built-in profile preserves legacy memory paths",
    memory.globalMemoryPath() === path.join(HOME, "memory", "MEMORY.md"),
    memory.globalMemoryPath(),
  );

  const coder = await profiles.createCoraProfile({
    name: "Careful Coder",
    description: "Focused implementation agent.",
    instructions: "Prefer small patches and focused tests.",
  });
  check("profile creation returns a stable slug", coder.id === "careful-coder", coder.id);
  check("profile identity is a visible markdown file", fs.existsSync(coder.identityPath), coder.identityPath);
  check(
    "profile identity contains the supplied role",
    fs.readFileSync(coder.identityPath, "utf8").includes("Prefer small patches"),
  );

  const hostile = await profiles.createCoraProfile({ name: "../../Review Agent" });
  check("profile ids cannot traverse directories", hostile.id === "review-agent", hostile.id);
  check(
    "profile paths stay below the profile root",
    hostile.identityPath.startsWith(path.join(HOME, "memory", "profiles") + path.sep),
    hostile.identityPath,
  );
  await Promise.all([
    profiles.createCoraProfile({ name: "Concurrent One" }),
    profiles.createCoraProfile({ name: "Concurrent Two" }),
  ]);
  const concurrentIds = new Set(profiles.listCoraProfiles().map((profile) => profile.id));
  check(
    "concurrent profile creation keeps both entries",
    concurrentIds.has("concurrent-one") && concurrentIds.has("concurrent-two"),
  );

  await profiles.setDefaultCoraProfile("Careful Coder");
  check("profiles resolve by name", profiles.resolveCoraProfile().id === coder.id);
  check(
    "only one profile is default",
    profiles.listCoraProfiles().filter((profile) => profile.isDefault).length === 1,
  );

  await memory.rememberAdd("global", "", ["Coder-global fact."], "run-1", coder.id);
  await memory.rememberAdd("workspace", "ws-a", ["Coder workspace fact."], "run-1", coder.id);
  await memory.rememberAdd("workspace", "ws-a", ["Default workspace fact."], "run-2", "default");

  const coderWorkspace = memory.workspaceMemoryPath("ws-a", coder.id);
  const defaultWorkspace = memory.workspaceMemoryPath("ws-a", "default");
  check("named profile memory lives in its own directory", coderWorkspace !== defaultWorkspace);
  check("named profile workspace fact landed", fs.readFileSync(coderWorkspace, "utf8").includes("Coder workspace fact"));
  check("default memory did not leak into named memory", !fs.readFileSync(coderWorkspace, "utf8").includes("Default workspace fact"));

  const rendered = memory.formatCoraMemoryForWorker("ws-a", coder.id) ?? "";
  check("worker context includes profile identity", rendered.includes("CORA PROFILE: Careful Coder"), rendered);
  check("worker context includes isolated global memory", rendered.includes("Coder-global fact"), rendered);
  check("worker context includes isolated workspace memory", rendered.includes("Coder workspace fact"), rendered);
  check("worker context excludes another profile", !rendered.includes("Default workspace fact"), rendered);

  const status = await memory.getMemoryStatus("ws-a", coder.id);
  check("memory status identifies its profile", status.profile.id === coder.id, JSON.stringify(status.profile));
  check("memory status reports both isolated files", status.global.bytesUsed > 0 && status.workspace.bytesUsed > 0);

  if (failures) process.exit(1);
  console.log("\nCora profile isolation: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
