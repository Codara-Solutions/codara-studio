#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const readSource = (...args) => fs.readFileSync(...args).replace(/\r\n/g, "\n");
const root = path.join(__dirname, "..");
const rel = (...parts) => readSource(path.join(root, ...parts), "utf8");

const componentsDir = path.join(root, "src", "renderer", "src", "components");
const capabilitiesDir = path.join(componentsDir, "capabilities");
const dialog = rel("src", "renderer", "src", "components", "AgentCapabilitiesDialog.tsx");
const part = (name) => readSource(path.join(capabilitiesDir, name), "utf8");
const model = part("model.ts");
const controls = part("controls.tsx");
const mcpSection = part("McpSection.tsx");
const skillsSection = part("SkillsSection.tsx");
const serverForm = part("McpServerForm.tsx");
const profilesSection = part("ProfilesSection.tsx");
const memorySection = part("MemorySection.tsx");
const workersSection = part("WorkerModelsSection.tsx");
const behaviorSection = part("BehaviorSection.tsx");
// Every file the dialog is made of, for assertions about the whole surface.
const source = [
  dialog,
  ...fs
    .readdirSync(capabilitiesDir)
    .filter((name) => /\.(tsx?|ts)$/.test(name))
    .sort()
    .map(part),
].join("\n");

const settings = rel("src", "renderer", "src", "components", "SettingsDialog.tsx");
const composer = rel("src", "renderer", "src", "components", "chat", "ChatComposer.tsx");
const profilePicker = rel("src", "renderer", "src", "components", "chat", "composer", "ProfilePicker.tsx");
const toolsButton = rel("src", "renderer", "src", "components", "chat", "composer", "CapabilitiesButton.tsx");
const sidebar = rel("src", "renderer", "src", "components", "OrchestrationSidebar.tsx");
const app = rel("src", "renderer", "src", "App.tsx");
const commands = rel("src", "renderer", "src", "shortcuts", "commands.ts");
const styles = rel("src", "renderer", "src", "styles.css");
const preload = rel("src", "preload", "index.ts");
const agentSync = rel("src", "main", "agent-sync.ts");
const agentSocket = rel("src", "main", "agent-socket.ts");
const ipc = rel("src", "main", "ipc.ts");
const profiles = rel("src", "main", "orchestration", "cora-profiles.ts");
const runStore = rel("src", "main", "orchestration", "run-store.ts");

let passed = 0;
const check = (name, fn) => {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
};

check("sections carry plain-language names, including Profiles", () => {
  assert.match(model, /\{ id: "mcp", label: "Tools \(MCP servers\)" \}/);
  assert.match(model, /\{ id: "profiles", label: "Profiles" \}/);
  assert.match(model, /\{ id: "workers", label: "Worker models" \}/);
  assert.match(model, /\{ id: "policy", label: "Behavior" \}/);
  assert.match(dialog, /renderedTab === "workers"/);
  assert.match(dialog, /renderedTab === "profiles"/);
  assert.match(workersSection, /aria-label="Cora worker models"/);
  assert.doesNotMatch(settings, /Cora worker models/);
  // App accepts the new section from the event, and the composer's profile
  // menu opens it on the chat's own profile.
  assert.match(app, /requested === "profiles"/);
  assert.match(app, /initialProfileId=\{capabilitiesProfileId\}/);
  assert.match(composer, /tab: "profiles", profileId: frozenProfileId \?\? draftCoraProfileId/);
});

