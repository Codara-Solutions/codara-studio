import { app } from "electron";
import { execFile } from "node:child_process";
import { promises as fsp, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { OPEN_WITH_FLAG, OPEN_WITH_TYPES } from "@shared/open-with";
import { logMain } from "./file-log";
import { allowOpenedFile } from "./fs-sandbox";

const execFileAsync = promisify(execFile);

// ── Files handed to Studio by the OS ───────────────────────────────────────
// Paths arrive from three places: macOS `open-file` events (Finder "Open
// With", the Dock, `open -a`), this process's own argv (Explorer launching a
// packaged build), and a second launch forwarded through the single-instance
// lock. Each can land before the renderer exists, so they queue here and the
// renderer drains the queue on mount and whenever it is told more arrived.

const pending: string[] = [];
let onQueued: (() => void) | null = null;

export function setOpenPathsListener(listener: () => void): void {
  onQueued = listener;
}

export function queueOpenPaths(paths: readonly string[]): void {
  const files = [...new Set(paths)].filter(isExistingFile);
  if (files.length === 0) return;
  for (const file of files) {
    allowOpenedFile(file);
    if (!pending.includes(file)) pending.push(file);
  }
  logMain("open-with", `queued ${files.length} file(s)`);
  onQueued?.();
}

export function takePendingOpenPaths(): string[] {
  return pending.splice(0, pending.length);
}

// Chromium appends its own switches to a forwarded command line, and dev runs
// carry the app directory, so anything that is a flag or not an existing
// regular file is dropped rather than parsed positionally.
export function openPathsFromArgv(argv: readonly string[], cwd: string): string[] {
  return argv
    .slice(1)
    .filter((arg) => typeof arg === "string" && arg.length > 0 && !arg.startsWith("-"))
    .map((arg) => path.resolve(cwd, arg))
    .filter(isExistingFile);
}

// What a second launch hands the first through requestSingleInstanceLock.
// Resolved in the launching process because only it knows its own cwd.
export interface OpenWithLockData {
  openPaths: string[];
}

export function openPathsFromLockData(data: unknown): string[] | null {
  const openPaths = (data as Partial<OpenWithLockData> | null)?.openPaths;
  if (!Array.isArray(openPaths)) return null;
  return openPaths.filter((p): p is string => typeof p === "string" && path.isAbsolute(p));
}

function isExistingFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

// ── Finder and Explorer entries ────────────────────────────────────────────
// Installed by the running Studio for itself. The command relaunches this same
// binary with the files; the single-instance lock forwards them to whichever
// Studio is running and the new process exits. Dev and packaged builds share
// userData and therefore the lock, so either one receives them.
//
// A dev run installs nothing unless CODARA_DEV_OPEN_WITH=1: the entries point
// at one checkout's Electron binary, which no contributor should get on their
// machine just by running `npm run dev`.

const MENU_LABEL = "Open in Codara Studio";
// build.appId in package.json.
const MAC_BUNDLE_ID = "com.codara.app";
const WIN_VERB = "CodaraStudio.Open";
const WIN_PROG_ID = "CodaraStudio.Preview";

// The command that relaunches this exact build: a dev Electron binary needs
// the app directory as its first argument, a packaged one does not.
function relaunchArgs(): string[] {
  return app.isPackaged ? [] : [app.getAppPath()];
}

export async function installOpenWithIntegration(): Promise<void> {
  if (!app.isPackaged && process.env.CODARA_DEV_OPEN_WITH !== "1") return;
  try {
    if (process.platform === "darwin") {
      await installFinderQuickAction();
      // A packaged build declares its document types itself; the stock
      // Electron.app a dev run uses declares none, so Finder's Open With would
      // never list it without this stand-in.
      if (!app.isPackaged) await installDevOpenWithApp();
    } else if (process.platform === "win32") {
      await installExplorerVerbs();
    }
  } catch (err) {
    logMain("open-with", `install failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── macOS: a Finder Quick Action ───────────────────────────────────────────

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function quickActionScript(): string {
  // A packaged build goes through LaunchServices so a closed Studio is started
  // and receives the files as `open-file` events.
  if (app.isPackaged) return `open -b ${MAC_BUNDLE_ID} "$@"`;
  return `${devForwardCommand()} "$@" >/dev/null 2>&1 &`;
}

function devForwardCommand(): string {
  return [process.execPath, ...relaunchArgs(), OPEN_WITH_FLAG].map(shellQuote).join(" ");
}

export function quickActionInfoPlist(): string {
  const utis = [...new Set(OPEN_WITH_TYPES.map((t) => t.uti))];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>NSServices</key>
	<array>
		<dict>
			<key>NSIconName</key>
			<string>NSActionTemplate</string>
			<key>NSMenuItem</key>
			<dict>
				<key>default</key>
				<string>${MENU_LABEL}</string>
			</dict>
			<key>NSMessage</key>
			<string>runWorkflowAsService</string>
			<key>NSRequiredContext</key>
			<dict>
				<key>NSApplicationIdentifier</key>
				<string>com.apple.finder</string>
			</dict>
			<key>NSSendFileTypes</key>
			<array>
${utis.map((uti) => `				<string>${uti}</string>`).join("\n")}
			</array>
		</dict>
	</array>
</dict>
</plist>
`;
}

export function quickActionDocument(script: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>AMApplicationBuild</key>
	<string>534</string>
	<key>AMApplicationVersion</key>
	<string>2.10</string>
	<key>AMDocumentVersion</key>
	<string>2</string>
	<key>actions</key>
	<array>
		<dict>
			<key>action</key>
			<dict>
				<key>AMAccepts</key>
				<dict>
					<key>Container</key>
					<string>List</string>
					<key>Optional</key>
					<true/>
					<key>Types</key>
					<array>
						<string>com.apple.cocoa.string</string>
					</array>
				</dict>
				<key>AMActionVersion</key>
				<string>2.0.3</string>
				<key>AMApplication</key>
				<array>
					<string>Automator</string>
				</array>
				<key>AMParameterProperties</key>
				<dict>
					<key>COMMAND_STRING</key>
					<dict/>
					<key>CheckedForUserDefaultShell</key>
					<dict/>
					<key>inputMethod</key>
					<dict/>
					<key>shell</key>
					<dict/>
					<key>source</key>
					<dict/>
				</dict>
				<key>AMProvides</key>
				<dict>
					<key>Container</key>
					<string>List</string>
					<key>Types</key>
					<array>
						<string>com.apple.cocoa.string</string>
					</array>
				</dict>
				<key>ActionBundlePath</key>
				<string>/System/Library/Automator/Run Shell Script.action</string>
				<key>ActionName</key>
				<string>Run Shell Script</string>
				<key>ActionParameters</key>
				<dict>
					<key>COMMAND_STRING</key>
					<string>${xmlEscape(script)}</string>
					<key>CheckedForUserDefaultShell</key>
					<true/>
					<key>inputMethod</key>
					<integer>1</integer>
					<key>shell</key>
					<string>/bin/sh</string>
					<key>source</key>
					<string></string>
				</dict>
				<key>BundleIdentifier</key>
				<string>com.apple.RunShellScript</string>
				<key>CFBundleVersion</key>
				<string>2.0.3</string>
				<key>CanShowSelectedItemsWhenRun</key>
				<false/>
				<key>CanShowWhenRun</key>
				<true/>
				<key>Category</key>
				<array>
					<string>AMCategoryUtilities</string>
				</array>
				<key>Class Name</key>
				<string>RunShellScriptAction</string>
				<key>InputUUID</key>
				<string>3C1E2A8B-5D47-4F0A-9B61-2E7C4D9F1A01</string>
				<key>Keywords</key>
				<array>
					<string>Shell</string>
					<string>Script</string>
					<string>Command</string>
					<string>Run</string>
					<string>Unix</string>
				</array>
				<key>OutputUUID</key>
				<string>3C1E2A8B-5D47-4F0A-9B61-2E7C4D9F1A02</string>
				<key>UUID</key>
				<string>3C1E2A8B-5D47-4F0A-9B61-2E7C4D9F1A03</string>
				<key>UnlocalizedApplications</key>
				<array>
					<string>Automator</string>
				</array>
				<key>arguments</key>
				<dict>
					<key>0</key>
					<dict>
						<key>default value</key>
						<integer>0</integer>
						<key>name</key>
						<string>inputMethod</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<string>0</string>
						<key>uuid</key>
						<string>0</string>
					</dict>
					<key>1</key>
					<dict>
						<key>default value</key>
						<false/>
						<key>name</key>
						<string>CheckedForUserDefaultShell</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<string>0</string>
						<key>uuid</key>
						<string>1</string>
					</dict>
					<key>2</key>
					<dict>
						<key>default value</key>
						<string></string>
						<key>name</key>
						<string>source</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<string>0</string>
						<key>uuid</key>
						<string>2</string>
					</dict>
					<key>3</key>
					<dict>
						<key>default value</key>
						<string></string>
						<key>name</key>
						<string>COMMAND_STRING</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<string>0</string>
						<key>uuid</key>
						<string>3</string>
					</dict>
					<key>4</key>
					<dict>
						<key>default value</key>
						<string>/bin/sh</string>
						<key>name</key>
						<string>shell</string>
						<key>required</key>
						<string>0</string>
						<key>type</key>
						<string>0</string>
						<key>uuid</key>
						<string>4</string>
					</dict>
				</dict>
				<key>conversionLabel</key>
				<integer>0</integer>
				<key>isViewVisible</key>
				<integer>1</integer>
				<key>location</key>
				<string>309.000000:305.000000</string>
				<key>nibPath</key>
				<string>/System/Library/Automator/Run Shell Script.action/Contents/Resources/Base.lproj/main.nib</string>
			</dict>
			<key>isViewVisible</key>
			<integer>1</integer>
		</dict>
	</array>
	<key>connectors</key>
	<dict/>
	<key>workflowMetaData</key>
	<dict>
		<key>applicationBundleID</key>
		<string>com.apple.finder</string>
		<key>applicationBundleIDsByPath</key>
		<dict>
			<key>/System/Library/CoreServices/Finder.app</key>
			<string>com.apple.finder</string>
		</dict>
		<key>applicationPath</key>
		<string>/System/Library/CoreServices/Finder.app</string>
		<key>applicationPaths</key>
		<array>
			<string>/System/Library/CoreServices/Finder.app</string>
		</array>
		<key>inputTypeIdentifier</key>
		<string>com.apple.Automator.fileSystemObject</string>
		<key>outputTypeIdentifier</key>
		<string>com.apple.Automator.nothing</string>
		<key>presentationMode</key>
		<integer>15</integer>
		<key>processesInput</key>
		<false/>
		<key>serviceApplicationBundleID</key>
		<string>com.apple.finder</string>
		<key>serviceApplicationPath</key>
		<string>/System/Library/CoreServices/Finder.app</string>
		<key>serviceInputTypeIdentifier</key>
		<string>com.apple.Automator.fileSystemObject</string>
		<key>serviceOutputTypeIdentifier</key>
		<string>com.apple.Automator.nothing</string>
		<key>serviceProcessesInput</key>
		<false/>
		<key>systemImageName</key>
		<string>NSActionTemplate</string>
		<key>useAutomaticInputType</key>
		<false/>
		<key>workflowTypeIdentifier</key>
		<string>com.apple.Automator.servicesMenu</string>
	</dict>
</dict>
</plist>
`;
}

async function writeIfChanged(file: string, content: string): Promise<boolean> {
  const current = await fsp.readFile(file, "utf8").catch(() => null);
  if (current === content) return false;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content, "utf8");
  return true;
}

async function installFinderQuickAction(): Promise<void> {
  const contents = path.join(os.homedir(), "Library", "Services", `${MENU_LABEL}.workflow`, "Contents");
  const changedInfo = await writeIfChanged(path.join(contents, "Info.plist"), quickActionInfoPlist());
  const changedDoc = await writeIfChanged(path.join(contents, "document.wflow"), quickActionDocument(quickActionScript()));
  if (!changedInfo && !changedDoc) return;
  // Finder reads the Services list from the pasteboard server's cache; without
  // a refresh a new Quick Action only shows up after the next login.
  await execFileAsync("/System/Library/CoreServices/pbs", ["-update"]).catch(() => undefined);
  logMain("open-with", "installed Finder Quick Action");
}

// ── macOS dev: an Open With stand-in app ───────────────────────────────────
// Finder only offers apps whose bundle declares the file type. A tiny
// AppleScript applet does, and its `open` handler runs the same forwarding
// command as the Quick Action. It lives in userData (out of /Applications and
// Launchpad), stays out of the Dock (LSUIElement), and is rebuilt only when
// the command or the type list changes.

const DEV_APP_NAME = "Codara Studio (dev)";
const DEV_APP_BUNDLE_ID = "com.codara.app.dev-open-with";
const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function devOpenWithAppleScript(command: string): string {
  return [
    "on open theFiles",
    '  set args to ""',
    "  repeat with f in theFiles",
    '    set args to args & " " & quoted form of POSIX path of f',
    "  end repeat",
    `  do shell script ${appleScriptString(command)} & args & " >/dev/null 2>&1 &"`,
    "end open",
    "",
    "on run",
    `  do shell script ${appleScriptString(command)} & " >/dev/null 2>&1 &"`,
    "end run",
    "",
  ].join("\n");
}

export function devOpenWithDocumentTypes(): object[] {
  return [
    {
      CFBundleTypeName: "Codara Studio preview",
      CFBundleTypeRole: "Viewer",
      LSHandlerRank: "Alternate",
      CFBundleTypeExtensions: OPEN_WITH_TYPES.map((t) => t.ext),
    },
  ];
}

async function installDevOpenWithApp(): Promise<void> {
  const command = devForwardCommand();
  const stamp = JSON.stringify({ command, exts: OPEN_WITH_TYPES.map((t) => t.ext) });
  const root = path.join(app.getPath("userData"), "open-with");
  const target = path.join(root, `${DEV_APP_NAME}.app`);
  const stampFile = path.join(target, "Contents", "Resources", "codara-open-with.json");
  if ((await fsp.readFile(stampFile, "utf8").catch(() => null)) === stamp) return;

  const staging = path.join(root, `staging-${process.pid}`);
  const stagedApp = path.join(staging, `${DEV_APP_NAME}.app`);
  await fsp.rm(staging, { recursive: true, force: true });
  await fsp.mkdir(staging, { recursive: true });
  try {
    const script = path.join(staging, "open-with.applescript");
    await fsp.writeFile(script, devOpenWithAppleScript(command), "utf8");
    await execFileAsync("/usr/bin/osacompile", ["-o", stagedApp, script]);
    const plist = path.join(stagedApp, "Contents", "Info.plist");
    const set = (key: string, type: string, value: string) =>
      execFileAsync("/usr/bin/plutil", ["-replace", key, type, value, plist]);
    await set("CFBundleIdentifier", "-string", DEV_APP_BUNDLE_ID);
    await set("CFBundleName", "-string", DEV_APP_NAME);
    await set("CFBundleDisplayName", "-string", DEV_APP_NAME);
    await set("LSUIElement", "-bool", "true");
    await set("CFBundleDocumentTypes", "-json", JSON.stringify(devOpenWithDocumentTypes()));
    const icon = path.join(app.getAppPath(), "build", "icon.png");
    const icns = path.join(stagedApp, "Contents", "Resources", "applet.icns");
    await execFileAsync("/usr/bin/sips", ["-s", "format", "icns", icon, "--out", icns]).catch(() => undefined);
    await fsp.writeFile(path.join(stagedApp, "Contents", "Resources", "codara-open-with.json"), stamp, "utf8");
    // Editing Info.plist and Resources broke osacompile's ad-hoc signature;
    // an unsigned or mis-signed applet is refused at launch.
    await execFileAsync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", stagedApp]);
    await fsp.rm(target, { recursive: true, force: true });
    await fsp.rename(stagedApp, target);
  } finally {
    await fsp.rm(staging, { recursive: true, force: true });
  }
  await execFileAsync(LSREGISTER, ["-f", target]);
  logMain("open-with", "registered dev Open With app");
}

// ── Windows: Explorer verbs and Open With ──────────────────────────────────
// Everything lives under HKCU\Software\Classes, so no elevation is needed and
// no file type's default app changes: the verb is added beside the existing
// ones (SystemFileAssociations) and Studio joins each type's Open With list
// (OpenWithProgids). build/installer.nsh removes the same keys on uninstall.

function regString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function explorerCommand(): string {
  const quoted = [process.execPath, ...relaunchArgs()].map((part) => `"${part}"`);
  return [...quoted, OPEN_WITH_FLAG, `"%1"`].join(" ");
}

export function explorerRegFile(command: string): string {
  const classes = "HKEY_CURRENT_USER\\Software\\Classes";
  const icon = `${process.execPath},0`;
  const lines = ["Windows Registry Editor Version 5.00", ""];
  lines.push(
    `[${classes}\\${WIN_PROG_ID}]`,
    `@=${regString("Codara Studio document")}`,
    "",
    `[${classes}\\${WIN_PROG_ID}\\DefaultIcon]`,
    `@=${regString(icon)}`,
    "",
    `[${classes}\\${WIN_PROG_ID}\\Application]`,
    `"ApplicationName"=${regString("Codara Studio")}`,
    "",
    `[${classes}\\${WIN_PROG_ID}\\shell\\open]`,
    `"FriendlyAppName"=${regString("Codara Studio")}`,
    "",
    `[${classes}\\${WIN_PROG_ID}\\shell\\open\\command]`,
    `@=${regString(command)}`,
    "",
  );
  for (const { ext } of OPEN_WITH_TYPES) {
    const verb = `${classes}\\SystemFileAssociations\\.${ext}\\shell\\${WIN_VERB}`;
    lines.push(
      `[${verb}]`,
      `@=${regString(MENU_LABEL)}`,
      `"Icon"=${regString(icon)}`,
      "",
      `[${verb}\\command]`,
      `@=${regString(command)}`,
      "",
      `[${classes}\\.${ext}\\OpenWithProgids]`,
      `${regString(WIN_PROG_ID)}=""`,
      "",
    );
  }
  return lines.join("\r\n");
}

async function installExplorerVerbs(): Promise<void> {
  const command = explorerCommand();
  // One read decides whether anything needs writing, so a normal boot spawns a
  // single reg.exe. A moved install or a dev checkout changes the command.
  const current = await execFileAsync(
    "reg.exe",
    ["query", `HKCU\\Software\\Classes\\${WIN_PROG_ID}\\shell\\open\\command`, "/ve"],
    { windowsHide: true },
  ).then((r) => r.stdout, () => "");
  if (current.includes(command)) return;
  const file = path.join(app.getPath("temp"), `codara-open-with-${process.pid}.reg`);
  // reg.exe import reads UTF-16LE with a byte order mark; that is the only
  // encoding that keeps non-ASCII install paths intact.
  await fsp.writeFile(file, Buffer.from(`﻿${explorerRegFile(command)}`, "utf16le"));
  try {
    await execFileAsync("reg.exe", ["import", file], { windowsHide: true });
  } finally {
    await fsp.rm(file, { force: true });
  }
  logMain("open-with", "registered Explorer verbs");
}
