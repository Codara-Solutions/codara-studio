// Focused regression harness for automatic workspace color assignment.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const ENTRY = path.join(ROOT, "src", "shared", "workspace-colors.ts");
const WORKSPACE_RAIL = path.join(ROOT, "src", "renderer", "src", "components", "WorkspaceRail.tsx");
const WORKSPACE_ACCENT = path.join(ROOT, "src", "renderer", "src", "lib", "workspace-accent.ts");
const RENDERER_STYLES = path.join(ROOT, "src", "renderer", "src", "styles.css");
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
  readableWorkspaceAccent,
  workspaceAccentInk,
  workspaceColorContrast,
  workspaceColorDistance,
  workspaceColorLightness,
  workspaceGroupShades,
} = require(outfile);

const darkBlueAccent = readableWorkspaceAccent("#0000FF", "#292724", "#F4F3F1");
assert.ok(
  workspaceColorContrast(darkBlueAccent, "#292724") >= 4.5,
  `dark custom blue must resolve to readable UI ink (got ${darkBlueAccent})`,
);
assert.notEqual(darkBlueAccent, "#0000FF", "an unreadable accent must be adjusted");
assert.equal(
  readableWorkspaceAccent("#7FB3FF", "#292724", "#F4F3F1"),
  "#7FB3FF",
  "an already-readable dark-theme accent must retain its exact identity",
);
const paleAccent = readableWorkspaceAccent("#FFFF00", "#DDD9CC", "#211F1A");
assert.ok(
  workspaceColorContrast(paleAccent, "#DDD9CC") >= 4.5,
  `pale custom yellow must resolve on a light theme (got ${paleAccent})`,
);
assert.ok(
  workspaceColorContrast(darkBlueAccent, workspaceAccentInk(darkBlueAccent)) >= 4.5,
  "filled accent controls must receive contrasting text",
);

const workspaceRailSource = fs.readFileSync(WORKSPACE_RAIL, "utf8");
const workspaceAccentSource = fs.readFileSync(WORKSPACE_ACCENT, "utf8");
const rendererStylesSource = fs.readFileSync(RENDERER_STYLES, "utf8");
assert.match(
  workspaceAccentSource,
  /setProperty\("--accent", accent\.raw\)/,
  "the app accent must use the exact workspace color",
);
assert.doesNotMatch(
  workspaceAccentSource,
  /setProperty\("--accent", accent\.readable\)/,
  "contrast handling must never replace the selected workspace color",
);
assert.match(
  workspaceAccentSource,
  /setProperty\("--accent-text", accent\.readable\)/,
  "accent foregrounds must retain a contrast-safe companion color",
);
assert.match(rendererStylesSource, /--accent-text:/, "the renderer must define an accent foreground token");
assert.doesNotMatch(
  rendererStylesSource,
  /(?:^|\n)\s*color:\s*var\(--accent\);/,
  "small CSS foregrounds must use the readable accent token, not the raw identity fill",
);
const folderPickerSource = workspaceRailSource.slice(
  workspaceRailSource.indexOf("const committedFolderColor"),
  workspaceRailSource.indexOf("function WorkspaceRow"),
);
assert.match(
  folderPickerSource,
  /addEventListener\("change", commitColor\)/,
  "the folder picker commits from the final native change event",
);
assert.doesNotMatch(
  folderPickerSource,
  /onChange=\{\(event\) => onChangeColor/,
  "folder color dragging must not stream changes into the workspace tree",
);

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
