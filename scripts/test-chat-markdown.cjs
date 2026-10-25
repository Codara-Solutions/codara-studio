// Links, file references, code blocks and tables in Cora's markdown.
//
//   node scripts/test-chat-markdown.cjs
//
// The rules worth pinning:
//
//   - Only a scheme-less href is a workspace path. Every href with a scheme
//     keeps the external route, so javascript:, vscode: and friends can never
//     reach the file opener.
//   - Relative paths resolve against the run's workspace in that workspace's
//     own form (Windows backslashes, ssh:// prefixes).
//   - Inline code is only treated as a file by its text; existence is probed
//     on click, never during a streamed render.
//   - Markdown outside a run (no workspace context) keeps external-only links.
//   - Chat code is highlighted with theme tokens scoped to .cora-md, code
//     blocks offer Copy (skipping Mermaid), and table rows are divided by horizontal rules.
//   - A reply rendered piece by piece (markdown-blocks.ts) gives exactly the
//     HTML of the whole text at every point of a stream, so finished pieces
//     can skip re-parsing without anything on screen changing. Only the live
//     turn's prose is cut; a settled message renders whole.
//   - A Mermaid diagram remounted when pieces merge paints its cached
//     drawing at once, under its own render id.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const CHAT = path.join(ROOT, "src", "renderer", "src", "components", "chat");
const read = (...segments) => fs.readFileSync(path.join(ROOT, ...segments), "utf8");

