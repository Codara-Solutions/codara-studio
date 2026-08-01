import { randomUUID } from "node:crypto";
import {
  constants,
  promises as fs,
} from "node:fs";
import { homedir } from "node:os";
import {
  delimiter,
  dirname,
  join,
  normalize,
  resolve,
} from "node:path";
import { app } from "electron";
import type {
  CoraCliInstallStatus,
  CoraCliMutationResult,
} from "../shared/cora-cli";
import { writeFileAtomic } from "./fs-atomic";
import { sparkHome } from "./spark-home";

const APP_ID = "com.codara.app";
const MANIFEST_SCHEMA = 1;
const OWNER_MARKER = "codara-cli-install-id:";

interface CoraCliInstallManifest {
  schemaVersion: 1;
  appId: typeof APP_ID;
  installId: string;
  appVersion: string;
  launcherPath: string;
  payloadPath: string;
  executablePath: string;
}

interface CoraCliPaths {
  root: string;
  versions: string;
  manifest: string;
  binDirectory: string;
  launcher: string;
  payload: string;
  source: string;
  executable: string;
  version: string;
}

function safeVersion(): string {
  const version = app.getVersion().trim() || "0.0.0";
  return version.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
}

function runtimeExecutable(): string {
  if (process.platform === "linux" && app.isPackaged && process.env.APPIMAGE?.trim()) {
    // process.execPath points into AppImage's temporary mount. The outer
    // AppImage remains stable across launches and supports RUN_AS_NODE.
    return resolve(process.env.APPIMAGE);
  }
  return resolve(process.execPath);
}

function cliSource(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "cora-cli", "cora.cjs")
    : join(app.getAppPath(), "bin", "cora.cjs");
}

function paths(): CoraCliPaths {
  const root = join(sparkHome(), "cli");
  const version = safeVersion();
  const binDirectory =
    process.platform === "win32"
      ? join(process.env.LOCALAPPDATA?.trim() || homedir(), "Codara", "bin")
      : join(homedir(), ".local", "bin");
  return {
    root,
    versions: join(root, "versions"),
    manifest: join(root, "install.json"),
    binDirectory,
    launcher: join(binDirectory, process.platform === "win32" ? "cora.cmd" : "cora"),
    payload: join(root, "versions", version, "cora.cjs"),
    source: cliSource(),
    executable: runtimeExecutable(),
    version,
  };
}

function samePath(a: string, b: string): boolean {
  const left = normalize(resolve(a));
  const right = normalize(resolve(b));
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function isInside(parent: string, child: string): boolean {
  const root = `${normalize(resolve(parent))}${process.platform === "win32" ? "\\" : "/"}`;
  const target = normalize(resolve(child));
  return process.platform === "win32"
    ? target.toLowerCase().startsWith(root.toLowerCase())
    : target.startsWith(root);
}

function validInstallId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9-]{36}$/i.test(value);
}

async function readManifest(p: CoraCliPaths): Promise<CoraCliInstallManifest | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(p.manifest, "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as Partial<CoraCliInstallManifest>;
  if (
    value.schemaVersion !== MANIFEST_SCHEMA ||
    value.appId !== APP_ID ||
    !validInstallId(value.installId) ||
    typeof value.appVersion !== "string" ||
    typeof value.launcherPath !== "string" ||
    typeof value.payloadPath !== "string" ||
    typeof value.executablePath !== "string" ||
    !samePath(value.launcherPath, p.launcher) ||
    !isInside(p.versions, value.payloadPath)
  ) {
    return null;
  }
  return value as CoraCliInstallManifest;
}

