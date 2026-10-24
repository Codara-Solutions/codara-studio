// Studio tool families that Cora's manager loads on demand.
//
// The manager roster carries about 55 bridge tools, and the browser, terminal,
// whiteboard, board and automation families alone are roughly two thirds of
// the tool schema bytes every request re-sends. Most turns use none of them,
// so index.ts registers them all but keeps these families inactive until the
// model asks for one through the codara_tools loader. Activation through a
// tool result is Pi's deferred-tool signal, which keeps the cached request
// prefix intact on providers that support deferred loading.
//
// The family procedures (how to build a whiteboard, how to author an
// automation, ...) ride on the loader's result instead of the system prompt,
// so a plain chat never pays for them either.
//
// Pure and import-free so scripts/test-pi-cora-extension.cjs can load it
// outside Pi. The browser family's snapshot workflow lives in prompt.ts
// (workers share it), so index.ts appends it to the browser guidance.

export type StudioToolFamily =
  | "browser"
  | "terminal"
  | "whiteboard"
  | "board"
  | "automations"
  | "worktrees"
  | "workflows";

export const STUDIO_TOOL_FAMILIES: readonly StudioToolFamily[] = [
  "browser",
  "terminal",
  "whiteboard",
  "board",
  "automations",
  "worktrees",
  "workflows",
];

export const STUDIO_TOOL_LOADER_NAME = "codara_tools";

export function studioToolFamily(name: string): StudioToolFamily | null {
  if (name.startsWith("codara_preview_")) return "browser";
  if (name.startsWith("codara_terminal_")) return "terminal";
  if (name.startsWith("codara_whiteboard_")) return "whiteboard";
  if (name.startsWith("codara_board_")) return "board";
  if (/^codara_[a-z_]*automation/.test(name)) return "automations";
  if (name.startsWith("codara_worktree_")) return "worktrees";
  if (name.startsWith("codara_workflow_")) return "workflows";
  return null;
}

export function isStudioToolFamily(value: unknown): value is StudioToolFamily {
  return typeof value === "string" && (STUDIO_TOOL_FAMILIES as readonly string[]).includes(value);
}

const FAMILY_SIGNALS: Record<StudioToolFamily, RegExp> = {
  browser:
    /\b(?:browser|preview|localhost|website|web ?page|web ?site|screenshot|homepage|landing page|click|https?:\/\/\S+)/i,
  terminal: /\b(?:terminal|dev server|watch(?:er)?|npm run dev|pnpm dev|yarn dev|start the (?:app|server)|run the (?:app|server))\b/i,
  whiteboard: /\b(?:whiteboard|diagram|draw|sketch|visuali[sz]e|project map|architecture map)\b/i,
  board: /\b(?:board|kanban|cards?)\b|codara_board_/i,
  automations:
    /\b(?:automations?|loom|schedul(?:e|ed|ing)|cron|recurring|nightly|daily|hourly|weekly|every (?:day|night|hour|morning|evening|week|weekday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d+\s*(?:min(?:ute)?s?|hours?|days?)))\b/i,
  worktrees: /\bwork ?trees?\b|codara_worktree_/i,
  workflows: /\bworkflows?\b|codara_workflow_/i,
};

interface BranchEntryLike {
  type?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
    toolName?: unknown;
    addedToolNames?: unknown;
  };
}

function branchMessages(entries: readonly unknown[]): NonNullable<BranchEntryLike["message"]>[] {
  const messages: NonNullable<BranchEntryLike["message"]>[] = [];
  for (const entry of entries) {
    const candidate = entry as BranchEntryLike | null;
    if (candidate?.type === "message" && candidate.message) messages.push(candidate.message);
  }
  return messages;
}

/** Families a resumed session already loaded or used. They stay active after
 *  a restart, so the transcript never references a tool the request lacks. */
