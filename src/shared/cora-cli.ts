export type CoraCliInstallState =
  | "not-installed"
  | "installed"
  | "needs-path"
  | "needs-repair"
  | "conflict"
  | "unsupported";

export interface CoraCliInstallStatus {
  state: CoraCliInstallState;
  commandPath?: string;
  binDirectory?: string;
  onPath: boolean;
  installedVersion?: string;
  currentVersion: string;
  message: string;
  pathInstruction?: string;
  canInstall: boolean;
  canUninstall: boolean;
}

export type CoraCliMutationResult =
  | { ok: true; status: CoraCliInstallStatus }
  | { ok: false; status: CoraCliInstallStatus; error: string };
