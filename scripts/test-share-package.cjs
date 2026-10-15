// Harness for the Share packager (src/renderer/src/components/share/): how a
// page on disk becomes the one self-contained document a share link serves.
// Local pictures, fonts, styles and scripts are embedded; files outside the
// page's folder and workspace, hidden files and files of the wrong type are
// left out and reported; frames, local links and redirects are removed; a
// Markdown file renders through the preview's own sanitizing pipeline.
//
//   node scripts/test-share-package.cjs
//
// Runs in Node against a throwaway folder; the packager's file reader is a
// plain fs reader standing in for the app's sandboxed one.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const SHARE = path.join(ROOT, "src", "renderer", "src", "components", "share");

async function load() {
  const cacheDir = path.join(ROOT, "node_modules", ".cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const outfile = path.join(cacheDir, "share-package.cjs");
  await esbuild.build({
    stdin: {
      contents: [
        `export * from ${JSON.stringify(path.join(SHARE, "package.ts"))};`,
        `export { packageHtmlPage, bytesToBase64 } from ${JSON.stringify(path.join(SHARE, "inline.ts"))};`,
        `export { renderMarkdownDocument } from ${JSON.stringify(path.join(SHARE, "markdown.tsx"))};`,
        `export * as paths from ${JSON.stringify(path.join(SHARE, "paths.ts"))};`,
        `export * as offers from ${JSON.stringify(path.join(SHARE, "offer-store.ts"))};`,
        `export { shareErrorText } from ${JSON.stringify(path.join(SHARE, "errors.ts"))};`,
      ].join("\n"),
      resolveDir: SHARE,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    logLevel: "silent",
    jsx: "automatic",
    alias: { "@shared": path.join(ROOT, "src", "shared") },
    // The app loads Mermaid in the browser; tests pass their own renderer.
    external: ["mermaid"],
  });
  delete require.cache[outfile];
  return require(outfile);
}

let failures = 0;
let passes = 0;
async function check(name, fn) {
  try {
    await fn();
    passes += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`not ok - ${name}`);
    console.error(error && error.stack ? error.stack : error);
  }
}

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b20000000049454e44ae426082",
  "hex",
);

const fsReader = {
  size: async (p) => {
    const st = fs.statSync(p);
    if (!st.isFile()) throw new Error("not a file");
    return st.size;
  },
  read: async (p) => new Uint8Array(fs.readFileSync(p)),
};

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