export function familiesUsedInBranch(entries: readonly unknown[]): Set<StudioToolFamily> {
  const used = new Set<StudioToolFamily>();
  const note = (name: unknown) => {
    const family = typeof name === "string" ? studioToolFamily(name) : null;
    if (family) used.add(family);
  };
  for (const message of branchMessages(entries)) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content as Array<{ type?: unknown; name?: unknown }>) {
        if (block?.type === "toolCall") note(block.name);
      }
    } else if (message.role === "toolResult") {
      note(message.toolName);
      if (Array.isArray(message.addedToolNames)) message.addedToolNames.forEach(note);
    }
  }
  return used;
}

/** True once the session has sent at least one model request. */
export function branchHasAssistantTurn(entries: readonly unknown[]): boolean {
  return branchMessages(entries).some((message) => message.role === "assistant");
}

/** Families a request plainly needs. Used only before the first model request
 *  of a session, when changing the tool list cannot invalidate a cached
 *  prefix. */
export function familiesForRequest(text: string): StudioToolFamily[] {
  if (!text.trim()) return [];
  return STUDIO_TOOL_FAMILIES.filter((family) => FAMILY_SIGNALS[family].test(text));
}

/** One short line for Pi's "Available tools" list. The full description still
 *  travels in the tool schema, so repeating it in the system prompt only
 *  doubles its cost. */
export function toolPromptSnippet(description: string, maxChars = 100): string {
  const flat = description.replace(/\s+/g, " ").trim();
  const sentence = flat.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? flat;
  if (sentence.length <= maxChars) return sentence;
  const cut = sentence.slice(0, maxChars - 3);
  const space = cut.lastIndexOf(" ");
  return `${(space > maxChars / 2 ? cut.slice(0, space) : cut).trimEnd()}...`;
}

