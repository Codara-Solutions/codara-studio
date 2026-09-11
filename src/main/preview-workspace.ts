// A run without a resolved workspace must never fall through to the selected UI.
export async function scopePreviewWorkspace(
  params: Record<string, unknown>,
  getRun: (id: string) => Promise<{ workspaceId?: string | null } | null>,
): Promise<void> {
  if (typeof params.runId !== "string" || !params.runId) return;
  const run = await getRun(params.runId);
  if (!run?.workspaceId) throw new Error("The browser run's workspace could not be resolved. No browser tab was opened or changed.");
  params.workspaceId = run.workspaceId;
}
