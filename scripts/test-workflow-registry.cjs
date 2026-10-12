// Guards saved workflows (src/main/orchestration/workflow-registry.ts):
// precedence project > user > built-in, invalid files listed with their
// error, saves to the user and project scopes, and the shipped built-in
// workflows all parsing.
//
//   node scripts/test-workflow-registry.cjs

const fs = require("node:fs");
const path = require("node:path");
const { ROOT, bundleModule, check, finish, tempDir } = require("./workflow-test-harness.cjs");

const wf = (name, description) => `export const meta = { name: "${name}", description: "${description}" };\nreturn 1;\n`;

async function main() {
  const reg = await bundleModule("workflow-registry.ts");
  const base = tempDir();
  const dirs = { builtinDir: path.join(base, "builtin"), userDir: path.join(base, "user") };
  const project = path.join(base, "project");
  fs.mkdirSync(dirs.builtinDir, { recursive: true });
  fs.mkdirSync(dirs.userDir, { recursive: true });
  fs.mkdirSync(path.join(project, ".codara", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(dirs.builtinDir, "review.js"), wf("review", "builtin review"));
  fs.writeFileSync(path.join(dirs.builtinDir, "understand.js"), wf("understand", "builtin understand"));
  fs.writeFileSync(path.join(dirs.userDir, "review.js"), wf("review", "user review"));
  fs.writeFileSync(path.join(project, ".codara", "workflows", "review.js"), wf("review", "project review"));
  fs.writeFileSync(path.join(dirs.userDir, "broken.js"), "const x = 1;\n");

  const list = await reg.listSavedWorkflows(dirs, project);
  const reviews = list.filter((entry) => entry.name === "review");
  check("all three reviews are listed", reviews.length === 3);
  check("the project review wins", reviews.find((e) => !e.shadowed)?.source === "project", reviews);
  check("the others are marked shadowed", reviews.filter((e) => e.shadowed).length === 2);
  const broken = list.find((entry) => entry.name === "broken");
  check("an invalid file is listed with its error", broken && /export const meta/.test(broken.error), broken);
  check("listing carries no source text", list.every((entry) => entry.source_text === undefined));

  const got = await reg.getSavedWorkflow(dirs, "review", project);
  check("get by name returns the winner", got?.meta.description === "project review");
  const qualified = await reg.getSavedWorkflow(dirs, "builtin:review", project);
  check("get by source:name returns that source", qualified?.meta.description === "builtin review");
  const withoutProject = await reg.getSavedWorkflow(dirs, "review");
  check("without a workspace the user review wins", withoutProject?.source === "user");

  const nested = await reg.nestedWorkflowScripts(dirs, project);
  check("nested scripts include valid winners only", Object.keys(nested).sort().join(",") === "review,understand", Object.keys(nested));
  check("nested bodies have the meta blanked", !/export const meta/.test(nested.review.body));

  const saved = await reg.saveWorkflowFile(dirs, { sourceText: wf("fresh", "new one"), scope: "user" });
  check("a user save lands in the user dir", saved.path === path.join(dirs.userDir, "fresh.js") && fs.existsSync(saved.path));
  let dupError = "";
  try {
    await reg.saveWorkflowFile(dirs, { sourceText: wf("fresh", "again"), scope: "user" });
  } catch (err) {
    dupError = err.message;
  }
  check("saving over an existing name needs overwrite", /already exists/.test(dupError), dupError);
  const projectSave = await reg.saveWorkflowFile(dirs, { sourceText: wf("proj", "p"), scope: "project", cwd: project });
  check("a project save lands in .codara/workflows", projectSave.path === path.join(project, ".codara", "workflows", "proj.js"));
  let invalid = "";
  try {
    await reg.saveWorkflowFile(dirs, { sourceText: "return 1;", scope: "user" });
  } catch (err) {
    invalid = err.message;
  }
  check("an invalid script is not saved", /export const meta/.test(invalid), invalid);
  check("delete removes a user workflow", (await reg.deleteWorkflowFile(dirs, "user:fresh")) === true && !fs.existsSync(saved.path));
  let builtinDelete = "";
  try {
    await reg.deleteWorkflowFile(dirs, "builtin:understand");
  } catch (err) {
    builtinDelete = err.message;
  }
  check("built-in workflows cannot be deleted", /cannot be deleted/.test(builtinDelete));

  // The shipped built-ins parse.
  const shipped = { builtinDir: path.join(ROOT, "resources", "orchestration", "workflows"), userDir: path.join(base, "none") };
  const shippedList = await reg.listSavedWorkflows(shipped);
  check("the app ships built-in workflows", shippedList.length >= 3, shippedList.map((e) => e.name));
  check("every shipped workflow parses", shippedList.every((e) => !e.error), shippedList.filter((e) => e.error));
}

main()
  .catch((err) => {
    check("suite crashed", false, err && err.stack ? err.stack : String(err));
  })
  .finally(finish);
