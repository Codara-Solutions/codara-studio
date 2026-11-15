import { test, expect, type Page } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { rpcRaw } = require("../../cli/lib/rpc.cjs");

// A PDF and a Markdown file must show in the in-app browser however they are
// reached: a file:// or http link clicked in a page, a URL typed or passed by
// an agent, and a plain path typed or passed by an agent. A plain path used
// to load nothing: the address bar handed it to webview.loadURL, which
// rejects anything that is not a URL without a sound, an agent's navigate
// timed out after 15 s, and a new tab resolved it against Studio's own page,
// which under `npm run dev` is the Vite server, so the tab showed Studio.

const MARKDOWN = "# Markdown hello\n\nSome *text*.\n";

function minimalPdf(text: string): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
  ];
  const stream = `BT /F1 48 Tf 72 700 Td (${text}) Tj ET`;
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const LINKS =
  '<!doctype html><title>Links</title><body style="margin:0">' +
  '<a id="pdf" href="doc.pdf" style="display:block;width:200px;height:40px">pdf</a>' +
  '<a id="md" href="notes.md" style="display:block;width:200px;height:40px">md</a>' +
  "</body>";

interface GuestPage {
  url: string;
  contentType: string;
  text: string;
  /** The built-in PDF viewer's frame is in the page. */
  pdfViewer: boolean;
}

// The page the test's one browser tab shows, read from main.
async function guestPage(app: ElectronApplication): Promise<GuestPage | null> {
  return app.evaluate(async ({ webContents }) => {
    const guests = webContents.getAllWebContents().filter((contents) => contents.getType() === "webview" && !contents.isDestroyed());
    const guest = guests.length === 1 ? guests[0] : null;
    if (!guest || guest.isLoading()) return null;
    try {
      const [contentType, text] = (await guest.executeJavaScript(
        "[document.contentType, document.body ? document.body.innerText : '']",
      )) as [string, string];
      const pdfViewer = guest.mainFrame.framesInSubtree.some((frame) => frame.url.startsWith("chrome-extension://"));
      return { url: guest.getURL(), contentType, text, pdfViewer };
    } catch {
      return null;
    }
  });
}

