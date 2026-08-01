import type { UserConstitutionCapture } from "@shared/types";

export type WorkerConstitutionLaunchSurface =
  | "pi-managed"
  | "claude-sdk"
  | "codex-app-server"
  | "claude-cli"
  | "legacy-codex-cli"
  | "shell"
  | "manual"
  | "third-party";

export type SupportedWorkerConstitutionLaunchSurface = Extract<
  WorkerConstitutionLaunchSurface,
  "pi-managed" | "claude-sdk" | "codex-app-server" | "claude-cli"
>;

export interface WorkerConstitutionLaunchSupportInput {
  runtimePreference: unknown;
  isAutomationRun: boolean;
  usePiWorkerHarness: boolean;
}

/**
 * Classify the concrete worker launch seam rather than trusting the persisted
 * runtime union. Old or externally-written runs can contain unknown runtime
 * values, and an enabled capture must fail closed on those values too.
 */
export function workerConstitutionLaunchSurface({
  runtimePreference,
  isAutomationRun,
  usePiWorkerHarness,
}: WorkerConstitutionLaunchSupportInput): WorkerConstitutionLaunchSurface {
  if (
    usePiWorkerHarness &&
    (runtimePreference === "claude" || runtimePreference === "codex")
  ) {
    return "pi-managed";
  }
  if (isAutomationRun && runtimePreference === "claude") {
    return "claude-sdk";
  }
  if (isAutomationRun && runtimePreference === "codex") {
    return "codex-app-server";
  }
  if (runtimePreference === "claude") return "claude-cli";
  if (runtimePreference === "codex") return "legacy-codex-cli";
  if (runtimePreference === "shell") return "shell";
  if (runtimePreference === "manual") return "manual";
  return "third-party";
}

export function workerConstitutionLaunchSurfaceIsSupported(
  surface: WorkerConstitutionLaunchSurface,
): surface is SupportedWorkerConstitutionLaunchSurface {
  return (
    surface === "pi-managed" ||
    surface === "claude-sdk" ||
    surface === "codex-app-server" ||
    surface === "claude-cli"
  );
}

const UNSUPPORTED_REASON_BY_SURFACE: Readonly<
  Record<
    Exclude<
      WorkerConstitutionLaunchSurface,
      SupportedWorkerConstitutionLaunchSurface
    >,
    string
  >
> = {
  "legacy-codex-cli":
    "This worker attempt cannot start because its captured global user constitution is enabled, but the legacy visible Codex CLI launch cannot consume exact attempt guidance securely.",
  shell:
    "This worker attempt cannot start because its captured global user constitution is enabled, but the shell worker launch cannot consume exact attempt guidance securely.",
  manual:
    "This worker attempt cannot start because its captured global user constitution is enabled, but the manual worker launch cannot consume exact attempt guidance securely.",
  "third-party":
    "This worker attempt cannot start because its captured global user constitution is enabled, but this third-party worker launch cannot consume exact attempt guidance securely.",
};

/**
 * Disabled and legacy attempts are byte/behavior preserving no-ops. Enabled
 * captures receive a stable, content-free failure reason on unsupported seams.
 */
export function unsupportedEnabledWorkerConstitutionReason(
  capture: UserConstitutionCapture | undefined,
  surface: WorkerConstitutionLaunchSurface,
): string | null {
  if (!capture?.enabledAtCapture) return null;
  if (workerConstitutionLaunchSurfaceIsSupported(surface)) return null;
  return UNSUPPORTED_REASON_BY_SURFACE[surface];
}
