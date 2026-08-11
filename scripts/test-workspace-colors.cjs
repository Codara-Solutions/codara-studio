// Focused regression harness for automatic workspace color assignment.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(ROOT, "src", "shared", "workspace-colors.ts");
const outfile = path.join(os.tmpdir(), "codara-workspace-colors-test", "workspace-colors.cjs");
fs.mkdirSync(path.dirname(outfile), { recursive: true });
esbuild.buildSync({
  entryPoints: [ENTRY],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile,
  logLevel: "silent",
});
delete require.cache[outfile];

const {
  WORKSPACE_COLORS,
  applyWorkspaceGroupShades,
  ensureWorkspaceGroupColors,
  pickWorkspaceColor,
  pickWorkspaceGroupShade,
  rebalanceWorkspaceColors,
  workspaceColorDistance,
  workspaceColorLightness,
  workspaceGroupShades,
} = require(outfile);

const firstPath = "/Users/example/Projects/client-alpha";
const first = pickWorkspaceColor([], firstPath);
assert.match(first, /^#[0-9A-F]{6}$/);
assert.equal(pickWorkspaceColor([], firstPath), first, "the same folder must choose deterministically");
assert.notEqual(
  pickWorkspaceColor([], "/Users/example/Projects/client-beta"),
  first,
  "the folder path should influence otherwise equivalent choices",
);

const reversedA = pickWorkspaceColor(["#FF0000", "#00FF00", "#0000FF"], "/repo/order");
const reversedB = pickWorkspaceColor(["#0000FF", "#00FF00", "#FF0000"], "/repo/order");
assert.equal(reversedA, reversedB, "existing workspace order must not affect the result");

const assigned = [];
for (let index = 0; index < 64; index += 1) {
  assigned.push(
    pickWorkspaceColor(assigned, `/Users/example/Projects/workspace-${index}`),
  );
}
assert.equal(new Set(assigned).size, assigned.length, "repeated imports must not reuse colors");

// Early choices should occupy clearly separated parts of the visible gamut,
// not collapse into several nearby teal/green shades.
for (let left = 0; left < 8; left += 1) {
  for (let right = left + 1; right < 8; right += 1) {
    assert.ok(
      workspaceColorDistance(assigned[left], assigned[right]) > 0.12,
      `${assigned[left]} and ${assigned[right]} are not visually separated`,
    );
  }
}

const afterOldPalette = pickWorkspaceColor(WORKSPACE_COLORS, "/Users/example/Projects/ninth");
assert.ok(
  !WORKSPACE_COLORS.includes(afterOldPalette),
  "exhausting the manual palette must choose a new color instead of wrapping to teal",
);

const groups = ensureWorkspaceGroupColors([
  { id: "group-client", name: "Client", collapsed: false },
  { id: "group-internal", name: "Internal", collapsed: false },
  { id: "group-personal", name: "Personal", collapsed: false },
]);
assert.equal(new Set(groups.map((group) => group.color)).size, groups.length,
  "workspace folders must receive distinct family colors");
assert.deepEqual(ensureWorkspaceGroupColors(groups), groups,
  "persisted folder family colors must remain stable");

const shadeOne = pickWorkspaceGroupShade(groups[0].color, [], [], "/client/one");
const shadeTwo = pickWorkspaceGroupShade(groups[0].color, [shadeOne], [shadeOne], "/client/two");
const shadeThree = pickWorkspaceGroupShade(
  groups[0].color,
  [shadeOne, shadeTwo],
  [shadeOne, shadeTwo],
  "/client/three",
);
assert.equal(new Set([shadeOne, shadeTwo, shadeThree]).size, 3,
  "members of one folder must receive different shades");

const orderedShades = workspaceGroupShades("#2AA298", 5);
assert.equal(new Set(orderedShades).size, orderedShades.length,
  "an ordered folder gradient must keep every member distinct");
for (let index = 1; index < orderedShades.length; index += 1) {
  assert.ok(
    workspaceColorLightness(orderedShades[index - 1]) <
      workspaceColorLightness(orderedShades[index]),
    "folder members must get progressively lighter from top to bottom",
  );
}

const movedOrder = applyWorkspaceGroupShades(
  [
    { id: "third", name: "Third", cwd: "/client/third", color: "#000000", workers: [], groupId: "group-client" },
    { id: "first", name: "First", cwd: "/client/first", color: "#FFFFFF", workers: [], groupId: "group-client" },
    { id: "second", name: "Second", cwd: "/client/second", color: "#FF00FF", workers: [], groupId: "group-client" },
  ],
  groups,
  ["group-client"],
);
assert.ok(
  workspaceColorLightness(movedOrder[0].color) < workspaceColorLightness(movedOrder[1].color) &&
    workspaceColorLightness(movedOrder[1].color) < workspaceColorLightness(movedOrder[2].color),
  "reordering members must reassign the dark-to-light gradient by rail position",
);

const rebalanced = rebalanceWorkspaceColors(
  [
    { id: "client-a", name: "A", cwd: "/client/a", color: "#2AA298", workers: [], groupId: "group-client" },
    { id: "client-b", name: "B", cwd: "/client/b", color: "#2AA298", workers: [], groupId: "group-client" },
    { id: "internal-a", name: "C", cwd: "/internal/a", color: "#2AA298", workers: [], groupId: "group-internal" },
    { id: "loose", name: "Loose", cwd: "/loose", color: "#2AA298", workers: [] },
  ],
  groups,
);
assert.equal(
  new Set(rebalanced.workspaces.map((workspace) => workspace.color)).size,
  rebalanced.workspaces.length,
  "a full rebalance must remove exact duplicates across the rail",
);
assert.ok(
  workspaceColorLightness(rebalanced.workspaces[0].color) <
    workspaceColorLightness(rebalanced.workspaces[1].color),
  "a folder's first member must be darker than the sibling below it",
);

console.log(
  `PASS workspace colors: ${assigned.length} sequential imports stayed unique; folder families and shades stayed coherent`,
);
