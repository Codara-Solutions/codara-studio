// The stylesheet of a Markdown page shared as a link. It mirrors the preview
// (markdown-preview/markdown.css) with fixed colors, since the app's tokens do
// not exist on the shared page, and follows the reader's light or dark mode.

export const SHARED_MARKDOWN_CSS = `
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --ink: #1f2328;
  --ink-dim: #31363c;
  --muted: #656d76;
  --rule: #d0d7de;
  --rule-soft: #e4e8ec;
  --panel: #f6f8fa;
  --accent: #0969da;
  --hl-keyword: #cf222e;
  --hl-type: #953800;
  --hl-string: #0a3069;
  --hl-meta: #0550ae;
  --hl-number: #953800;
  --hl-title: #8250df;
  --hl-tag: #116329;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #15171a;
    --ink: #e6e8eb;
    --ink-dim: #c9cdd2;
    --muted: #8b939c;
    --rule: #3a3f45;
    --rule-soft: #2b2f34;
    --panel: #1d2024;
    --accent: #6cb6ff;
    --hl-keyword: #ff7b72;
    --hl-type: #ffa657;
    --hl-string: #a5d6ff;
    --hl-meta: #79c0ff;
    --hl-number: #f2cc60;
    --hl-title: #d2a8ff;
    --hl-tag: #7ee787;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); }
body {
  color: var(--ink);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Helvetica Neue", sans-serif;
  font-size: 16px;
  line-height: 1.6;
  word-wrap: break-word;
}
main {
  max-width: 860px;
  margin: 0 auto;
  padding: 40px 16px 80px;
}
main > *:first-child { margin-top: 0; }
h1, h2, h3, h4, h5, h6 { font-weight: 600; line-height: 1.25; margin: 1.6em 0 0.6em; }
h1 { font-size: 2em; padding-bottom: 0.3em; border-bottom: 1px solid var(--rule-soft); }
h2 { font-size: 1.5em; padding-bottom: 0.3em; border-bottom: 1px solid var(--rule-soft); }
h3 { font-size: 1.25em; }
h4 { font-size: 1em; }
h5 { font-size: 0.875em; }
h6 { font-size: 0.85em; color: var(--muted); }
p { margin: 0 0 16px; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
hr { border: 0; border-top: 1px solid var(--rule-soft); margin: 24px 0; }
ul, ol { margin: 0 0 16px; padding-left: 2em; }
li + li { margin-top: 0.25em; }
li > p { margin-bottom: 8px; }
li.task-list-item { list-style: none; margin-left: -1.5em; }
li.task-list-item input[type="checkbox"] { margin: 0 0.5em 0.1em -0.2em; vertical-align: middle; }
blockquote {
  margin: 0 0 16px;
  padding: 0.4em 1em;
  color: var(--ink-dim);
  background: var(--panel);
  border-left: 3px solid var(--rule);
  border-radius: 0 5px 5px 0;
}
blockquote > :last-child { margin-bottom: 0; }
code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 0.85em;
  background: var(--panel);
  border: 1px solid var(--rule-soft);
  padding: 0.15em 0.4em;
  border-radius: 4px;
}
pre {
  margin: 0 0 16px;
  padding: 14px 16px;
  background: var(--panel);
  border: 1px solid var(--rule-soft);
  border-radius: 7px;
  overflow-x: auto;
  font-size: 13px;
  line-height: 1.5;
}
pre code { background: transparent; border: 0; padding: 0; font-size: inherit; color: var(--ink-dim); white-space: pre; }
table { display: block; width: 100%; overflow: auto; margin: 0 0 16px; border-collapse: collapse; font-size: 14px; font-variant-numeric: tabular-nums; }
th, td { padding: 6px 13px; border: 1px solid var(--rule-soft); }
th { background: var(--panel); font-weight: 600; text-align: left; border-bottom-color: var(--rule); }
tr:nth-child(2n) { background: var(--panel); }
img { max-width: 100%; height: auto; border-radius: 6px; }
.diagram {
  margin: 16px 0;
  padding: 16px;
  background: #ffffff;
  border: 1px solid var(--rule-soft);
  border-radius: 8px;
  text-align: center;
  overflow-x: auto;
}
.diagram svg { max-width: 100%; height: auto; }
.hljs-comment, .hljs-quote { color: var(--muted); font-style: italic; }
.hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-section, .hljs-link { color: var(--hl-keyword); }
.hljs-built_in, .hljs-type, .hljs-class .hljs-title { color: var(--hl-type); }
.hljs-string, .hljs-attr, .hljs-template-tag, .hljs-template-variable { color: var(--hl-string); }
.hljs-symbol, .hljs-bullet, .hljs-meta { color: var(--hl-meta); }
.hljs-number, .hljs-regexp, .hljs-deletion { color: var(--hl-number); }
.hljs-name, .hljs-attribute, .hljs-variable, .hljs-title { color: var(--hl-title); }
.hljs-tag, .hljs-addition { color: var(--hl-tag); }
.hljs-emphasis { font-style: italic; }
.hljs-strong { font-weight: 700; }
`;