async function lstatOrNull(path: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function launcherOwnedBy(
  launcher: string,
  installId: string,
): Promise<boolean> {
  const stat = await lstatOrNull(launcher);
  if (!stat?.isFile() || stat.isSymbolicLink()) return false;
  try {
    const first = (await fs.readFile(launcher, "utf8")).slice(0, 4096);
    return first.includes(`${OWNER_MARKER}${installId}`);
  } catch {
    return false;
  }
}

function pathDirectories(): string[] {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function resolvedCoraCommand(): Promise<string | null> {
  const names =
    process.platform === "win32"
      ? ["cora.cmd", "cora.exe", "cora.bat", "cora"]
      : ["cora"];
  for (const directory of pathDirectories()) {
    for (const name of names) {
      const candidate = join(directory, name);
      const stat = await lstatOrNull(candidate);
      if (!stat?.isFile() || stat.isSymbolicLink()) continue;
      if (process.platform !== "win32") {
        try {
          await fs.access(candidate, constants.X_OK);
        } catch {
          continue;
        }
      }
      return resolve(candidate);
    }
  }
  return null;
}

function pathInstruction(binDirectory: string): string {
  if (process.platform === "win32") {
    return `Add ${binDirectory} to your user PATH, then open a new terminal.`;
  }
  const escaped = binDirectory.replace(/'/g, `'\\''`);
  return `export PATH='${escaped}':"$PATH"`;
}

function baseStatus(
  p: CoraCliPaths,
  overrides: Partial<CoraCliInstallStatus>,
): CoraCliInstallStatus {
  return {
    state: "not-installed",
    commandPath: p.launcher,
    binDirectory: p.binDirectory,
    onPath: false,
    currentVersion: p.version,
    message: "The Cora command is not installed.",
    canInstall: true,
    canUninstall: false,
    ...overrides,
  };
}

export async function inspectCoraCliInstall(): Promise<CoraCliInstallStatus> {
  const p = paths();
  if (!["darwin", "linux", "win32"].includes(process.platform)) {
    return baseStatus(p, {
      state: "unsupported",
      message: `Command-line installation is not supported on ${process.platform}.`,
      canInstall: false,
    });
  }

  const manifest = await readManifest(p);
  const launcherStat = await lstatOrNull(p.launcher);
  const resolvedCommand = await resolvedCoraCommand();
  const onPath = resolvedCommand !== null && samePath(resolvedCommand, p.launcher);
  const shadowedBy = resolvedCommand && !onPath ? resolvedCommand : null;

  if (!manifest) {
    if (launcherStat) {
      return baseStatus(p, {
        state: "conflict",
        onPath,
        message: `Codara will not overwrite the existing command at ${p.launcher}.`,
        canInstall: false,
      });
    }
    if (shadowedBy) {
      return baseStatus(p, {
        state: "conflict",
        message: `Another cora command is already first on PATH at ${shadowedBy}.`,
        canInstall: false,
      });
    }
    return baseStatus(p, {});
  }

  const owned = await launcherOwnedBy(p.launcher, manifest.installId);
  const payloadStat = await lstatOrNull(manifest.payloadPath);
  const needsRepair =
    !owned ||
    !payloadStat?.isFile() ||
    payloadStat.isSymbolicLink() ||
    manifest.appVersion !== p.version ||
    !samePath(manifest.payloadPath, p.payload) ||
    !samePath(manifest.executablePath, p.executable);

  if (needsRepair) {
    return baseStatus(p, {
      state: "needs-repair",
      onPath,
      installedVersion: manifest.appVersion,
      message: "The managed Cora command belongs to Codara but needs repair after an update or move.",
      canInstall: owned || !launcherStat,
      canUninstall: owned,
    });
  }
  if (shadowedBy) {
    return baseStatus(p, {
      state: "conflict",
      installedVersion: manifest.appVersion,
      message: `The managed command is installed, but ${shadowedBy} appears first on PATH.`,
      canInstall: false,
      canUninstall: true,
    });
  }
  if (!onPath) {
    return baseStatus(p, {
      state: "needs-path",
      installedVersion: manifest.appVersion,
      message: "Cora is installed, but this terminal's PATH does not include its directory.",
      pathInstruction: pathInstruction(p.binDirectory),
      canInstall: true,
      canUninstall: true,
    });
  }
  return baseStatus(p, {
    state: "installed",
    onPath: true,
    installedVersion: manifest.appVersion,
    message: `cora is available at ${p.launcher}.`,
    canInstall: false,
    canUninstall: true,
  });
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quoteBatch(value: string): string {
  return `"${value.replace(/%/g, "%%").replace(/"/g, '""')}"`;
}

function launcherContents(manifest: CoraCliInstallManifest): string {
  if (process.platform === "win32") {
    return [
      "@echo off",
      `rem ${OWNER_MARKER}${manifest.installId}`,
      'set "ELECTRON_RUN_AS_NODE=1"',
      `${quoteBatch(manifest.executablePath)} ${quoteBatch(manifest.payloadPath)} %*`,
      "",
    ].join("\r\n");
  }
  return [
    "#!/bin/sh",
    `# ${OWNER_MARKER}${manifest.installId}`,
    `ELECTRON_RUN_AS_NODE=1 exec ${quotePosix(manifest.executablePath)} ${quotePosix(manifest.payloadPath)} "$@"`,
    "",
  ].join("\n");
}

async function mutationFailure(error: unknown): Promise<CoraCliMutationResult> {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    status: await inspectCoraCliInstall().catch(() =>
      baseStatus(paths(), {
        state: "needs-repair",
        message: "Codara could not inspect the command after the failed operation.",
      }),
    ),
    error: message,
  };
}

