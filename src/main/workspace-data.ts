// Codara's own data folder for one workspace:
// <codara home>/workspace-data/<workspace id>/. Tool output too large for an
// agent's context (screenshots, network bodies, traces, attachments the user
// sends) goes here, never into the user's repository.

import { join } from "node:path";

import { codaraHome } from "./codara-home";

const NO_WORKSPACE = "_no-workspace";

export function safeWorkspaceSegment(workspaceId: string | null | undefined): string {
  const raw = typeof workspaceId === "string" ? workspaceId.trim() : "";
  if (!raw) return NO_WORKSPACE;
  const safe = raw.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 80);
  return safe || NO_WORKSPACE;
}

export function workspaceDataDir(workspaceId: string | null | undefined, ...segments: string[]): string {
  return join(codaraHome(), "workspace-data", safeWorkspaceSegment(workspaceId), ...segments);
}
