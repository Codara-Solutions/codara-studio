// Content the benchmark feeds both apps: the same chat text, the same stream
// cadence and the same fake terminal agent, so differences come from the app.

const PARAGRAPHS = [
  "The workspace switcher repaints the whole rail on every change, so the first step is to find what actually re-renders.",
  "Here is the hot path, with the parts that run on every keystroke marked. The composer state lives too high in the tree.",
  "I checked the terminal pipeline as well: output is coalesced in the main process and flushed to the renderer once per frame.",
  "Two things stand out in the profile: a full markdown re-parse per streamed chunk, and a layout read right after a style write.",
];

const CODE = [
  "```ts",
  "export function coalesce<T>(items: T[], key: (item: T) => string): Map<string, T[]> {",
  "  const out = new Map<string, T[]>();",
  "  for (const item of items) {",
  "    const k = key(item);",
  "    const list = out.get(k);",
  "    if (list) list.push(item);",
  "    else out.set(k, [item]);",
  "  }",
  "  return out;",
  "}",
  "```",
].join("\n");

// One assistant message of roughly `chars` characters: paragraphs, a list, a
// code block and a table, the mix a coding agent actually produces.
export function chatMarkdown(seed, chars = 1600) {
  const parts = [];
  let index = seed;
  while (parts.join("\n\n").length < chars) {
    const kind = index % 4;
    if (kind === 0) parts.push(PARAGRAPHS[index % PARAGRAPHS.length]);
    if (kind === 1) parts.push(["- **Rail**: memoize rows by id", "- **Composer**: keep draft state local", "- **Terminal**: batch writes per frame"].join("\n"));
    if (kind === 2) parts.push(CODE);
    if (kind === 3) parts.push(["| Flow | Before | After |", "| --- | ---: | ---: |", `| Switch | ${120 + index} ms | ${40 + (index % 9)} ms |`, `| Type | ${18 + (index % 5)} ms | 6 ms |`].join("\n"));
    index += 1;
  }
  return parts.join("\n\n");
}

// A long reply split the way a model streams it: small token-sized pieces.
export function streamChunks(totalChars = 24_000, chunkChars = 4) {
  const text = chatMarkdown(1, totalChars);
  const chunks = [];
  for (let at = 0; at < text.length; at += chunkChars) chunks.push(text.slice(at, at + chunkChars));
  return { text, chunks };
}

// A stand-in for a terminal coding agent: an alternate-screen TUI that redraws
// a spinner and status line ten times a second and streams a line of output
// every 200 ms, which is about what Claude Code or Codex do while working.
export function fakeAgentSource() {
  return `#!/usr/bin/env node
const frames = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
const out = process.stdout;
let tick = 0, lines = [];
out.write("\\x1b[?1049h\\x1b[?25l");
const draw = () => {
  const rows = out.rows || 40, cols = out.columns || 120;
  if (tick % 2 === 0) lines.push(("Reading src/module-" + tick + ".ts and planning the change for the rail renderer ").slice(0, cols - 2));
  if (lines.length > rows - 4) lines = lines.slice(-(rows - 4));
  let s = "\\x1b[H";
  for (const line of lines) s += line + "\\x1b[K\\r\\n";
  s += "\\x1b[" + (rows - 1) + ";1H\\x1b[2m" + frames[tick % frames.length] + " Working… (" + (tick / 10).toFixed(1) + "s · esc to interrupt)\\x1b[0m\\x1b[K";
  out.write(s);
  tick += 1;
};
const timer = setInterval(draw, 100);
const stop = () => { clearInterval(timer); out.write("\\x1b[?25h\\x1b[?1049l"); process.exit(0); };
process.on("SIGTERM", stop); process.on("SIGINT", stop); process.on("SIGHUP", stop);
`;
}
