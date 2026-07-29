// Shared failure classifier for the worker log tails (the automations live
// hero, the LiveBoard sheet, and the Workers grid all poll the same
// fs:readTextTail).
//
// Why this exists: all three panes used to swallow EVERY read error with a
// comment saying the file may not exist yet. When the main-process read
// sandbox rejected the runs directory, every poll threw "Path not allowed",
// each pane silently kept its empty state, and the feed sat on "Worker
// starting..." for the whole run while the log on disk was full of output.
// A missing file really is normal for the first tick or two; anything else is
// a defect and must be visible.

export function describeWorkerLogFailure(err: unknown): string | null {
  const text = err instanceof Error ? err.message : String(err ?? "");
  // The log genuinely does not exist yet: the launch writes it a beat after the
  // attempt becomes visible. Normal, and the next poll picks it up.
  if (/ENOENT|no such file/i.test(text)) return null;
  // Electron wraps main-process throws as "Error invoking remote method 'x':
  // Error: <real message>". Keep only the tail so the pane shows the cause.
  const unwrapped = text.replace(/^Error invoking remote method '[^']*':\s*/, "").replace(/^Error:\s*/, "");
  const detail = unwrapped.trim();
  return detail ? `Could not read the worker log. ${detail}` : "Could not read the worker log.";
}