async function main() {
  const mod = await load();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codara-share-package-"));
  const workspace = path.join(tmp, "project");
  const reportDir = path.join(workspace, "reports");
  const reportPath = path.join(reportDir, "report.html");
  write(path.join(reportDir, "chart.png"), PNG);
  write(path.join(reportDir, "img", "small.png"), PNG);
  write(path.join(reportDir, "img", "large.png"), PNG);
  write(path.join(workspace, "assets", "logo.png"), PNG);
  write(path.join(reportDir, ".secret.png"), PNG);
  write(path.join(reportDir, "notes.txt"), "not a picture");
  write(path.join(tmp, "outside.png"), PNG);
  write(path.join(reportDir, "font.woff2"), Buffer.from("wOF2fake"));
  write(path.join(reportDir, "base.css"), "body { color: red; }\n");
  write(path.join(reportDir, "styles", "main.css"), '@import "../base.css";\n.hero { background: url("../chart.png"); }\n@font-face { src: url(../font.woff2); }\n.ext { background: url(https://cdn.test/x.png); }\n');
  write(path.join(reportDir, "app.js"), 'document.title = "</script><script>alert(1)</script>"; // <!-- x\n');

  try {
    await check("a page's local files are embedded and what cannot work is reported", async () => {
      const source = `<!doctype html><html><head>
<base href="https://elsewhere.test/">
<meta http-equiv="refresh" content="0;url=https://elsewhere.test">
<link rel="stylesheet" href="styles/main.css" integrity="sha384-x">
<link rel="icon" href="chart.png">
<link rel="preload" href="app.js" as="script">
<link rel="stylesheet" href="https://cdn.test/remote.css">
<script src="app.js" integrity="sha384-y" crossorigin="anonymous"></script>
<script src="https://cdn.test/lib.js"></script>
<style>.a { background-image: url('img/small.png'); }</style>
</head><body>
<img src="chart.png" srcset="img/small.png 1x, img/large.png 2x" alt="c">
<img src="./chart.png?v=2#frag">
<img src="../assets/logo.png">
<img src=".secret.png">
<img src="../../outside.png">
<img src="notes.txt">
<img src="missing.png">
<img src="https://cdn.test/remote.png">
<img src="data:image/png;base64,AAAA">
<div style="background: url(img/small.png)"></div>
<a href="other-report.html">next</a>
<a href="https://example.com/">site</a>
<a href="#top">top</a>
<iframe src="embed.html"></iframe>
<iframe src="https://video.test/embed"></iframe>
<object data="thing.pdf"></object>
<svg><image href="chart.png"/></svg>
</body></html>`;
      const page = await mod.packageHtmlPage(source, {
        sourcePath: reportPath,
        allowedRoots: mod.allowedRootsFor(reportPath, [workspace]),
        reader: fsReader,
      });
      const html = page.html;
      const pngUri = `data:image/png;base64,${PNG.toString("base64")}`;
      assert.ok(html.includes(`<img src="${pngUri}" srcset="${pngUri} 1x, ${pngUri} 2x" alt="c">`), "img and srcset embedded");
      assert.equal(html.split(pngUri).length - 1 >= 8, true, "every use of a local picture is embedded");
      assert.ok(!html.includes('src="chart.png'), "no local picture reference is left");
      assert.ok(html.includes("background: url(\"" + pngUri + "\")"), "inline style urls are embedded");
      assert.ok(html.includes("body { color: red; }"), "@import is inlined");
      assert.ok(html.includes("data:font/woff2;base64,"), "fonts are embedded");
      assert.ok(html.includes("url(https://cdn.test/x.png)"), "remote urls stay as they are");
      assert.ok(!/<link[^>]+main\.css/.test(html), "the local stylesheet link became a style element");
      assert.ok(!html.includes("integrity"), "integrity attributes of inlined files are dropped");
      assert.ok(html.includes('document.title = "<\\/script><script>alert(1)<\\/script>"'), "inlined scripts cannot close their element");
      assert.ok(html.includes("<\\!-- x"), "inlined scripts cannot open a comment state");
      assert.ok(!html.includes('src="app.js"'));
      assert.ok(!html.includes("<base"), "base is removed");
      assert.ok(!/http-equiv="refresh"/.test(html), "meta refresh is removed");
      assert.ok(!html.includes('rel="preload"'), "local preload links are removed");
      assert.ok(html.includes(">next</a>") && !html.includes("other-report.html"), "local links lose their target, keep their text");
      assert.ok(html.includes('href="https://example.com/"') && html.includes('href="#top"'));
      assert.ok(!html.includes("<iframe") && !html.includes("<object"), "frames and embeds are removed");
      assert.ok(html.includes('src="https://cdn.test/remote.png"'));
      assert.ok(html.includes('src="data:image/png;base64,AAAA"'), "existing data URIs stay");
      assert.ok(html.includes('src=".secret.png"'), "a left out file keeps its reference");
      assert.deepEqual(
        page.leftOut.map((entry) => `${entry.ref}:${entry.reason}`).sort(),
        ["../../outside.png:outside", ".secret.png:hidden", "missing.png:missing", "notes.txt:type"],
      );
      assert.equal(page.remote, 5, "remote stylesheet, script, picture, css url and frame are counted");
      assert.equal(page.removed, 7, "base, refresh, preload, local link, two frames and the object");
      assert.deepEqual(
        page.included.sort(),
        ["../assets/logo.png", "app.js", "base.css", "chart.png", "font.woff2", "img/large.png", "img/small.png", "styles/main.css"],
      );
      assert.equal(page.bytes, Buffer.byteLength(html, "utf8"));
    });

    await check("embedding stops at the page cap and says which files were left out", async () => {
      const source = `<img src="chart.png"><img src="img/small.png"><img src="img/large.png">`;
      const page = await mod.packageHtmlPage(source, {
        sourcePath: reportPath,
        allowedRoots: [reportDir],
        reader: fsReader,
        maxBytes: source.length + 200,
      });
      assert.equal(page.included.length, 1);
      assert.deepEqual(page.leftOut.map((entry) => entry.reason), ["too_large", "too_large"]);
    });

    await check("a page outside every workspace embeds only from its own folder", () => {
      assert.deepEqual(mod.allowedRootsFor("/home/u/Downloads/page.html", ["/home/u/project"]), ["/home/u/Downloads"]);
      assert.deepEqual(
        mod.allowedRootsFor("/home/u/project/sub/docs/a.md", ["/home/u", "/home/u/project", "/home/u/project-x"]),
        ["/home/u/project/sub/docs", "/home/u/project"],
        "the deepest workspace holding the page",
      );
      assert.deepEqual(mod.allowedRootsFor("ssh://host/x/a.md", ["/home/u"]), [], "remote files embed nothing");
    });

    await check("path helpers agree on POSIX and Windows paths", () => {
      const { paths } = mod;
      assert.equal(paths.resolveFrom("/a/b", "../c/./d.png"), "/a/c/d.png");
      assert.equal(paths.resolveFrom("/a", "../../../x"), "/x");
      assert.equal(paths.resolveFrom("C:\\Users\\me\\proj", "img\\a.png"), "C:/Users/me/proj/img/a.png");
      assert.equal(paths.dirnameOf("C:\\x.md"), "C:/");
      assert.ok(paths.isInsideDir("C:/Users/Me", "c:/users/me/file.png"), "Windows paths compare without case");
      assert.ok(!paths.isInsideDir("/a/b", "/a/bc/file"), "a sibling with a longer name is outside");
      assert.equal(paths.relativeTo("/a/b", "/a/b/c/d.png"), "c/d.png");
      assert.equal(paths.relativePath("/a/b/c", "/a/x/y.png"), "../../x/y.png");
      assert.equal(paths.relativePath("C:/p/q", "D:/r.png"), "D:/r.png", "another drive shows in full");
    });

    await check("a Markdown file renders through the preview's sanitizer, with code and diagrams", async () => {
      const mdPath = path.join(reportDir, "notes.md");
      const text = [
        "# Results <b>bold</b>",
        "",
        "| a | b |",
        "|---|---|",
        "| 1 | 2 |",
        "",
        "```js",
        "const x = 1;",
        "```",
        "",
        "```mermaid",
        "graph TD; A-->B",
        "```",
        "",
        "```mermaid",
        "broken",
        "```",
        "",
        "<script>alert(1)</script>",
        '<img src="chart.png" onerror="alert(2)">',
        "",
        "![chart](./chart.png)",
        "",
        "[local](other.md) [remote](https://example.com)",
      ].join("\n");
      const seen = [];
      const renderMermaid = async (code) => {
        seen.push(code);
        if (code === "broken") throw new Error("parse error");
        return '<svg id="d1"><text>A to B</text></svg>';
      };
      const packaged = await mod.packageForShare(
        { path: mdPath, text, workspaceRoots: [workspace] },
        { reader: fsReader, renderMermaid },
      );
      const html = packaged.html;
      assert.equal(packaged.title, "notes.md");
      assert.ok(html.startsWith("<!DOCTYPE html>") || html.startsWith("<!doctype html>"));
      assert.ok(html.includes('<meta charset="utf-8">'));
      assert.ok(html.includes("<title>notes.md</title>"));
      assert.ok(html.includes("<table>") && html.includes("<td>2</td>"), "GFM tables render");
      assert.ok(/class="hljs language-js"/.test(html) && html.includes("hljs-keyword"), "code is highlighted");
      assert.deepEqual(seen, ["graph TD; A-->B", "broken"]);
      assert.ok(html.includes('<div class="diagram"><svg id="d1">'), "diagrams become inline SVG");
      assert.ok(html.includes('<code class="language-mermaid">broken</code>'), "a diagram that fails shows its source");
      assert.ok(!html.includes("<pre><div"), "a diagram is not left inside a pre");
      assert.ok(!html.includes("alert(1)") && !html.includes("onerror"), "raw scripts and handlers are scrubbed");
      assert.ok(html.includes("<b>bold</b>"), "safe raw HTML stays");
      assert.ok(html.includes(`src="data:image/png;base64,${PNG.toString("base64")}"`), "local pictures are embedded");
      assert.ok(!html.includes("other.md") && html.includes('href="https://example.com"'));
      assert.ok(packaged.included.includes("chart.png"));
      assert.ok(!html.includes("data-share-diagram"), "no placeholder survives");
    });

    await check("Markdown cannot forge a diagram placeholder", async () => {
      const text = '<span data-share-diagram="x-0"></span>\n\n```mermaid\nA\n```';
      const html = await mod.renderMarkdownDocument(text, 'a "b" <c>', async () => "<svg>ok</svg>");
      assert.equal(html.split("<svg>ok</svg>").length - 1, 1);
      assert.ok(html.includes("<title>a &quot;b&quot; &lt;c&gt;</title>"), "the title is escaped");
    });

    await check("only HTML and Markdown files can be packaged", async () => {
      await assert.rejects(
        mod.packageForShare({ path: "/x/a.txt", text: "x", workspaceRoots: [] }, { reader: fsReader }),
        /Only HTML and Markdown/,
      );
    });

    await check("an agent's offer waits for its prompt to close, and only while it is fresh", () => {
      const original = Date.now;
      globalThis.window = new EventTarget();
      const events = [];
      window.addEventListener(mod.offers.SHARE_OFFER_EVENT, (event) => events.push(event.detail.path));
      try {
        mod.offers.requestShareOffer("/p/a.md");
        assert.deepEqual(events, ["/p/a.md"]);
        assert.equal(mod.offers.pendingShareOffer("/p/a.md"), true);
        assert.equal(mod.offers.pendingShareOffer("/p/a.md"), true, "a toolbar that remounts still sees the offer");
        assert.equal(mod.offers.pendingShareOffer("/p/other.md"), false);
        mod.offers.clearShareOffer("/p/a.md");
        assert.equal(mod.offers.pendingShareOffer("/p/a.md"), false, "closing the prompt ends the offer");
        mod.offers.requestShareOffer("/p/b.md");
        const at = Date.now();
        Date.now = () => at + 61_000;
        assert.equal(mod.offers.pendingShareOffer("/p/b.md"), false, "a stale offer does not pop up later");
      } finally {
        Date.now = original;
        delete globalThis.window;
      }
      mod.offers.setShareWorkspaceRoots(["/w", "", "/v"]);
      assert.deepEqual([...mod.offers.shareWorkspaceRoots()], ["/w", "/v"]);
    });

    await check("main-process errors reach the user without Electron's prefix", () => {
      assert.equal(
        mod.shareErrorText(new Error("Error invoking remote method 'share:create': Error: This page is larger than 5 MB.")),
        "This page is larger than 5 MB.",
      );
      assert.equal(mod.shareErrorText(new Error("plain")), "plain");
      assert.equal(mod.shareErrorText(null), "Something went wrong. Try again.");
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
