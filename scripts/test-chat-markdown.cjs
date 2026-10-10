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
//     blocks offer Copy (skipping Mermaid), and table cells have borders.

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
    assert.match(markdown, /border: "1px solid var\(--rule-soft\)", padding: "4px 8px"/);
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

  console.log(`\n${passed} passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