export async function installCoraCli(): Promise<CoraCliMutationResult> {
  const p = paths();
  try {
    const before = await inspectCoraCliInstall();
    if (!before.canInstall) {
      return { ok: false, status: before, error: before.message };
    }
    const sourceStat = await fs.lstat(p.source);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      throw new Error(`Packaged Cora CLI resource is not a regular file: ${p.source}`);
    }

    const previous = await readManifest(p);
    const targetStat = await lstatOrNull(p.launcher);
    if (targetStat && (!previous || !(await launcherOwnedBy(p.launcher, previous.installId)))) {
      throw new Error(`Refusing to overwrite a command Codara does not own: ${p.launcher}`);
    }

    const installId = previous?.installId ?? randomUUID();
    const manifest: CoraCliInstallManifest = {
      schemaVersion: MANIFEST_SCHEMA,
      appId: APP_ID,
      installId,
      appVersion: p.version,
      launcherPath: p.launcher,
      payloadPath: p.payload,
      executablePath: p.executable,
    };

    await fs.mkdir(dirname(p.payload), { recursive: true, mode: 0o700 });
    await fs.mkdir(p.binDirectory, { recursive: true, mode: 0o755 });
    const payload = await fs.readFile(p.source, "utf8");
    await writeFileAtomic(p.payload, payload, { mode: 0o644 });
    await writeFileAtomic(p.launcher, launcherContents(manifest), {
      mode: process.platform === "win32" ? 0o600 : 0o755,
    });
    await fs.mkdir(p.root, { recursive: true, mode: 0o700 });
    await writeFileAtomic(p.manifest, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });

    return { ok: true, status: await inspectCoraCliInstall() };
  } catch (error) {
    return mutationFailure(error);
  }
}

export async function uninstallCoraCli(): Promise<CoraCliMutationResult> {
  const p = paths();
  try {
    const manifest = await readManifest(p);
    if (!manifest || !(await launcherOwnedBy(p.launcher, manifest.installId))) {
      const status = await inspectCoraCliInstall();
      return {
        ok: false,
        status,
        error: "Codara could not prove ownership of the installed command, so nothing was removed.",
      };
    }
    await fs.rm(p.launcher, { force: true });
    if (isInside(p.versions, manifest.payloadPath)) {
      await fs.rm(manifest.payloadPath, { force: true });
    }
    await fs.rm(p.manifest, { force: true });
    return { ok: true, status: await inspectCoraCliInstall() };
  } catch (error) {
    return mutationFailure(error);
  }
}

export async function refreshManagedCoraCliInstall(): Promise<void> {
  const p = paths();
  if (!(await readManifest(p))) return;
  const status = await inspectCoraCliInstall();
  if (status.state !== "needs-repair") return;
  const result = await installCoraCli();
  if (!result.ok) {
    console.warn(`[cora-cli] automatic repair failed: ${result.error}`);
  }
}
