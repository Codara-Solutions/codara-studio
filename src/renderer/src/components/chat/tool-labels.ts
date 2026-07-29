// Human labels for backend tool calls, shared by the chat stream and the
// Runs inspector so the same call reads identically everywhere.

export function toolDisplayName(toolName: string): string {
  const normalized = toolName.replace(/^mcp__codara-studio__/, "");
  const known: Record<string, string> = {
    Shell: "Inspect workspace",
    Bash: "Run command",
    codara_name_chat: "Name this chat",
    codara_spawn_workers: "Delegate workers",
    codara_spawn_terminals: "Open terminals",
    codara_wait_for_workers: "Wait for workers",
    codara_get_worker_status: "Check worker status",
    codara_message_workers: "Message workers",
    codara_check_messages: "Check worker messages",
    codara_complete: "Complete run",
    codara_ask_user: "Ask for a decision",
    codara_remember: "Save to memory",
    codara_whiteboard_get: "Read whiteboard",
    codara_whiteboard_update: "Update whiteboard",
    codara_board_get: "Read board",
    codara_board_update: "Update board",
    codara_list_automations: "List automations",
    codara_get_automation: "Read automation",
    codara_create_automation: "Create automation",
    codara_update_automation: "Update automation",
    codara_run_automation: "Run automation",
    codara_wait_for_automation: "Wait for automation",
    codara_set_automation_enabled: "Toggle automation",
    codara_pause_automation: "Pause automation",
    codara_resume_automation: "Resume automation",
    codara_stop_automation: "Stop automation",
    codara_delete_automation: "Delete automation",
  };
  const knownName = known[normalized];
  if (knownName) return knownName;
  return normalized
    .replace(/^codara_/, "")
    .split("_")
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ") || toolName;
}

export function toolInputSummary(toolName: string, input: unknown): string {
  const value = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : null;
  if (!value) return compactPreview(formatToolPayload(input));
  const normalized = toolName.replace(/^mcp__codara-studio__/, "");
  if (normalized === "codara_name_chat" && typeof value.title === "string") {
    return `“${value.title}”`;
  }
  if (normalized === "codara_spawn_workers" && Array.isArray(value.workers)) {
    const titles = value.workers
      .map((worker) => worker && typeof worker === "object" && typeof (worker as Record<string, unknown>).title === "string"
        ? String((worker as Record<string, unknown>).title)
        : "")
      .filter(Boolean);
    return `${value.workers.length} ${value.workers.length === 1 ? "worker" : "workers"}${titles.length ? ` · ${titles.join(", ")}` : ""}`;
  }
  if (normalized === "codara_wait_for_workers" && Array.isArray(value.worker_task_ids)) {
    return `${value.worker_task_ids.length} ${value.worker_task_ids.length === 1 ? "worker" : "workers"} · ${value.mode === "any" ? "first result" : "all results"}`;
  }
  if (normalized === "codara_get_worker_status") return "Refresh execution state";
  if (normalized === "codara_remember") {
    const scope = value.scope === "global" ? "Global memory" : "Workspace memory";
    // A `replace` rewrites the whole file, so a bullet count would misdescribe
    // it; say what happened instead.
    if (value.action === "replace") return `${scope} · consolidated`;
    const notes = Array.isArray(value.bullets) ? value.bullets.length : 0;
    return `${scope}${notes ? ` · ${notes} ${notes === 1 ? "note" : "notes"}` : ""}`;
  }
  if (normalized === "codara_whiteboard_get") return "Read the current visual explanation";
  if (normalized === "codara_whiteboard_update") {
    const nodes = Array.isArray(value.nodes) ? value.nodes.length : 0;
    const edges = Array.isArray(value.edges) ? value.edges.length : 0;
    const verb = value.action === "merge" ? "Extend" : value.action === "clear" ? "Clear" : "Build";
    return `${verb} board${nodes ? ` · ${nodes} cards` : ""}${edges ? ` · ${edges} links` : ""}`;
  }
  if ((normalized === "Shell" || normalized === "Bash") && typeof value.command === "string") {
    const command = value.command;
    if (/\b(find|rg|grep|ls)\b/.test(command)) return "Read project structure";
    if (/\b(pwd)\b/.test(command)) return "Confirm workspace context";
    return `$ ${compactPreview(command)}`;
  }
  return compactPreview(formatToolPayload(input));
}