export const STUDIO_FAMILY_GUIDANCE: Record<StudioToolFamily, string> = {
  browser: `Browser: codara_preview_* drives Codara Studio's Browser tabs and the tabs the
user shared from their own Chrome (ids like chrome:123; codara_preview_list shows both).
Use trusted mouse/key/scroll/hover/drag tools for native input when needed.`,
  terminal: `Dev servers: list the workspace's saved ones with codara_terminal_servers and
start one by id, or start a new one there with its command. Codara keeps it
running across restarts and never starts a second copy.
Terminal tabs: start watchers and anything else that does not exit with
codara_terminal_create (retention "service" only when the user needs it
afterwards), poll codara_terminal_read for the ready line, then verify with the
Browser. Close temporary terminals with codara_terminal_close when done.`,
  whiteboard: `Whiteboard: build an explanation through investigation, draft, inspection,
and revision. A single write is not a finished board. First read with
codara_whiteboard_get, preserve human edits, and pass baseRevision to
codara_whiteboard_update.
For a project map, inspect entry points, module boundaries, imports/calls,
storage and external interfaces. Trace at least one end-to-end path. Add
repository path:line sources to file/symbol cards and confirmed connections;
mark hypotheses as inferred instead of inventing links from file names.
Name inspected areas and unexplored boundaries; a partial map is not exhaustive.
Where this mode permits workers and a large map has independent areas, use
2-3 bounded leaf researchers in one batch on enabled economical models at
low effort, each with its own notes file and no source edits. Ask for entry
points, callers/callees, source references, and unresolved links. Read their
evidence and reconcile cross-module connections yourself. Small maps and
modes without workers use your own reading tools. Respect the model allowlist
and any user limit; do not spawn workers just for layout.
Start with a readable overview (roughly 8-20 cards), then add focused detail.
Keep titles terse and branches labeled, cluster related modules, and use
codara_whiteboard_arrange for new drafts or requested layout improvements.
After writing, call codara_whiteboard_inspect: actually examine its image
and diagnostics. If detailNeeded, inspect nodeIds crops until all cards are
readable. Check arrow direction, missing dependencies, source accuracy,
overlap, clipped labels, and whether the board answers the user's question.
Correct problems with merge, re-read after conflicts, then inspect the new
revision. Call codara_whiteboard_review with the checks performed and honest
limitations. Never call a draft verified. If rendering is unavailable,
disclose that the visual review is incomplete instead of retrying in a loop.`,
  board: `Board: this chat has a Cora Board of task cards (codara_board_get). The user
drops idea cards and drags the ones they want done to Queued. When you can
spawn workers, work the board actively: enrich each queued card into a well
scoped worker brief, spawn workers (independent cards in parallel), and keep
the lanes truthful with codara_board_update (running with its workerTaskId,
review or done once verified, blocked with a short note plus
codara_ask_user). Never delete a card the user created.`,
  automations: `Automations: build recurring or scheduled work with codara_create_automation
(explicit trigger, loop policy with stop caps, and a node graph). Nodes come in
two families: WORKERS (an AI agent with model + effort running a prompt) and
STEPS (deterministic, no AI: 'command' runs a shell line, 'script' runs inline
python/node/bash with an optional interpreter like "uv run python", 'http'
calls an API/webhook, 'writeFile' writes or appends a file, 'notify' pings the
user). Plus 'guard' (branch pass/fail on a condition) and 'merge' (join
branches). Prefer a STEP wherever the work is mechanical (collect data, run
tests, call a webhook, save a report) and a WORKER only where judgment is
needed; a loom may be steps-only. Data flows along edges: each node's output
(stdout / response body / summary) reaches the next as {{node:<id>}} or
{{incoming}}, and shell or script steps also see it as $NODE_OUTPUT_<ID> and
$INCOMING. Inside a JSON body use {{node:<id>|json}} (a quoted JSON string) so
quotes and newlines in the value never break the payload; |line gives the
first line. In a looping worker prompt, {{lastOutput}} is the previous pass's
summary; use it (or have the worker keep a progress file it reads first and
updates before signaling) so each pass continues instead of starting over.
Get the user's agreement in prose before creating or enabling anything
recurring; mutations ask for consent in chat. Never fall back to crontab,
launchd, or schtasks.`,
  worktrees: `Worktrees: codara_worktree_create gives an isolated checkout of this
chat's repository on its own branch, listed in the user's rail. Your cwd does
not change: hand workers the returned path (they work there with absolute
paths or git -C) and run setupCommand there when it is set. Codara prepares
the checkout from the repository's .worktreeinclude and .codara/worktree.json;
when the result's setup has not finished, call codara_worktree_setup with
wait:true before work starts there, and on failure read its logTail. Linked
folders are shared with the main checkout: never install into or delete them.
A setup awaiting-approval waits for the user to approve its commands; never
run them, or the setup file's terminal commands, yourself. Once the branch is
merged, call codara_worktree_remove. It refuses anything unmerged, dirty or in
use and never forces; act on its code and hint, and ask the user rather than
deleting work yourself. codara_worktree_list shows what is removable.
To clean up worktrees across every repository, scan with
codara_worktree_cleanup, explain its recommendations to the user in plain
words, then call it with action "remove"; the user approves each one in Codara.`,
  workflows: `Workflows: a script that runs many agents. Shape:
  export const meta = { name: "kebab-name", description: "...", phases: [{ title: "Find" }], args: {JSON Schema} };
  phase("Find");
  const found = await parallel(items.map((item) => () => agent("prompt", { label, schema })));
  return { ... };
Top-level await and return work. agent(prompt, opts) resolves to the agent's
summary, or to its result when opts.schema (an object JSON Schema) is given;
it resolves null when the agent fails, never throws for that. opts: label,
phase, schema, model, effort, access ('full' | 'edits' | 'readonly'),
agentType ('worker' | 'verifier' | 'researcher'), isolation: 'worktree' (own
branch per agent, use for parallel writers), heavy (builds, full test
suites: one at a time), timeoutMinutes, compactAt, envelope. parallel(thunks)
never rejects (a throw becomes null); pipeline(items, ...stages) streams each
item through the stages with no barrier; log(msg) narrates. The script must
be deterministic: no Math.random, Date.now, timers, fetch or files; agents do
all I/O. Scout the work list inline first, write prompts that stand alone,
then codara_workflow_check until clean, then codara_workflow_run (the user
approves its estimate in the chat). Wait with codara_workflow_wait or report
the run id and end your turn. Saved workflows: codara_workflow_list.`,
};