check("one save model: settings apply as they change, never through a draft", () => {
  // No dialog-wide draft and no Save button that a close could silently skip.
  assert.doesNotMatch(dialog, /setDraft\(/);
  assert.doesNotMatch(dialog, /onSave\(draft\)/);
  // Each change is a function of the latest saved settings, applied in order,
  // and dropped from the view again if the save fails.
  assert.match(dialog, /const next = change\(latestSettings\.current\);\s*\n\s*await onSave\(next\);/);
  assert.match(dialog, /pendingChanges\.current = pendingChanges\.current\.filter\(\(entry\) => entry !== change\);/);
  assert.match(dialog, /saveChain\.current = run;/);
  assert.match(dialog, />\s*\n\s*Done\s*\n\s*<\/button>/);
  assert.match(dialog, /Changes apply as you make them\./);
  // The footer never claims memory edits are waiting for Save.
  assert.match(dialog, /Memory changes apply immediately\./);
});

check("unsaved drafts are confirmed before Escape, the scrim, X or the nav drop them", () => {
  assert.match(dialog, /const anyDirty = editorDirty \|\| profileDraftDirty \|\| documentDirty;/);
  assert.match(dialog, /if \(discards\) setConfirmLeave\(action\);/);
  assert.match(dialog, /if \(event\.key !== "Escape"\) return;[\s\S]{0,300}?current\.requestLeave\(/);
  assert.match(dialog, /onMouseDown=\{\(\) => requestLeave\(editor \? \{ kind: "back" \} : \{ kind: "close" \}\)\}/);
  assert.match(dialog, /<CloseButton onClick=\{\(\) => requestLeave\(\{ kind: "close" \}\)\} \/>/);
  assert.match(dialog, /requestLeave\(\{ kind: "tab", tab \}\);/);
  assert.match(dialog, /Discard them\?/);
  // Opening a memory file keeps the dialog open when closing would lose a draft.
  assert.match(dialog, /if \(anyDirty\) \{\s*\n\s*setStatus\(ok\(`Opened \$\{path\} in the editor/);
});

check("the MCP table asks what agents may use separately from which CLI config holds it", () => {
  assert.match(mcpSection, /labels=\{\["Server", "Cora", "Workers", "Claude CLI", "Codex CLI", "Grok Build", ""\]\}/);
  assert.match(skillsSection, /labels=\{\["Skill", "Cora and workers", "Claude CLI", "Codex CLI", ""\]\}/);
  // Header and rows share one grid template or the columns stop aligning.
  assert.match(mcpSection, /export const MCP_GRID = /);
  assert.match(skillsSection, /export const SKILL_GRID = /);
  assert.match(mcpSection, /gridTemplateColumns: MCP_GRID/);
  assert.match(skillsSection, /gridTemplateColumns: SKILL_GRID/);
  assert.match(mcpSection, /template=\{MCP_GRID\}/);
  assert.match(skillsSection, /template=\{SKILL_GRID\}/);
  assert.match(model, /export const CLI_LABEL: Record<CliRuntime, string> = \{\s*\n\s*claude: "Claude CLI",/);
});

check("the built-in server keeps its row, its controls and a placeholder while loading", () => {
  assert.match(mcpSection, /Codara Studio tools/);
  assert.match(mcpSection, /Set up by you/);
  assert.match(mcpSection, /function BuiltinRowPlaceholder\(\)/);
  assert.match(mcpSection, /\{builtinPending \? <BuiltinRowPlaceholder \/> : null\}/);
  // Names wrap onto a second line rather than clipping, and badges ride the
  // wrapping meta row, never the name line.
  assert.match(
    controls,
    /export const rowNameStyle: React\.CSSProperties = \{[\s\S]*?WebkitLineClamp: 2,[\s\S]*?overflowWrap: "anywhere",/,
  );
  assert.doesNotMatch(controls, /export const rowNameStyle: React\.CSSProperties = \{[^}]*whiteSpace: "nowrap"/);
  assert.match(
    mcpSection,
    /<div style=\{rowNameStyle\} title="Codara Studio tools">\s*\n\s*Codara Studio tools\s*\n\s*<\/div>/,
  );
  assert.match(
    mcpSection,
    /<span style=\{rowScopeStyle\}>\{builtin\.name\}<\/span>\s*\n\s*<span className="spark-badge is-accent" style=\{badgeStyle\}>\s*\n\s*built in\s*\n\s*<\/span>\s*\n\s*<span className="spark-badge" style=\{badgeStyle\} title=\{builtin\.tools\.join\(", "\)\}>/,
  );
  // The wider dialog, and the compact wrap the MCP rows switch to before the
  // fixed columns would squeeze the name to nothing.
  assert.match(dialog, /width: "min\(1120px, calc\(100vw - 44px\)\)"/);
  assert.match(styles, /@media \(max-width: 1000px\) \{\s*\n\s*\.agent-capability-row--mcp \{\s*\n\s*display: flex !important;/);
});

check("Grok Build is a real copy target through the same install path", () => {
  assert.match(mcpSection, /<CliCell group=\{group\} runtime="claude" busy=\{busy\} onInstall=\{onInstall\} \/>/);
  assert.match(mcpSection, /<CliCell group=\{group\} runtime="codex" busy=\{busy\} onInstall=\{onInstall\} \/>/);
  assert.match(mcpSection, /<CliCell group=\{group\} runtime="grok" busy=\{busy\} onInstall=\{onInstall\} \/>/);
  assert.doesNotMatch(source, /Third-party MCP copy into Grok Build is not available yet/);
  assert.match(dialog, /const installToRuntime = \(group: NameGroup, target: CliRuntime\) =>/);
  assert.match(model, /export type CliRuntime = "claude" \| "codex" \| "grok";/);
  assert.match(preload, /installAsset: \(id: string, target: "claude" \| "codex" \| "grok"\)/);
  assert.match(agentSync, /target: "claude" \| "codex" \| "grok";\n\}\): Promise<AgentAssetInstallResult>/);
  assert.match(agentSync, /\{ runtime: "grok", scope: "user", path: tomlRuntimeConfigPath\("grok"\) \}/);
});

check("ticks and copy buttons are readable without the column header", () => {
  assert.match(mcpSection, /<VisuallyHidden>\{`\$\{label\}: set up`\}<\/VisuallyHidden>/);
  assert.match(mcpSection, /aria-label=\{`Add \$\{group\.name\} to the \$\{label\}`\}/);
  assert.match(mcpSection, /\{working \? "Adding" : "Add"\}/);
  assert.doesNotMatch(mcpSection, />\s*Copy\s*</);
});

check("the section nav is a real tab list", () => {
  assert.match(dialog, /role="tablist"/);
  assert.match(dialog, /aria-orientation="vertical"/);
  assert.match(dialog, /role="tab"/);
  assert.match(dialog, /tabIndex=\{active \? 0 : -1\}/);
  assert.match(dialog, /role="tabpanel"/);
  assert.match(dialog, /if \(event\.key === "ArrowDown"\)/);
});

check("results and errors are reported honestly", () => {
  assert.match(model, /export type StatusTone = "ok" \| "error"/);
  assert.match(model, /export interface StatusMessage \{\s*\n\s*tone: StatusTone;/);
  assert.match(dialog, /role=\{status\?\.tone === "error" \? "alert" : "status"\}/);
  // Removing from several runtimes reports each runtime's outcome.
  assert.match(dialog, /Could not remove \$\{group\.name\} from \$\{failures\.join\("; "\)\}/);
  // A per-row result does not follow the user to an unrelated section.
  assert.match(
    dialog,
    /if \(editorBusy\) return;[\s\S]{0,300}?setStatus\(null\);\s*\n\s*setEditor\(null\);\s*\n\s*setActiveTab\(tab\);/,
  );
  // A nav click must not dismiss the form while its save is in flight, and a
  // save that fails after the form closed reports in the footer instead.
  assert.match(dialog, /if \(editorRef\.current\) setEditorError\(message\);/);
  // The MCP nav count includes the pinned built-in rows the pane renders.
  assert.match(dialog, /mcpGroups\.length \+ \(builtins\?\.length \?\? 0\)/);
});

check("lists show loading and failure instead of an empty inventory", () => {
  assert.match(dialog, /loading=\{assets === null && assetsError === null\}/);
  assert.match(dialog, /loadError=\{assets === null \? assetsError : null\}/);
  assert.match(controls, /export function ErrorRow\(/);
  assert.match(controls, /Retry/);
  // "No servers found" is only true once the read has landed.
  assert.match(mcpSection, /\) : loading \? \(\s*\n\s*<LoadingRows/);
  assert.match(skillsSection, /\) : loading \? \(\s*\n\s*<LoadingRows/);
});

check("adding a server asks where it is available and can be tested first", () => {
  assert.match(serverForm, /Paste a config snippet/);
  assert.match(dialog, /window\.spark\.agents\.parseMcpSnippet\(text\)/);
  assert.match(serverForm, /label="Cora"/);
  assert.match(serverForm, /label="Pi workers"/);
  assert.match(serverForm, /Test connection/);
  assert.match(dialog, /\.probeMcp\(\{ cwd: workspaceCwd, draft:/);
  // A new server is switched on for Cora and workers as the user ticked.
  assert.match(dialog, /withPiAssignment\(settingsNow, key, \{/);
  // Secrets are masked until revealed.
  assert.match(model, /export function isSecretPair\(/);
  assert.match(serverForm, /type=\{masked \? "password" : "text"\}/);
  // Editing one copy offers to update the others, and a rename moves access.
  assert.match(serverForm, /Also update the other copies/);
  assert.match(dialog, /if \(newKey !== oldKey && !leftBehind\)/);
  assert.match(preload, /parseMcpSnippet: \(text: string\)/);
  assert.match(ipc, /"agents:parseMcpSnippet"/);
});

check("sync previews what it would copy before it writes", () => {
  assert.match(dialog, /\.sync\(\{ cwd: workspaceCwd, dryRun: true \}\)/);
  assert.match(mcpSection, /Sync Claude and Codex/);
  assert.match(agentSync, /dryRun/);
  // Behavior says plainly that its switches are global.
  assert.match(behaviorSection, /These apply to all workspaces\./);
});

check("retired vocabulary does not come back", () => {
  assert.doesNotMatch(source, /ControlCluster/);
  assert.doesNotMatch(source, /External CLI configs/);
  assert.doesNotMatch(source, /RuntimeStrip/);
  assert.doesNotMatch(source, /external configs auto-managed/);
  assert.doesNotMatch(source, /In Claude \+ Codex/);
  assert.doesNotMatch(source, /label="Uninstall"/);
  assert.doesNotMatch(source, /"Policy"/);
  assert.doesNotMatch(source, /MCP and skills/);
  assert.doesNotMatch(composer, /title="MCP and skills"/);
});

check("memory shows whose it is and why a tier is off", () => {
  assert.match(memorySection, /aria-label="Show the memory of this profile"/);
  assert.match(dialog, /window\.spark\.memory\.setEnabled\(scope, workspaceId, enabled, viewedProfile\)/);
  assert.match(dialog, /window\.spark\.memory\.clear\(scope, workspaceId, includeUserLines, viewedProfile\)/);
  assert.match(dialog, /window\.spark\.memory\s*\n\s*\.ensureFile\(scope, workspaceId, viewedProfile\)/);
  // The global tier is the master switch and renders first.
  assert.ok(memorySection.indexOf('scope="global"') < memorySection.indexOf('scope="workspace"'));
  assert.match(memorySection, /memory\?\.workspace\.blockedByGlobal/);
  assert.match(preload, /ensureFile: \(\s*\n\s*scope: CoraMemoryScope,\s*\n\s*workspaceId: string \| null,\s*\n\s*profileId\?: string,/);
  assert.match(ipc, /"memory:ensureFile"/);
  // The profile being viewed reaches every memory channel, so switching the
  // view never toggles or clears another profile's memory.
  assert.match(ipc, /readMemoryStatus\(input\?\.workspaceId \?\? null, input\?\.profileId\)/);
  assert.match(ipc, /setMemoryEnabled\(input\.scope, workspaceId, input\.enabled, resolveCoraProfile\(input\.profileId\)\.id\)/);
  assert.match(ipc, /ensureMemoryFile\(input\.scope, workspaceId, resolveCoraProfile\(input\.profileId\)\.id\)/);
});

check("profiles are created, edited and chosen where chats start", () => {
  // Creating a profile does not make it the default behind the user's back.
  assert.match(dialog, /\.create\(\{\s*\n\s*name,\s*\n\s*description: profileDraft\.description\.trim\(\) \|\| undefined,\s*\n\s*instructions:/);
  assert.doesNotMatch(
    dialog.slice(dialog.indexOf("const createProfile = "), dialog.indexOf("const deleteProfile = ")),
    /\.use\(/,
  );
  assert.match(profilesSection, /Create profile/);
  assert.match(profilesSection, /Edit instructions/);
  assert.match(dialog, /\.saveDocument\(draft\.profileId, draft\.revision, draft\.content\)/);
  assert.match(ipc, /"cora-profiles:readDocument"/);
  assert.match(ipc, /"cora-profiles:saveDocument"/);
  // The picker is always there: a menu with "New profile" for a draft, a
  // read-only chip once the chat has started.
  assert.match(composer, /<ProfilePicker/);
  assert.match(composer, /locked=\{frozenProfileId !== null\}/);
  assert.doesNotMatch(composer, /\{!run_ \? \(\s*\n\s*<ProfilePicker/);
  assert.match(profilePicker, /Profile is fixed for this chat\./);
  // The chip of a started chat opens that chat's profile (its memory view
  // included), not the default one.
  assert.match(profilePicker, /className="composer-pill composer-profile-trigger is-locked"[\s\S]{0,300}?onClick=\{onManage\}/);
  assert.match(profilePicker, /"New profile…"/);
  assert.doesNotMatch(profilePicker, /profiles\.length < 2\) return null/);
  assert.match(composer, /profileId: latestDraft\?\.profileId \?\? draftCoraProfileId/);
  assert.match(sidebar, /coraProfileId: chatConfig\?\.profileId/);
  // A board-minted chat still shows the menu, so its first send must carry
  // the pick onto the reused run (scripts/test-unstarted-run-profile.cjs
  // drives the behavior).
  assert.match(runStore, /if \(run\) run = await adoptCoraProfileForUnstartedRun\(run, input\.coraProfileId\);/);
});

check("results never claim a write that failed", () => {
  // Adding or editing a server also writes who may use it. That settings save
  // can fail on its own, and the message must say so instead of "Cora can
  // use it".
  assert.match(dialog, /const accessSaved =\s*\n\s*current\.cora \|\| current\.workers\s*\n\s*\? await applySettings\(/);
  assert.match(dialog, /const accessSaved = accessChanged \? await applySettings\(reassign, null\) : true;/);
  assert.match(dialog, /setStatus\(failed\.length > 0 \|\| !accessSaved \? failure\(text\) : ok\(text\)\);/);
  // A memory result for a profile the user has since switched away from is
  // dropped, and the switcher is held while an action runs.
  assert.match(dialog, /if \(viewedProfileRef\.current === target\) setMemory\(next\);/);
  assert.match(memorySection, /disabled=\{profiles\.length === 0 \|\| busy !== null\}/);
});

check("named profiles have a confirmed delete path at every layer", () => {
  assert.match(profilesSection, /ariaLabel=\{`Delete \$\{profile\.name\}`\}/);
  assert.match(profilesSection, /<ConfirmRemoveButton[\s\S]{0,350}?onConfirm=\{\(\) => onDelete\(profile\)\}/);
  assert.match(preload, /delete: \(reference: string\): Promise<CoraProfileDeleteResult>/);
  assert.match(ipc, /"cora-profiles:delete"/);
  assert.match(ipc, /deleteCoraProfileWithChats\(reference/);
  assert.match(ipc, /reassignRuns: runStore\.reassignCoraProfileRuns/);
  assert.match(ipc, /trashItem: \(path\) => shell\.trashItem\(path\)/);
  assert.match(profiles, /The built-in Cora profile cannot be deleted\./);
  assert.match(runStore, /export async function reassignCoraProfileRuns/);
  assert.match(composer, /if \(!next\.some\(\(item\) => item\.id === current\)\)/);
});

check("worker model errors point at the place that fixes them", () => {
  const message = "Cora has no enabled worker model. Turn one on in Capability Center > Worker models.";
  assert.ok(agentSocket.includes(message), "agent socket error names the Capability Center section");
  assert.ok(runStore.includes(message), "run store error names the Capability Center section");
  assert.doesNotMatch(agentSocket, /Settings > API & model/);
  // The UI refuses to switch off the last usable model, counting OpenRouter
  // models only when the key is verified.
  assert.match(dialog, /Keep at least one usable worker model on\./);
  assert.match(model, /export async function openRouterKeyVerified\(/);
  assert.match(model, /export function usableWorkerModels\(/);
  assert.match(workersSection, /No worker model is usable/);
});

check("the Capability Center is reachable from the composer, the command list and Settings", () => {
  assert.match(composer, /<CapabilitiesButton onOpen=\{openCapabilities\} \/>/);
  assert.match(toolsButton, /<span className="composer-tools-label">Tools<\/span>/);
  assert.match(toolsButton, /aria-label="Tools, skills and memory"/);
  assert.match(commands, /\| "capabilities\.open"/);
  assert.match(commands, /id: "capabilities\.open",/);
  assert.match(app, /"capabilities\.open": \(\) => window\.dispatchEvent\(new CustomEvent\("spark:open-capabilities"\)\)/);
  assert.match(settings, /<AgentsSettings onClose=\{onClose\} \/>/);
  assert.match(settings, /Open Capability Center/);
  assert.match(settings, /onClose\(\);\s*\n\s*window\.dispatchEvent\(new CustomEvent\("spark:open-capabilities", \{ detail: \{ tab \} \}\)\);/);
});

check("no new em dashes in the redesigned files", () => {
  for (const [name, text] of [
    ["AgentCapabilitiesDialog.tsx", dialog],
    ...fs.readdirSync(capabilitiesDir).map((file) => [file, part(file)]),
    ["CapabilitiesButton.tsx", toolsButton],
    ["ProfilePicker.tsx", profilePicker],
  ]) {
    assert.ok(!/\u2014/.test(text), `${name} contains an em dash`);
  }
});

console.log(`PASS Capability Center UI (${passed} checks)`);