// One human line per tool call: a verb-first title ("Read README.md") and an
// optional muted detail (the full path, pattern, or command). Raw payloads
// stay behind the disclosure — the headline is what the conversation needs.
export function toolCallHeadline(toolName: string, input: unknown): { title: string; detail: string } {
  const value = input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
  const normalized = toolName.replace(/^mcp__codara-studio__/, "").toLowerCase();
  const path = firstString(value, ["path", "file_path", "filePath", "filename", "notebook_path"]);
  const base = path ? path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? path : null;
  const pathDetail = path && path !== base ? path : "";
  if (["read", "read_file", "readfile", "cat", "view", "open"].includes(normalized)) {
    return { title: base ? `Read ${base}` : "Read file", detail: pathDetail };
  }
  if (["write", "write_file", "writefile", "create_file", "save"].includes(normalized)) {
    return { title: base ? `Wrote ${base}` : "Wrote file", detail: pathDetail };
  }
  if (["edit", "multiedit", "multi_edit", "str_replace", "str_replace_editor", "apply_patch", "patch"].includes(normalized)) {
    return { title: base ? `Edited ${base}` : "Edited file", detail: pathDetail };
  }
  if (["ls", "list", "list_dir", "list_directory", "listdirectory"].includes(normalized)) {
    return { title: base ? `Listed ${base}` : "Listed directory", detail: pathDetail };
  }
  if (["grep", "rg", "ripgrep", "search", "code_search", "find", "glob"].includes(normalized)) {
    const pattern = firstString(value, ["pattern", "query", "regex", "search", "glob"]);
    return {
      title: pattern ? `Searched for “${compactPreview(pattern)}”` : "Searched the workspace",
      detail: firstString(value, ["path", "dir", "directory"]) ?? "",
    };
  }
  if (["webfetch", "fetch", "web_fetch", "curl"].includes(normalized)) {
    const url = firstString(value, ["url"]);
    return { title: "Fetched a page", detail: url ? compactPreview(url) : "" };
  }
  if (["websearch", "web_search"].includes(normalized)) {
    const query = firstString(value, ["query"]);
    return { title: query ? `Searched the web for “${compactPreview(query)}”` : "Searched the web", detail: "" };
  }
  if ((normalized === "shell" || normalized === "bash") && typeof value?.command === "string") {
    const command = value.command;
    if (/\b(find|rg|grep|ls)\b/.test(command)) {
      return { title: "Read project structure", detail: `$ ${compactPreview(command)}` };
    }
    if (/\bpwd\b/.test(command)) return { title: "Confirmed workspace context", detail: "" };
    const word = command.trim().split(/\s+/)[0] ?? "command";
    return { title: `Ran ${word}`, detail: `$ ${compactPreview(command)}` };
  }
  if (normalized === "codara_wait_for_workers") {
    const count = Array.isArray(value?.worker_task_ids) ? value.worker_task_ids.length : 0;
    return {
      title: count > 0 ? `Waiting for ${count} ${count === 1 ? "worker" : "workers"}` : "Waiting for workers",
      detail: value?.mode === "any" ? "first result" : "all results",
    };
  }
  if (normalized === "codara_spawn_workers" && Array.isArray(value?.workers)) {
    const workers = value.workers;
    const runtimes = new Map<string, number>();
    for (const worker of workers) {
      const runtime = worker && typeof worker === "object" && typeof (worker as Record<string, unknown>).runtime === "string"
        ? String((worker as Record<string, unknown>).runtime)
        : "";
      if (runtime) runtimes.set(runtime, (runtimes.get(runtime) ?? 0) + 1);
    }
    const mix = [...runtimes.entries()]
      .map(([runtime, count]) => `${count} ${runtime.charAt(0).toUpperCase()}${runtime.slice(1)}`)
      .join(" · ");
    return {
      title: workers.length > 0
        ? `Delegating ${workers.length} ${workers.length === 1 ? "worker" : "workers"}`
        : "Delegating workers",
      // e.g. "2 Claude · 1 Codex"; empty when the payload omits runtimes.
      detail: mix,
    };
  }
  return { title: toolDisplayName(toolName), detail: toolInputSummary(toolName, input) };
}

// The worker task ids a `wait_for_workers` call is blocked on, or null for any
// other tool. Lets the chat replace the static "all results" detail with the
// live composition of that wait (see summarizeWorkerWait).
export function waitForWorkersTaskIds(toolName: string, input: unknown): string[] | null {
  const normalized = toolName.replace(/^mcp__codara-studio__/, "").toLowerCase();
  if (normalized !== "codara_wait_for_workers") return null;
  const value = input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
  const ids = value?.worker_task_ids;
  if (!Array.isArray(ids)) return null;
  const taskIds = ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0);
  return taskIds.length > 0 ? taskIds : null;
}

function firstString(value: Record<string, unknown> | null, keys: string[]): string | null {
  if (!value) return null;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return null;
}

export function compactPreview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= 96) return flat;
  return `${flat.slice(0, 93)}...`;
}

export function formatToolPayload(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}