async function loadLinks() {
  const out = await esbuild.build({
    entryPoints: [path.join(CHAT, "markdown-links.ts")],
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
    logLevel: "silent",
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

// The chat pipeline (react-markdown's unified chain with Cora's plugins),
// once with rehype-highlight attached fresh per processor and once with the
// shared transformer, so the two outputs can be compared.
async function loadHighlightPipeline() {
  const out = await esbuild.build({
    stdin: {
      contents: `
        import { unified } from "unified";
        import remarkParse from "remark-parse";
        import remarkGfm from "remark-gfm";
        import remarkBreaks from "remark-breaks";
        import remarkRehype from "remark-rehype";
        import rehypeHighlight from "rehype-highlight";
        import { rehypeHighlightShared } from "./src/renderer/src/lib/rehype-highlight-shared";
        const run = (plugin, text) => {
          const processor = unified().use(remarkParse).use([remarkGfm, remarkBreaks]).use(remarkRehype).use([plugin]);
          return processor.runSync(processor.parse(text));
        };
        export const fresh = (text) => run(rehypeHighlight, text);
        export const shared = (text) => run(rehypeHighlightShared, text);
        export { rehypeHighlightShared };
      `,
      resolveDir: ROOT,
      loader: "ts",
    },
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
    logLevel: "silent",
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

// The chat chain through react-markdown and React's server renderer, whole
// and split into pieces the way Markdown.tsx renders them.
async function loadBlockRenderer() {
  const out = await esbuild.build({
    stdin: {
      contents: `
        import React from "react";
        import { renderToStaticMarkup } from "react-dom/server";
        import ReactMarkdown from "react-markdown";
        import remarkGfm from "remark-gfm";
        import remarkBreaks from "remark-breaks";
        import { rehypeHighlightShared } from "./src/renderer/src/lib/rehype-highlight-shared";
        import { chatUrlTransform, remarkTabLinks } from "./src/renderer/src/components/chat/remark-tab-links";
        import { splitMarkdownBlocks } from "./src/renderer/src/components/chat/markdown-blocks";
        const props = { remarkPlugins: [remarkGfm, remarkBreaks, remarkTabLinks], rehypePlugins: [rehypeHighlightShared], urlTransform: chatUrlTransform };
        const md = (text) => React.createElement(ReactMarkdown, props, text);
        export const whole = (text) => renderToStaticMarkup(md(text));
        export const pieces = (text) =>
          renderToStaticMarkup(React.createElement(React.Fragment, null, ...splitMarkdownBlocks(text).flatMap((piece, index) => (index ? ["\\n", md(piece)] : [md(piece)]))));
        export { splitMarkdownBlocks };
      `,
      resolveDir: ROOT,
      loader: "ts",
    },
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
    logLevel: "silent",
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

// Shapes where cutting at a blank line would change the parse: loose lists,
// fences holding blank lines (also indented, in list items, longer fences,
// tildes), raw HTML, definitions, tabs, CRLF, and a fence left open.
const BLOCK_SAMPLES = [
  "Intro paragraph.\n\n- one\n- two\n\n- three, now loose\n\nAfter the list.",
  "1. first\n\n2. second\n\nText\n\n3. restarts at three",
  "Steps:\n\n1. Install\n\n   ```bash\n   npm i\n\n   npm test\n   ```\n\n2. Run it\n\nDone.",
  "- item\n  ```\n  a\n\nb\n  ```\n\nafter",
  "- ```\n  inside\n  ```\n  ```\n  b\n\n  c\n  ```\n\nTail ```",
  "- ```\n  code\n\n```\nmore code\n\ntext",
  "````md\n```\nnot closed by three\n\n```\nstill code\n````\n\nOut.",
  "~~~\ntilde\n\n```\n~~~\n\nafter tilde",
  "  ```\n  indented fence\n\nunindented content\n  ```\n\npara",
  "1. a\n   ```\n   x\n ```\nin code\n\nstill code\n```\n\nafter",
  "```ts\nexport const a = 1;\n\nexport const b = 2;\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n| 3 |",
  "<div>\n```\n</div>\n\n```\na\n\nb\n```\n\nend",
  "<!-- note\n\nhidden -->\n\nshown",
  "<pre>\n\nraw\n</pre>\n\nafter",
  "See [the docs][d] and a note[^1].\n\nMore.\n\n[d]: https://example.com\n\n[^1]: The note.",
  "> quoted\n\n> second quote\n>\n> still second\n\nplain",
  "Title\n\n===\n\nTitle\n===\n\n---\n\n* * *\n\n***",
  "- a\n\n\tindented by tab\n\nnext",
  "para\r\n\r\nsecond\r\n\r\n```\r\ncrlf code\r\n\r\nmore\r\n```\r\n\r\nend",
  "\n\nleading blanks\n\n\n\nmany blanks\n\n",
  "Open fence at the end:\n\n```python\ndef f():\n\n    return 1",
  "A codara://tab/abc link\n\n- [ ] task\n- [x] done\n\n~~struck~~ and https://example.com",
  "    indented code\n\n    still code\n\nback out",
  "+ plus\n\n+ plus loose\n\n10. ten\n\n-\n\n- after empty item",
  "x\r```\n\ny\n```\n\nz",
  "~~~ a\u2028b\n\ncode\n\n~~~\n\nout",
  "see [a\\]b]\n\n[a\\]b]: /url",
  "[foo\nbar]: /url\n\nsee [foo bar]",
  "see [x]\n\n[\nx\n]: /url",
  "\uFEFFa\n\n\uFEFF# h\n\n\uFEFF    code\n\n\uFEFF```\n\nx\n```",
  "Intro:\n\n    npm i\n\n3. Then run",
  "1. Install\n\nThen:\n\n    npm i\n\n2. Run\n\n    x\n\n\n-\n\n\ty\n\n10. b",
  "- ```\n  a\n\n> b\n\n> ~~~\n> c\n\nd\n\n1. ```js\n   e\n\nf",
  "[Docs](https://x.dev) intro\n\n```py\ndef f() -> list[int]:\n```\n\n[a\\]b, [c] and [d][e]\n\n[e]: /url",
  "    a\n\n    \nb\n\n    c\n\n\t\nd",
  "+\n    ```\n\n\n\ns",
  "1. a\n\n     ```\n     b\n\n\nc",
  "1. Install:\n\n    ```bash\n    npm i\n\n    npm test\n    ```\n\n2. Run\n\nDone.\n\n- a\n\n    ~~~\n    x\n    ~~~\n\nEnd",
  "1. a\n\n    ```\n        ```\n\n\nb\n\nc",
  "- a\n\n    ~~~\n    x\n     ~~~~\n\n\nq",
  "1. a\n\n    ```\n     ```\n\n\nb",
  "- a\n\n\t```\n\n\nb\n\n> - a\n>\n>     ```\n\n\nc\n\n1. a\n\n\t ```\n\n\nd",
  "    a\n\n> - b\n\n    c\n\n> 2. d\n\n    e\n\n> > -",
  "- >q\n    <b>\n\nc\n\n- >r\n\t<i>\n\nd\n\n- >s\n \t<u>\n\ne",
  "- a\n    <pre>\n\n\nc\n\n1. x\n\n    <!-- c\n\n    d\n\ne",
  "- <?php\n\n> - q",
  "* s\n-  <?php\n\n```\nx\n```",
  "- <script>\n\n> - q\n\n- <![CDATA[\n\nz",
  "> 1. a\n  > <b>\n\n<!-- c",
  "- - \t\t-->\n    \n\t\t\n\n>    <div>",
];

// mulberry32: integer math only, so it does not fall into a short cycle the
// way a float LCG multiplying past 2^53 does.
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FUZZ_LINES = [
  "", "", "", "", "", "", "text line", "text line", "text line", "More prose.", "- item", "1. item", "2. two", "10. ten", "-", "* star", "+ plus",
  "   ```", " ```", "```", "```js", "~~~", "````", "  code", "    deep", "      deeper", "\tTab", "    ", "    ```", "     ~~~", "        ```", "      ~~~~",
  "> quote", ">", "> -", "> 2. two", ">q", "    <b>", "\t<pre>", "      <!--", "- <?php", "> 1. a", "  > <b>", "- <script>", "| a | b |", "|---|---|", "---", "===", "# heading", "- [ ] task",
  "[link](https://x.dev) text", "def f() -> list[int]:", "[a\\]b]",
];
// Lines after which nothing more is cut; kept rare so most documents still are.
const FUZZ_STOPPERS = ["<span>", "- ```", "> ```", "1. ~~~", "[ref]: /url"];

function fuzzDoc(random) {
  const lines = [];
  const count = 4 + Math.floor(random() * 30);
  for (let i = 0; i < count; i += 1) {
    const pool = random() < 0.02 ? FUZZ_STOPPERS : FUZZ_LINES;
    lines.push(pool[Math.floor(random() * pool.length)]);
  }
  return lines.join(random() < 0.1 ? "\r\n" : "\n");
}

async function loadMermaidCache() {
  const out = await esbuild.build({
    entryPoints: [path.join(CHAT, "mermaid-cache.ts")],
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
    logLevel: "silent",
    tsconfig: path.join(ROOT, "tsconfig.node.json"),
  });
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  PASS ${name}`);
}

async function main() {
  const L = await loadLinks();

  test("hrefs with a scheme stay external", () => {
    for (const href of [
      "https://example.com/a",
      "http://localhost:3000",
      "mailto:a@b.c",
      "javascript:alert(1)",
      "vscode://file/x",
      "file:///etc/passwd",
      "//cdn.example.com/x.js",
    ]) {
      assert.equal(L.classifyChatHref(href).kind, "external", href);
    }
  });

  test("scheme-less hrefs are workspace paths, with an optional line", () => {
    assert.deepEqual(L.classifyChatHref("src/index.ts"), { kind: "path", path: "src/index.ts" });
    assert.deepEqual(L.classifyChatHref("./src/a.ts:120"), { kind: "path", path: "./src/a.ts", line: 120 });
    assert.deepEqual(L.classifyChatHref("src/a.ts:12:4"), { kind: "path", path: "src/a.ts", line: 12 });
    assert.deepEqual(L.classifyChatHref("src/a.ts#L40"), { kind: "path", path: "src/a.ts", line: 40 });
    assert.deepEqual(L.classifyChatHref("src/a.ts#L40-L52"), { kind: "path", path: "src/a.ts", line: 40 });
    assert.deepEqual(L.classifyChatHref("docs/My%20Notes.md"), { kind: "path", path: "docs/My Notes.md" });
    assert.deepEqual(L.classifyChatHref("/abs/file.ts"), { kind: "path", path: "/abs/file.ts" });
    assert.deepEqual(L.classifyChatHref("C:\\repo\\a.ts"), { kind: "path", path: "C:\\repo\\a.ts" });
  });

  test("empty and anchor-only hrefs do nothing", () => {
    for (const href of [undefined, "", "   ", "#section", "?q=1"]) {
      assert.equal(L.classifyChatHref(href).kind, "none", String(href));
    }
  });

  test("paths resolve against the workspace in its own form", () => {
    assert.equal(L.resolveChatPath("/home/u/repo", "src/a.ts"), "/home/u/repo/src/a.ts");
    assert.equal(L.resolveChatPath("/home/u/repo/", "./src/a.ts"), "/home/u/repo/src/a.ts");
    assert.equal(L.resolveChatPath("/home/u/repo", "../other/b.ts"), "/home/u/other/b.ts");
    assert.equal(L.resolveChatPath("/home/u/repo", "/etc/hosts"), "/etc/hosts");
    assert.equal(L.resolveChatPath("C:\\work\\repo", "src/a.ts"), "C:\\work\\repo\\src\\a.ts");
    assert.equal(L.resolveChatPath("C:\\work\\repo", "D:\\x.ts"), "D:\\x.ts");
    assert.equal(L.resolveChatPath("ssh://host/srv/repo", "src/a.ts"), "ssh://host/srv/repo/src/a.ts");
  });

  test("code spans that read as files are references", () => {
    assert.deepEqual(L.codeSpanFileReference("src/main/run-store.ts:120"), {
      path: "src/main/run-store.ts",
      line: 120,
    });
    assert.deepEqual(L.codeSpanFileReference("package.json"), { path: "package.json" });
    assert.deepEqual(L.codeSpanFileReference("run-store.ts"), { path: "run-store.ts" });
    assert.deepEqual(L.codeSpanFileReference("docs/notes.weird"), { path: "docs/notes.weird" });
  });

  test("ordinary code spans are not references", () => {
    for (const text of [
      "window.spark.openExternal",
      "npm run typecheck",
      "1.2",
      "v1.2.3",
      "foo()",
      "a.b",
      "const x = 1",
      "",
    ]) {
      assert.equal(L.codeSpanFileReference(text), null, text);
    }
  });

  const markdown = read("src/renderer/src/components/chat/Markdown.tsx");
  test("Markdown routes links through the classifier and a null-default context", () => {
    assert.match(markdown, /export const MarkdownWorkspaceContext = React\.createContext<string \| null>\(null\);/);
    assert.match(markdown, /if \(target\.kind === "external"\) void window\.spark\.openExternal\(target\.url\);/);
    assert.match(markdown, /else if \(target\.kind === "path" && cwd\) openWorkspaceFile\(/);
    assert.match(markdown, /title=\{href\}/);
    assert.match(markdown, /new CustomEvent\("spark:open-file"/);
    // Existence is probed in the click handler only.
    const inline = markdown.match(/function InlineCode\([\s\S]*?\n\}\n/);
    assert.ok(inline, "InlineCode not found");
    const beforeOpen = inline[0].slice(0, inline[0].indexOf("const open = () =>"));
    assert.doesNotMatch(beforeOpen, /pathExists/);
    assert.match(inline[0], /const open = \(\) => \{[\s\S]*?window\.spark\.fs\s*\.pathExists\(/);
  });

  test("ChatConversation provides the workspace to its markdown", () => {
    const conversation = read("src/renderer/src/components/chat/ChatConversation.tsx");
    assert.match(conversation, /<MarkdownWorkspaceContext\.Provider value=\{cwd \|\| null\}>/);
    const panel = read("src/renderer/src/components/chat/ChatPanel.tsx");
    assert.match(panel, /<ChatConversation[\s\S]*?cwd=\{workspace\?\.cwd \?\? null\}/);
  });

  test("code blocks, highlighting and tables are styled for chat", () => {
    assert.match(markdown, /<div className="cora-md">/);
    assert.match(markdown, /pre: \(\{ children \}\) => <CodeBlock>\{children\}<\/CodeBlock>/);
    assert.match(markdown, /if \(language === "mermaid"\) return <pre style=\{CODE_BLOCK_STYLE\}>\{children\}<\/pre>;/);
    assert.match(markdown, /window\.spark\.clipboard\.writeText\(getText\(\)\)/);
    assert.match(markdown, /getText=\{\(\) => nodeText\(children\)/);
    assert.match(markdown, /th: \(\{ children, style \}\) => <th style=\{\{ \.\.\.TABLE_HEAD_STYLE/);
    assert.match(markdown, /td: \(\{ children, style \}\) => <td style=\{\{ \.\.\.TABLE_CELL_STYLE/);
    assert.match(markdown, /borderBottom: "1px solid var\(--rule-soft\)", padding: "6px 10px"/);
    const styles = read("src/renderer/src/styles.css");
    for (const token of ["hljs-keyword", "hljs-string", "hljs-comment", "hljs-number", "hljs-title"]) {
      assert.match(styles, new RegExp(`\\.cora-md \\.${token}`), token);
    }
    const hljsBlock = styles.slice(styles.indexOf(".cora-md .hljs {"), styles.indexOf(".cora-md-code {"));
    assert.doesNotMatch(hljsBlock, /#[0-9a-f]{3,8}\b/i, "chat token colours must use theme tokens");
    // The preview's palette is untouched.
    const preview = read("src/renderer/src/components/markdown-preview/markdown.css");
    assert.match(preview, /\.spark-markdown \.hljs-keyword/);
  });

  const H = await loadHighlightPipeline();
  test("one shared highlighter renders exactly what a fresh one does", () => {
    assert.equal(H.rehypeHighlightShared(), H.rehypeHighlightShared());
    const samples = [
      "Plain text with `code` and a [link](src/a.ts).",
      "```ts\nexport const a: number = 1; // note\n```",
      "```python\ndef f(x):\n    return x + 1\n```\n\n```bash\nnpm test && echo \"ok\"\n```",
      "```nosuchlanguage\nkeep me plain\n```",
      "```\nno language at all\n```",
      "```mermaid\ngraph TD; A-->B\n```",
      "| a | b |\n| - | - |\n| `x` | **y** |",
    ];
    // Twice through the shared one: compiled grammars must not change later output.
    for (let round = 0; round < 2; round += 1) {
      for (const text of samples) {
        assert.deepEqual(H.shared(text), H.fresh(text), text);
      }
    }
  });

  test("chat and preview markdown attach the shared highlighter", () => {
    assert.match(markdown, /const REHYPE_PLUGINS = \[rehypeHighlightShared\];/);
    assert.doesNotMatch(markdown, /from "rehype-highlight"/);
    const pipeline = read("src/renderer/src/components/markdown-preview/pipeline.ts");
    assert.match(pipeline, /\.\.\.afterSanitize, rehypeHighlightShared\]/);
    assert.doesNotMatch(pipeline, /from "rehype-highlight"/);
  });

  const B = await loadBlockRenderer();
  test("a streamed reply renders the same split into pieces as whole", () => {
    for (const sample of BLOCK_SAMPLES) {
      for (let end = 1; end <= sample.length; end += 1) {
        const text = sample.slice(0, end);
        assert.equal(B.pieces(text), B.whole(text), JSON.stringify(text));
      }
    }
    const random = seeded(20261025);
    for (let doc = 0; doc < 1500; doc += 1) {
      const text = fuzzDoc(random);
      assert.equal(B.pieces(text), B.whole(text), JSON.stringify(text));
    }
  });

  test("ordinary replies are cut at their blank lines", () => {
    assert.deepEqual(B.splitMarkdownBlocks("One.\n\nTwo.\n\n```ts\na\n\nb\n```\n\n- x\n- y\n\nEnd"), ["One.", "Two.", "```ts\na\n\nb\n```", "- x\n- y", "End"]);
    assert.deepEqual(B.splitMarkdownBlocks("- a\n\n- b\n\nc"), ["- a\n\n- b", "c"]);
    assert.deepEqual(B.splitMarkdownBlocks("x\n\n[d]: https://e.com\n\ny"), ["x\n\n[d]: https://e.com\n\ny"]);
    // A "]:" with no line opening a bracket before it (a type hint in code) still cuts.
    assert.deepEqual(B.splitMarkdownBlocks("```py\ndef f() -> list[int]:\n```\n\nDone."), ["```py\ndef f() -> list[int]:\n```", "Done."]);
    // Nor does a link on a line that opens a bracket: only "]:" right after its label holds a definition.
    assert.deepEqual(B.splitMarkdownBlocks("[Docs](https://x.dev)\n\n```py\ndef f() -> list[int]:\n```"), ["[Docs](https://x.dev)", "```py\ndef f() -> list[int]:\n```"]);
    assert.equal(B.splitMarkdownBlocks("x\n\n[a\\]b\nc]: /url").length, 1);
    // A list item's code fence indented 4 columns lets cutting go on once it closes.
    assert.deepEqual(B.splitMarkdownBlocks("1. Install:\n\n    ```bash\n    npm i\n\n    npm test\n    ```\n\n2. Run\n\nDone."), ["1. Install:\n\n    ```bash\n    npm i\n\n    npm test\n    ```\n\n2. Run", "Done."]);
    // A CR that ends the text is half of a CRLF still arriving, not a lone CR.
    assert.deepEqual(B.splitMarkdownBlocks("a\r\n\r\nb\r"), ["a\r", "b\r"]);
  });

  test("Markdown renders memoized pieces with the separator a whole render has", () => {
    assert.match(markdown, /const blocks = useMemo\(\(\) => \(streaming \? splitMarkdownBlocks\(text\) : \[text\]\), \[streaming, text\]\);/);
    // Only the live turn's prose streams; settled messages render whole.
    const conversation = read("src/renderer/src/components/chat/ChatConversation.tsx");
    assert.match(conversation, /<Markdown text=\{segment\.text\} streaming=\{live\} \/>/);
    assert.equal((conversation.match(/streaming=/g) ?? []).length, 1);
    assert.match(markdown, /\{index > 0 && "\\n"\}\s*<MarkdownBlock text=\{block\} \/>/);
    assert.match(markdown, /const MarkdownBlock = React\.memo\(function MarkdownBlock/);
  });

  const M = await loadMermaidCache();
  test("a remounted Mermaid diagram reuses its drawing", () => {
    assert.equal(M.cachedMermaidSvg("graph TD; A-->B", "cora-mermaid-r2"), "");
    M.rememberMermaidSvg("graph TD; A-->B", "cora-mermaid-r1", '<svg id="cora-mermaid-r1"><style>#cora-mermaid-r1 .node{}</style></svg>');
    assert.equal(M.cachedMermaidSvg("graph TD; A-->B", "cora-mermaid-r2"), '<svg id="cora-mermaid-r2"><style>#cora-mermaid-r2 .node{}</style></svg>');
    // Least recently used goes first; a read counts as use.
    for (let index = 0; index < M.MERMAID_CACHE_LIMIT; index += 1) {
      if (index === 1) M.cachedMermaidSvg("graph TD; A-->B", "x");
      M.rememberMermaidSvg(`graph ${index}`, "i", "<svg id=\"i\"/>");
    }
    assert.notEqual(M.cachedMermaidSvg("graph TD; A-->B", "x"), "");
    assert.equal(M.cachedMermaidSvg("graph 0", "x"), "");
    assert.match(markdown, /const \[svg, setSvg\] = useState<string>\(\(\) => cachedMermaidSvg\(source, id\)\);/);
    // Only a drawing still wanted is kept: a diagram streamed over many
    // flushes would otherwise push every other one out of the cache.
    assert.match(markdown, /if \(!cancelled\) \{\s*rememberMermaidSvg\(source, id, rendered\.svg\);\s*setSvg\(rendered\.svg\);/);
  });

  console.log(`\n${passed} passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