test("a PDF and a Markdown file show in the browser by link, URL and path", async () => {
  test.setTimeout(180_000);
  const root = await mkdtemp(join(tmpdir(), "codara-browser-file-links-"));
  const home = join(root, "home");
  const cwd = join(root, "workspace");
  const spaced = join(cwd, "Shared Docs");
  await mkdir(home);
  await mkdir(spaced, { recursive: true });
  const pdf = minimalPdf("PDF HELLO");
  await writeFile(join(cwd, "doc.pdf"), pdf);
  await writeFile(join(cwd, "notes.md"), MARKDOWN);
  await writeFile(join(cwd, "index.html"), LINKS);
  await writeFile(join(spaced, "my report.pdf"), pdf);
  await writeFile(join(spaced, "notes v2.md"), MARKDOWN);
  await writeFile(
    join(home, "spark-state.json"),
    JSON.stringify({
      activeWorkspaceId: "ws-a",
      workspaces: [{ id: "ws-a", name: "File links", cwd, color: "#42D6C7", workers: [] }],
    }),
  );
  const server: Server = createServer((req, res) => {
    if (req.url === "/doc.pdf") {
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end(pdf);
    } else if (req.url === "/notes.md") {
      res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
      res.end(MARKDOWN);
    } else {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(LINKS);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const app = await electron.launch({
    args: ["."],
    env: {
      ...process.env,
      CODARA_HOME_DIR: home,
      SPARK_HOME_DIR: home,
      SPARK_USER_DATA_DIR: home,
      SPARK_SKIP_LEGACY_MIGRATION: "1",
      SPARK_NO_SHELL_INTEGRATION: "1",
      SPARK_ALLOW_MULTI: "1",
      // "~/..." below expands to the test's own folder.
      HOME: root,
    },
  });
  const request = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await rpcRaw({ home }, method, params, { timeoutMs: 25_000 });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  const expectPdf = async (url: string) => {
    await expect
      .poll(async () => {
        const shown = await guestPage(app);
        return shown && { url: shown.url, contentType: shown.contentType, pdfViewer: shown.pdfViewer };
      }, { timeout: 15_000 })
      .toEqual({ url, contentType: "application/pdf", pdfViewer: true });
  };
  const expectMarkdown = async (url: string) => {
    await expect
      .poll(async () => {
        const shown = await guestPage(app);
        return shown && { url: shown.url, contentType: shown.contentType, heading: shown.text.includes("# Markdown hello") };
      }, { timeout: 15_000 })
      .toEqual({ url, contentType: "text/markdown", heading: true });
  };
  const fileUrl = (path: string) => pathToFileURL(path).href;
  try {
    const page: Page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator('[data-workspace-id="ws-a"]')).toBeVisible();

    // An agent's first navigate with a plain path opens a tab on the file.
    const { tabId } = (await request("preview.navigate", { url: join(spaced, "my report.pdf") })) as { tabId: string };
    await page.locator(`[data-tab-id="${tabId}"]`).first().click();
    await expectPdf(fileUrl(join(spaced, "my report.pdf")));
    // And in a tab it already has.
    await request("preview.navigate", { tabId, url: join(spaced, "notes v2.md") });
    await expectMarkdown(fileUrl(join(spaced, "notes v2.md")));
    await request("preview.navigate", { tabId, url: "~/workspace/doc.pdf" });
    await expectPdf(fileUrl(join(cwd, "doc.pdf")));

    // URLs passed by an agent, local and served.
    for (const [url, kind] of [
      [fileUrl(join(cwd, "doc.pdf")), "pdf"],
      [fileUrl(join(cwd, "notes.md")), "md"],
      [`${origin}/doc.pdf`, "pdf"],
      [`${origin}/notes.md`, "md"],
    ] as const) {
      await request("preview.navigate", { tabId, url });
      await (kind === "pdf" ? expectPdf(url) : expectMarkdown(url));
    }

    // Links clicked in a local page and in a served page.
    for (const start of [fileUrl(join(cwd, "index.html")), `${origin}/`]) {
      for (const link of ["pdf", "md"] as const) {
        await request("preview.navigate", { tabId, url: start });
        await request("preview.wait_for", { tabId, selector: `#${link}` });
        await request("preview.mouse", { tabId, selector: `#${link}`, action: "click" });
        const target = new URL(link === "pdf" ? "doc.pdf" : "notes.md", start).href;
        await (link === "pdf" ? expectPdf(target) : expectMarkdown(target));
      }
    }

    // Typed in the address bar: a path, then a URL.
    const address = page.locator(`[data-tab-content="${tabId}"]`).getByPlaceholder("http://localhost:3000");
    const typed: Array<[string, string, "pdf" | "md"]> = [
      [join(spaced, "my report.pdf"), fileUrl(join(spaced, "my report.pdf")), "pdf"],
      [join(cwd, "notes.md"), fileUrl(join(cwd, "notes.md")), "md"],
      ["~/workspace/doc.pdf", fileUrl(join(cwd, "doc.pdf")), "pdf"],
      ["~/workspace/Shared Docs/notes v2.md", fileUrl(join(spaced, "notes v2.md")), "md"],
      [fileUrl(join(cwd, "doc.pdf")), fileUrl(join(cwd, "doc.pdf")), "pdf"],
      [`${origin}/notes.md`, `${origin}/notes.md`, "md"],
    ];
    for (const [input, url, kind] of typed) {
      await address.fill(input);
      await address.press("Enter");
      await (kind === "pdf" ? expectPdf(url) : expectMarkdown(url));
    }
    await page.screenshot({ path: test.info().outputPath("typed-markdown.png") });
    await address.fill(join(spaced, "my report.pdf"));
    await address.press("Enter");
    await expectPdf(fileUrl(join(spaced, "my report.pdf")));
    await page.screenshot({ path: test.info().outputPath("typed-pdf-path.png") });

    // Something the browser cannot load says so instead of loading nothing.
    await address.fill("99999");
    await address.press("Enter");
    await expect(page.locator(`[data-tab-content="${tabId}"]`).getByText(/a file path, or a port/)).toBeVisible();
  } finally {
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
