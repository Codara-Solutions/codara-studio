// The spawn census (src/main/spawn-census.ts): off without its variable,
// and with it every way of starting a child is counted under its program
// and caller while the child still runs normally (promisified execFile
// keeps resolving { stdout, stderr }).
//
//   node scripts/test-spawn-census.cjs

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(ROOT, "src", "main", "spawn-census.ts");

const PROBE = `
const census = require(process.env.CENSUS_MODULE);
const childProcess = require("node:child_process");
const { promisify } = require("node:util");
(async () => {
  const { stdout } = await promisify(childProcess.execFile)("git", ["--version"]);
  if (!/git version/.test(stdout)) throw new Error("promisified execFile lost its result shape");
  childProcess.spawnSync("git", ["-C", ".", "rev-parse", "--is-inside-work-tree"]);
  await new Promise((resolve) => childProcess.spawn("ps", ["-o", "pid="], { stdio: "ignore" }).on("close", resolve));
  childProcess.execSync("true");
  await new Promise((resolve) => childProcess.exec("true", resolve));
  console.log(JSON.stringify({ wrapped: childProcess.spawn.name, label: census.spawnLabel("gh", ["pr", "view", "--json", "x"]) }));
})().catch((error) => { console.error(error); process.exit(1); });
`;

function run(dir, extraEnv) {
  const result = spawnSync(process.execPath, ["-e", PROBE], {
    encoding: "utf8",
    env: { ...process.env, CENSUS_MODULE: path.join(dir, "census.cjs"), ...extraEnv },
  });
  assert.strictEqual(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split("\n").pop());
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codara-census-"));
  await esbuild.build({ entryPoints: [ENTRY], bundle: true, platform: "node", format: "cjs", outfile: path.join(dir, "census.cjs"), logLevel: "silent" });
  let pass = 0;
  const check = (name, condition) => {
    if (!condition) {
      console.error(`FAIL ${name}`);
      process.exit(1);
    }
    pass += 1;
    console.log(`PASS ${name}`);
  };

  const off = run(dir, { CODARA_SPAWN_CENSUS: "" });
  check("without the variable child_process is left untouched", off.wrapped === "spawn");
  check("gh reads are labelled by command and verb", off.label === "gh pr view");

  const file = path.join(dir, "census.json");
  const on = run(dir, { CODARA_SPAWN_CENSUS: file });
  check("with the variable spawn is wrapped", on.wrapped === "wrapped");
  const census = JSON.parse(fs.readFileSync(file, "utf8"));
  check("every start is counted once, exec included", census.total === 5);
  check(
    "programs are labelled",
    census.byProgram.git === 1 &&
      census.byProgram["git rev-parse"] === 1 &&
      census.byProgram["ps -o"] === 1 &&
      census.byProgram.true === 2 &&
      census.byProgram.sh === undefined,
  );
  check(
    "callers carry source positions",
    Object.keys(census.byCaller).every((key) => / @ .+:\d+:\d+/.test(key)),
  );
  check("starts are bucketed by second", Object.values(census.perSecond).reduce((a, b) => a + b, 0) === 5);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\nAll ${pass} spawn-census checks passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
