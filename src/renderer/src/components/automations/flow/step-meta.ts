import type { LoomStepAction, LoomStepNode } from "@shared/types";

// Presentation metadata for STEP nodes (the non-AI actions), shared by the
// canvas cards, the add-node palette, the config panel, the live board and the
// hub's pipeline summary — one vocabulary everywhere. Steps wear the violet
// automation family tone so they read as "the plumbing" next to accent-toned
// AI workers, green guards and blue merges.

export const STEP_TONE = "var(--automation)";

export type StepType = LoomStepAction["type"];

export interface StepMeta {
  type: StepType;
  title: string;
  blurb: string;
  /** Short verb for the card eyebrow ("Shell", "Script", "HTTP", "File", "Notify"). */
  eyebrow: string;
  /** Search keywords for the palette. */
  keywords: string[];
}

export const STEP_META: Record<StepType, StepMeta> = {
  command: {
    type: "command",
    title: "Shell command",
    blurb: "Run a command; its output flows to the next node.",
    eyebrow: "Shell",
    keywords: ["bash", "zsh", "terminal", "cli", "exec", "run", "npm", "make"],
  },
  script: {
    type: "script",
    title: "Script",
    blurb: "Inline Python, Node or Bash. stdout becomes the output.",
    eyebrow: "Script",
    keywords: ["python", "node", "javascript", "bash", "code", "py", "js"],
  },
  http: {
    type: "http",
    title: "HTTP request",
    blurb: "Call an API or webhook; the response body is the output.",
    eyebrow: "HTTP",
    keywords: ["api", "webhook", "fetch", "curl", "rest", "json", "post", "get", "slack", "discord"],
  },
  writeFile: {
    type: "writeFile",
    title: "Write file",
    blurb: "Write or append upstream output to a file.",
    eyebrow: "File",
    keywords: ["save", "append", "log", "notes", "markdown", "disk"],
  },
  notify: {
    type: "notify",
    title: "Notify",
    blurb: "Send yourself a notification with a message.",
    eyebrow: "Notify",
    keywords: ["alert", "toast", "ping", "message", "tell me"],
  },
};

export const STEP_TYPES: StepType[] = ["command", "script", "http", "writeFile", "notify"];

export function defaultStepAction(type: StepType): LoomStepAction {
  switch (type) {
    case "command":
      return { type: "command", command: "" };
    case "script":
      return { type: "script", language: "python", code: "" };
    case "http":
      return { type: "http", method: "GET", url: "" };
    case "writeFile":
      return { type: "writeFile", path: "", content: "{{incoming}}\n", mode: "append" };
    case "notify":
      return { type: "notify", message: "" };
  }
}

/** The one-line summary a card shows under its title. */
export function stepActionLine(action: LoomStepAction): string {
  switch (action.type) {
    case "command":
      return action.command.trim() ? `$ ${firstLine(action.command)}` : "no command yet";
    case "script": {
      const lang = action.language === "node" ? "node" : action.language;
      return action.code.trim() ? `${lang} · ${firstLine(action.code)}` : `${lang} · empty`;
    }
    case "http":
      return action.url.trim() ? `${action.method} ${action.url.trim()}` : `${action.method} · no url yet`;
    case "writeFile":
      return action.path.trim() ? `${action.mode === "append" ? "append" : "write"} ${action.path.trim()}` : "no path yet";
    case "notify":
      return action.message.trim() ? `“${firstLine(action.message)}”` : "no message yet";
  }
}

/** The first non-empty problem with a step's config, or null when runnable. */
export function validateStepAction(action: LoomStepAction): string | null {
  switch (action.type) {
    case "command":
      return action.command.trim() ? null : "needs a command.";
    case "script":
      return action.code.trim() ? null : "needs some code.";
    case "http": {
      const url = action.url.trim();
      if (!url) return "needs a URL.";
      if (!/^(https?:\/\/|\{\{)/i.test(url)) return "URL must start with http:// or https://.";
      return null;
    }
    case "writeFile":
      return action.path.trim() ? null : "needs a file path.";
    case "notify":
      return action.message.trim() ? null : "needs a message.";
  }
}

export function stepTitle(node: Pick<LoomStepNode, "label" | "action">): string {
  return node.label?.trim() || STEP_META[node.action.type].title;
}

function firstLine(s: string): string {
  const line = s.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}
