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

  await memory.setMemoryEnabled("global", "", false, coder.id);
  await memory.setMemoryEnabled("workspace", "ws-a", false, coder.id);
  await memory.deleteProfileMemoryState(coder.id);
  const memoryState = JSON.parse(
    fs.readFileSync(path.join(HOME, "memory", "memory-state.json"), "utf8"),
  );
  check(
    "deleting profile memory state removes its global toggle",
    memoryState.profileGlobals?.[coder.id] === undefined,
  );
  check(
    "deleting profile memory state removes its workspace toggles",
    !Object.keys(memoryState.workspaces ?? {}).some((key) =>
      key.startsWith(`profile:${coder.id}:workspace:`),
    ),
  );

  let builtInDeleteError = "";
  try {
    await profiles.deleteCoraProfile("default");
  } catch (error) {
    builtInDeleteError = error.message;
  }
  check(
    "the built-in profile cannot be deleted",
    /built-in Cora profile cannot be deleted/i.test(builtInDeleteError),
    builtInDeleteError,
  );

  const deleted = await profiles.deleteCoraProfile(coder.id);
  check("named profile is removed from the registry", !profiles.listCoraProfiles().some((profile) => profile.id === coder.id));
  check("deleting the current default falls back to built-in Cora", profiles.resolveCoraProfile().id === "default");
  check("the live profile directory is removed", !fs.existsSync(path.dirname(coder.identityPath)));
  check(
    "profile data is staged for recoverable OS-trash deletion",
    Boolean(deleted.stagedDataPath && fs.existsSync(deleted.stagedDataPath)),
    deleted.stagedDataPath,
  );
  if (deleted.stagedDataPath) fs.rmSync(deleted.stagedDataPath, { recursive: true, force: true });

  const editable = await profiles.createCoraProfile({ name: "Editor", instructions: "Initial instructions" });
  let reservedNameRejected = false;
  try { await profiles.createCoraProfile({ name: "Cora" }); } catch { reservedNameRejected = true; }
  check("custom profiles cannot shadow the built-in Cora identity", reservedNameRejected && profiles.resolveCoraProfile("Cora").id === "default");
  const document = await profiles.readCoraProfileDocument(editable.id);
  check("profile editor reads the complete Markdown without a local path", document.content.includes("Initial instructions") && document.maxChars === 4000 && document.identityPath === undefined);
  const concurrent = await Promise.allSettled([
    profiles.saveCoraProfileDocument(editable.id, document.revision, "# Editor\n\nUpdated instructions"),
    profiles.saveCoraProfileDocument(editable.id, document.revision, "stale instructions"),
  ]);
  check("simultaneous instruction edits preserve the first write", concurrent[0].status === "fulfilled" && concurrent[1].status === "rejected");
  const updated = await profiles.readCoraProfileDocument(editable.id);
  check("saved instructions reach the actual Cora prompt", profiles.formatCoraProfileForTurn(editable.id).includes("Updated instructions"));
  let capRejected = false;
  try { await profiles.saveCoraProfileDocument(editable.id, updated.revision, "x".repeat(4001)); } catch { capRejected = true; }
  check("over-limit instructions leave the saved file intact", capRejected && (await profiles.readCoraProfileDocument(editable.id)).revision === updated.revision);
  fs.writeFileSync(editable.identityPath, "An edit from the desktop", "utf8");
  let staleRejected = false;
  try { await profiles.saveCoraProfileDocument(editable.id, updated.revision, "stale"); } catch { staleRejected = true; }
  check("phone drafts cannot overwrite an intervening desktop edit", staleRejected && fs.readFileSync(editable.identityPath, "utf8") === "An edit from the desktop");
  let deleteRejected = false;
  try { await profiles.deleteCoraProfile(editable.id, new Date(0).toISOString()); } catch { deleteRejected = true; }
  check("stale profile deletion preserves the replacement identity", deleteRejected && profiles.resolveCoraProfile(editable.id).id === editable.id);

  const lifecycle = await load("src/main/orchestration/delete-cora-profile.ts");
  await profiles.setDefaultCoraProfile(editable.id);
  await memory.setMemoryEnabled("global", "", false, editable.id);
  const order = [];
  let stagedPath;
  const removed = await lifecycle.deleteCoraProfileWithChats(editable.id, {
    expectedCreatedAt: editable.createdAt,
    reassignRuns: async (from, to) => {
      order.push(profiles.listCoraProfiles().some((profile) => profile.id === from) ? "before" : "after");
      check("deletion reassigns chats to built-in Cora", from === editable.id && to === "default");
      return order.length === 1 ? 2 : 1;
    },
    trashItem: async (location) => {
      stagedPath = location;
      order.push("trash");
      check("only the staged directory is offered to Trash", location.includes(".deleted-") && !fs.existsSync(path.dirname(editable.identityPath)) && fs.existsSync(location));
    },
  });
  check("both reassignment passes precede trashing", order.join(",") === "before,after,trash" && removed.reassignedRunCount === 3);
  check("shared deletion returns the authoritative profile list", removed.profiles.every((profile) => profile.id !== editable.id) && removed.profiles.find((profile) => profile.id === "default").isDefault);
  check("shared deletion clears the deleted profile's toggle state", JSON.parse(fs.readFileSync(path.join(HOME, "memory", "memory-state.json"), "utf8")).profileGlobals[editable.id] === undefined);
  check("deleted profile data stays recoverable until the OS trashes it", stagedPath && fs.readFileSync(path.join(stagedPath, "PROFILE.md"), "utf8") === "An edit from the desktop");
  let resurrectionRejected = false;
  try { await profiles.saveCoraProfileDocument(editable.id, updated.revision, "resurrect"); } catch { resurrectionRejected = true; }
  check("late edits cannot resurrect a deleted profile directory", resurrectionRejected && !fs.existsSync(path.dirname(editable.identityPath)));

  fs.rmSync(HOME, { recursive: true, force: true });

  if (failures) process.exit(1);
  console.log("\nCora profile isolation: all assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
