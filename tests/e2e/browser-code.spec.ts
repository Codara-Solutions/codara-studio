import { test, expect } from "@playwright/test";
import { _electron as electron } from "playwright";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// codara_browser_use in the built app, through the stdio MCP server as any
// agent runs it, on four realistic flows served locally: sign in to an app,
// fill and submit a form, read a long table, compose a webmail draft. Each
// flow also runs with the single tools and with codara_preview_run, the way
// an agent would (look at the page first, then act, then check), and the
// spec writes calls, characters and wall time for all three to
// test-results/browser-code-bench.{json,md}. The code-mode screenshots land
// next to them.

const { rpcRaw } = require("../../cli/lib/rpc.cjs");

const SERVER = resolve(__dirname, "../../resources/codara-studio-mcp/server.js");
const OUT = resolve(__dirname, "../../test-results");

const LOGIN = `<!doctype html><title>Acme sign in</title>
  <style>body { font: 15px system-ui; margin: 40px } form { display: grid; gap: 10px; max-width: 320px }</style>
  <main id="app">
    <h1>Sign in to Acme</h1>
    <form id="login">
      <label>Email <input name="email" type="email" required></label>
      <label>Password <input name="password" type="password" required></label>
      <label><input name="remember" type="checkbox"> Keep me signed in</label>
      <button type="submit">Sign in</button>
      <a href="#forgot">Forgot password?</a>
    </form>
  </main>
  <script>
    document.getElementById("login").addEventListener("submit", (event) => {
      event.preventDefault();
      const form = event.target;
      if (form.password.value !== "correct horse") {
        form.insertAdjacentHTML("beforeend", '<p role="alert">Wrong email or password.</p>');
        return;
      }
      setTimeout(() => {
        document.body.dataset.signedIn = form.email.value;
        document.getElementById("app").innerHTML = '<h1>Welcome back, Ana</h1><nav><a href="#projects">Projects</a> <a href="#billing">Billing</a></nav><p>3 projects, 1 invoice due.</p>';
      }, 200);
    });
  </script>`;

const FORM = `<!doctype html><title>New customer</title>
  <style>body { font: 15px system-ui; margin: 40px } form { display: grid; gap: 10px; max-width: 420px } .error { color: #b00 }</style>
  <h1>New customer</h1>
  <form id="customer" novalidate>
    <label>Full name <input name="name"></label>
    <label>Work email <input name="email" type="email"></label>
    <label>Company <input name="company"></label>
    <label>Country <select name="country"><option value="">Choose...</option><option value="es">Spain</option><option value="fr">France</option><option value="de">Germany</option></select></label>
    <fieldset><legend>Plan</legend>
      <label><input type="radio" name="plan" value="starter"> Starter</label>
      <label><input type="radio" name="plan" value="team"> Team</label>
      <label><input type="radio" name="plan" value="enterprise"> Enterprise</label>
    </fieldset>
    <label>Notes <textarea name="notes"></textarea></label>
    <label><input type="checkbox" name="terms"> I accept the terms</label>
    <button type="submit">Save customer</button>
  </form>
  <div id="toast" role="status"></div>
  <script>
    document.getElementById("customer").addEventListener("submit", (event) => {
      event.preventDefault();
      const f = event.target;
      document.querySelectorAll(".error").forEach((node) => node.remove());
      const missing = ["name", "email", "company", "country"].filter((key) => !f[key].value);
      if (!f.terms.checked) missing.push("terms");
      if (missing.length) {
        f.insertAdjacentHTML("afterbegin", '<p class="error" role="alert">Missing: ' + missing.join(", ") + '</p>');
        return;
      }
      setTimeout(() => {
        document.body.dataset.saved = JSON.stringify({ name: f.name.value, email: f.email.value, company: f.company.value, country: f.country.value, plan: f.plan.value, notes: f.notes.value });
        document.getElementById("toast").textContent = "Customer saved: #1042";
      }, 150);
    });
  </script>`;

const STATUSES = ["paid", "overdue", "draft", "paid", "sent"];
const CUSTOMERS = ["Northwind", "Contoso", "Fabrikam", "Initech", "Globex", "Umbrella", "Hooli"];
const INVOICES = Array.from({ length: 240 }, (_, i) => ({
  id: `INV-${2000 + i}`,
  customer: CUSTOMERS[(i * 3) % CUSTOMERS.length],
  amount: ((i * 37) % 900) + 100,
  status: STATUSES[(i * 7) % STATUSES.length],
}));
const OVERDUE_TOTAL = INVOICES.filter((row) => row.status === "overdue").reduce((sum, row) => sum + row.amount, 0);
const OVERDUE_COUNT = INVOICES.filter((row) => row.status === "overdue").length;
const TABLE = `<!doctype html><title>Invoices</title>
  <style>body { font: 14px system-ui; margin: 24px } td, th { padding: 2px 10px; text-align: left }</style>
  <h1>Invoices</h1>
  <table><thead><tr><th>Invoice</th><th>Customer</th><th>Amount</th><th>Status</th></tr></thead><tbody>
  ${INVOICES.map((row) => `<tr><td>${row.id}</td><td>${row.customer}</td><td>€${row.amount}</td><td>${row.status}</td></tr>`).join("")}
  </tbody></table>`;

const MAIL = `<!doctype html><title>Inbox - Acme Mail</title>
  <style>body { font: 14px system-ui; margin: 0; display: grid; grid-template-columns: 180px 1fr } nav, main { padding: 16px }
    dialog { width: 520px } dialog form { display: grid; gap: 8px } [contenteditable] { min-height: 80px; border: 1px solid #999; padding: 6px }</style>
  <nav><button id="compose">New message</button><ul><li><a href="#inbox">Inbox (12)</a></li><li><a href="#drafts">Drafts (<span id="draft-count">0</span>)</a></li><li><a href="#sent">Sent</a></li></ul></nav>
  <main><h1>Inbox</h1><ul id="messages">${Array.from({ length: 12 }, (_, i) => `<li><a href="#m${i}">Message ${i + 1} from ${CUSTOMERS[i % CUSTOMERS.length]}</a></li>`).join("")}</ul><h2>Drafts</h2><ul id="drafts"></ul></main>
  <dialog id="composer" aria-label="New message"><form method="dialog">
    <label>To <input name="to" type="email"></label>
    <label>Subject <input name="subject"></label>
    <div role="textbox" aria-label="Message body" contenteditable="true" id="body"></div>
    <div><button value="draft" id="save-draft">Save draft</button> <button value="cancel">Discard</button></div>
  </form></dialog>
  <script>
    const dialog = document.getElementById("composer");
    document.getElementById("compose").onclick = () => dialog.showModal();
    dialog.addEventListener("close", () => {
      if (dialog.returnValue !== "draft") return;
      const f = dialog.querySelector("form");
      const draft = { to: f.to.value, subject: f.subject.value, body: document.getElementById("body").innerText };
      const item = document.createElement("li");
      item.textContent = draft.subject + " (to " + draft.to + ")";
      document.getElementById("drafts").append(item);
      document.getElementById("draft-count").textContent = String(document.querySelectorAll("#drafts li").length);
      document.body.dataset.draft = JSON.stringify(draft);
    });
  </script>`;

function startFixture(): Promise<{ server: Server; url: (path: string) => string }> {
  const pages: Record<string, string> = { "/login": LOGIN, "/form": FORM, "/table": TABLE, "/mail": MAIL };
  const server = createServer((req, res) => {
    const page = pages[new URL(req.url ?? "/", "http://127.0.0.1").pathname];
    // The preview follows the app's dark theme; the screenshots are the demo, so keep them readable.
    if (page) res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<style>:root { color-scheme: light; background: #fff; color: #111 }</style>${page}`);
    else res.writeHead(404).end();
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => {
    const { port } = server.address() as { port: number };
    done({ server, url: (path) => `http://127.0.0.1:${port}${path}` });
  }));
}

function cleanEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || /^(SPARK|CODARA)_/.test(key)) continue;
    env[key] = value;
  }
  return { ...env, CODARA_HOME_DIR: home, SPARK_HOME_DIR: home, SPARK_USER_DATA_DIR: home };
}

interface Content { type: string; text?: string; data?: string; mimeType?: string }
interface Tally { calls: number; argChars: number; resultChars: number; images: number; ms: number }

/** A stdio MCP client that counts what the model would send and read. */
function startMcp(home: string) {
  const child = spawn(process.execPath, [SERVER], { env: cleanEnv(home), stdio: ["pipe", "pipe", "inherit"] });
  let buffer = "";
  let nextId = 1;
  const pending = new Map<number, (message: { result?: any; error?: any }) => void>();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  const request = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((done, fail) => {
      const id = nextId++;
      pending.set(id, (message) => (message.error ? fail(new Error(message.error.message)) : done(message.result)));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  let tally: Tally = { calls: 0, argChars: 0, resultChars: 0, images: 0, ms: 0 };
  return {
    request,
    /** Calls a tool and returns its text and images, counting both. */
    async call(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; images: Content[]; isError: boolean }> {
      const started = Date.now();
      const result = await request("tools/call", { name, arguments: args });
      const content = result.content as Content[];
      const text = content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
      const images = content.filter((part) => part.type === "image");
      tally.calls += 1;
      tally.argChars += JSON.stringify({ name, arguments: args }).length;
      tally.resultChars += text.length;
      tally.images += images.length;
      tally.ms += Date.now() - started;
      return { text, images, isError: result.isError === true };
    },
    take(): Tally {
      const taken = tally;
      tally = { calls: 0, argChars: 0, resultChars: 0, images: 0, ms: 0 };
      return taken;
    },
    close: () => child.kill(),
  };
}

const json = (text: string) => JSON.parse(text);

test("codara_browser_use drives four real flows in fewer calls than the single tools", async () => {
  test.setTimeout(300_000);
  const root = await mkdtemp(join(tmpdir(), "codara-browser-code-"));
  const home = join(root, "home");
  const workspaceDir = join(root, "workspace");
  await mkdir(home);
  await mkdir(workspaceDir);
  await mkdir(OUT, { recursive: true });
  await writeFile(join(home, "spark-state.json"), JSON.stringify({
    activeWorkspaceId: "ws-code",
    workspaces: [{ id: "ws-code", name: "Code mode test", cwd: workspaceDir, color: "#42D6C7", workers: [] }],
  }));
  const fixture = await startFixture();
  const app = await electron.launch({ args: ["."], env: {
    ...cleanEnv(home),
    SPARK_SKIP_LEGACY_MIGRATION: "1", SPARK_NO_SHELL_INTEGRATION: "1", SPARK_ALLOW_MULTI: "1",
  } });
  const socket = async (method: string, params: Record<string, unknown> = {}) => {
    const response = await rpcRaw({ home }, method, params, { timeoutMs: 20_000 });
    if (response.error) throw new Error(response.error.message);
    return response.result;
  };
  const pageValue = async (code: string) => (await socket("preview.evaluate", { code })).value;
  let mcp: ReturnType<typeof startMcp> | null = null;
  const bench: Record<string, Record<string, Tally>> = {};
  const record = (flow: string, way: string) => {
    (bench[flow] ??= {})[way] = mcp!.take();
  };
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByText("Code mode test", { exact: true }).first()).toBeVisible();
    await expect.poll(async () => socket("app.info").then(() => true).catch(() => false)).toBe(true);
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.hide(); });

    mcp = startMcp(home);
    await mcp.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "any-agent", version: "1" } });
    const { tools } = await mcp.request("tools/list");
    const codeTool = tools.find((tool: { name: string }) => tool.name === "codara_browser_use");
    expect(codeTool.description).toContain("browser.documentation()");
    for (const hidden of ["codara_preview_locate", "codara_preview_cdp", "codara_preview_cdp_events"]) {
      expect(tools.some((tool: { name: string }) => tool.name === hidden)).toBe(false);
    }

    // The sandbox, end to end: no Node, and a syntax error is an error result.
    const sandbox = await mcp.call("codara_browser_use", { code: "[typeof require, typeof process, typeof fetch].join(',')" });
    expect(sandbox.text).toBe("undefined,undefined,undefined");
    const broken = await mcp.call("codara_browser_use", { code: "const = 1" });
    expect(broken.isError).toBe(true);
    expect(broken.text).toMatch(/^Error: SyntaxError/);
    mcp.take();

    // ---- Flow 1: sign in to a local app ----------------------------------
    await mcp.call("codara_preview_navigate", { url: fixture.url("/login") });
    await mcp.call("codara_preview_snapshot");
    await mcp.call("codara_preview_type", { selector: "input[name=email]", text: "ana@acme.test" });
    await mcp.call("codara_preview_type", { selector: "input[name=password]", text: "correct horse" });
    await mcp.call("codara_preview_click", { selector: "input[name=remember]" });
    await mcp.call("codara_preview_click", { selector: "button[type=submit]" });
    await mcp.call("codara_preview_wait_for", { text: "Welcome back" });
    await mcp.call("codara_preview_snapshot");
    record("Sign in to a local app", "single tools");
    expect(await pageValue("document.body.dataset.signedIn")).toBe("ana@acme.test");

    await mcp.call("codara_preview_navigate", { url: fixture.url("/login") });
    await mcp.call("codara_preview_snapshot");
    const loginRun = await mcp.call("codara_preview_run", { steps: [
      { action: "type", selector: "input[name=email]", text: "ana@acme.test" },
      { action: "type", selector: "input[name=password]", text: "correct horse" },
      { action: "click", selector: "input[name=remember]" },
      { action: "click", selector: "button[type=submit]" },
      { action: "wait_for", text: "Welcome back" },
      { action: "snapshot" },
    ] });
    expect(json(loginRun.text).ok).toBe(true);
    record("Sign in to a local app", "codara_preview_run");

    // The first code call also reads the documentation, once per session.
    const first = await mcp.call("codara_browser_use", { code: `const docs = browser.documentation();
const tab = browser.tab();
await tab.goto(${JSON.stringify(fixture.url("/login"))});
docs + "\\n\\n" + await tab.snapshot()` });
    expect(first.text).toContain("# Codara browser API");
    expect(first.text).toMatch(/textbox @\S+ "Email"/);
    const login = await mcp.call("codara_browser_use", { code: `await tab.getByLabel("Email").fill("ana@acme.test");
await tab.getByLabel("Password").fill("correct horse");
await tab.getByLabel("Keep me signed in").check();
await tab.getByRole("button", { name: "Sign in" }).click();
await tab.waitFor({ text: "Welcome back" });
await tab.screenshot();
await tab.snapshot()` });
    expect(login.isError, login.text).toBe(false);
    expect(login.text).toContain("Welcome back, Ana");
    expect(login.images).toHaveLength(1);
    await writeFile(join(OUT, "browser-code-login.jpg"), Buffer.from(login.images[0].data!, "base64"));
    record("Sign in to a local app", "codara_browser_use");
    expect(await pageValue("document.body.dataset.signedIn")).toBe("ana@acme.test");

    // ---- Flow 2: fill and submit a form, recovering from a validation error
    const expected = { name: "Ana Torres", email: "ana@northwind.test", company: "Northwind", country: "es", plan: "team", notes: "Wants a demo in May." };
    await mcp.call("codara_preview_navigate", { url: fixture.url("/form") });
    await mcp.call("codara_preview_snapshot");
    await mcp.call("codara_preview_type", { selector: "input[name=name]", text: expected.name });
    await mcp.call("codara_preview_type", { selector: "input[name=email]", text: expected.email });
    await mcp.call("codara_preview_type", { selector: "input[name=company]", text: expected.company });
    await mcp.call("codara_preview_type", { selector: "select[name=country]", text: "es" });
    await mcp.call("codara_preview_click", { selector: "input[value=team]" });
    await mcp.call("codara_preview_type", { selector: "textarea[name=notes]", text: expected.notes });
    await mcp.call("codara_preview_click", { selector: "button[type=submit]" });
    await mcp.call("codara_preview_snapshot");
    await mcp.call("codara_preview_click", { selector: "input[name=terms]" });
    await mcp.call("codara_preview_click", { selector: "button[type=submit]" });
    await mcp.call("codara_preview_wait_for", { text: "Customer saved" });
    record("Fill and submit a form", "single tools");
    expect(JSON.parse(await pageValue("document.body.dataset.saved"))).toEqual(expected);

    await mcp.call("codara_preview_navigate", { url: fixture.url("/form") });
    await mcp.call("codara_preview_snapshot");
    await mcp.call("codara_preview_run", { steps: [
      { action: "type", selector: "input[name=name]", text: expected.name },
      { action: "type", selector: "input[name=email]", text: expected.email },
      { action: "type", selector: "input[name=company]", text: expected.company },
      { action: "type", selector: "select[name=country]", text: "es" },
      { action: "click", selector: "input[value=team]" },
      { action: "type", selector: "textarea[name=notes]", text: expected.notes },
      { action: "click", selector: "button[type=submit]" },
      { action: "snapshot" },
    ] });
    await mcp.call("codara_preview_run", { steps: [
      { action: "click", selector: "input[name=terms]" },
      { action: "click", selector: "button[type=submit]" },
      { action: "wait_for", text: "Customer saved" },
    ] });
    record("Fill and submit a form", "codara_preview_run");

    await mcp.call("codara_browser_use", { code: `await tab.goto(${JSON.stringify(fixture.url("/form"))}); await tab.snapshot()` });
    const form = await mcp.call("codara_browser_use", { code: `await tab.getByLabel("Full name").fill(${JSON.stringify(expected.name)});
await tab.getByLabel("Work email").fill(${JSON.stringify(expected.email)});
await tab.getByLabel("Company").fill(${JSON.stringify(expected.company)});
await tab.getByLabel("Country").selectOption({ label: "Spain" });
await tab.getByRole("radio", { name: "Team" }).check();
await tab.getByLabel("Notes").fill(${JSON.stringify(expected.notes)});
await tab.getByRole("button", { name: "Save customer" }).click();
const problem = await tab.getByRole("alert").textContent({ timeout: 1000 }).catch(() => null);
if (problem && problem.includes("terms")) {
  await tab.getByLabel("I accept the terms").check();
  await tab.getByRole("button", { name: "Save customer" }).click();
}
await tab.waitFor({ text: "Customer saved" });
await tab.screenshot();
({ problem, toast: await tab.getByRole("status").textContent() })` });
    expect(form.isError, form.text).toBe(false);
    expect(json(form.text)).toEqual({ problem: "Missing: terms", toast: "Customer saved: #1042" });
    await writeFile(join(OUT, "browser-code-form.jpg"), Buffer.from(form.images[0].data!, "base64"));
    record("Fill and submit a form", "codara_browser_use");
    expect(JSON.parse(await pageValue("document.body.dataset.saved"))).toEqual(expected);

    // ---- Flow 3: read a long table ----------------------------------------
    await mcp.call("codara_preview_navigate", { url: fixture.url("/table") });
    await mcp.call("codara_preview_snapshot");
    const extracted = await mcp.call("codara_preview_evaluate", {
      code: "Array.from(document.querySelectorAll('tbody tr')).map((tr) => Array.from(tr.cells).map((td) => td.textContent))",
    });
    const rows = (json(extracted.text).value as string[][]).filter((row) => row[3] === "overdue");
    expect(rows).toHaveLength(OVERDUE_COUNT);
    record("Read a long table", "single tools");

    await mcp.call("codara_preview_run", { steps: [
      { action: "navigate", url: fixture.url("/table") },
      { action: "snapshot" },
      { action: "evaluate", code: "Array.from(document.querySelectorAll('tbody tr')).map((tr) => Array.from(tr.cells).map((td) => td.textContent))" },
    ] });
    record("Read a long table", "codara_preview_run");

    const table = await mcp.call("codara_browser_use", { code: `await tab.goto(${JSON.stringify(fixture.url("/table"))});
const header = await tab.locator("thead th").allTextContents();
const cells = await tab.locator("tbody tr").evaluateAll((rows) => rows.map((row) => Array.from(row.cells, (cell) => cell.textContent)));
const overdue = cells.filter((row) => row[3] === "overdue");
({ header, rows: cells.length, overdueCount: overdue.length, overdueTotal: overdue.reduce((sum, row) => sum + Number(row[2].replace(/[^0-9]/g, "")), 0) })` });
    expect(table.isError, table.text).toBe(false);
    expect(json(table.text)).toEqual({ header: ["Invoice", "Customer", "Amount", "Status"], rows: 240, overdueCount: OVERDUE_COUNT, overdueTotal: OVERDUE_TOTAL });
    record("Read a long table", "codara_browser_use");

    // ---- Flow 4: compose an email draft in a webmail page -----------------
    const draft = { to: "ben@contoso.test", subject: "Invoice INV-2042", body: "Hi Ben, the invoice is attached. Thanks!" };
    await mcp.call("codara_preview_navigate", { url: fixture.url("/mail") });
    await mcp.call("codara_preview_snapshot");
    await mcp.call("codara_preview_click", { selector: "#compose" });
    await mcp.call("codara_preview_snapshot");
    await mcp.call("codara_preview_type", { selector: "input[name=to]", text: draft.to });
    await mcp.call("codara_preview_type", { selector: "input[name=subject]", text: draft.subject });
    await mcp.call("codara_preview_type", { selector: "#body", text: draft.body });
    await mcp.call("codara_preview_click", { selector: "#save-draft" });
    await mcp.call("codara_preview_wait_for", { text: "Drafts (1)" });
    await mcp.call("codara_preview_snapshot");
    record("Compose a webmail draft", "single tools");
    expect(JSON.parse(await pageValue("document.body.dataset.draft"))).toEqual(draft);

    await mcp.call("codara_preview_navigate", { url: fixture.url("/mail") });
    await mcp.call("codara_preview_snapshot");
    await mcp.call("codara_preview_run", { steps: [
      { action: "click", selector: "#compose" },
      { action: "type", selector: "input[name=to]", text: draft.to },
      { action: "type", selector: "input[name=subject]", text: draft.subject },
      { action: "type", selector: "#body", text: draft.body },
      { action: "click", selector: "#save-draft" },
      { action: "wait_for", text: "Drafts (1)" },
      { action: "snapshot" },
    ] });
    record("Compose a webmail draft", "codara_preview_run");

    await mcp.call("codara_browser_use", { code: `await tab.goto(${JSON.stringify(fixture.url("/mail"))}); await tab.snapshot()` });
    const mail = await mcp.call("codara_browser_use", { code: `await tab.getByRole("button", { name: "New message" }).click();
const composer = tab.getByRole("dialog", { name: "New message" });
await composer.getByLabel("To").fill(${JSON.stringify(draft.to)});
await composer.getByLabel("Subject").fill(${JSON.stringify(draft.subject)});
await composer.getByRole("textbox", { name: "Message body" }).fill(${JSON.stringify(draft.body)});
await tab.screenshot();
await composer.getByRole("button", { name: "Save draft" }).click();
await tab.waitFor({ text: "Drafts (1)" });
await tab.screenshot();
await tab.locator("#drafts li").allTextContents()` });
    expect(mail.isError, mail.text).toBe(false);
    expect(json(mail.text)).toEqual([`${draft.subject} (to ${draft.to})`]);
    expect(mail.images).toHaveLength(2);
    await writeFile(join(OUT, "browser-code-mail-compose.jpg"), Buffer.from(mail.images[0].data!, "base64"));
    await writeFile(join(OUT, "browser-code-mail-saved.jpg"), Buffer.from(mail.images[1].data!, "base64"));
    record("Compose a webmail draft", "codara_browser_use");
    expect(JSON.parse(await pageValue("document.body.dataset.draft"))).toEqual(draft);

    // DevTools access: protocol commands and events on the tab, refusals for
    // anything past it, and the network recorder alive after Network.disable.
    const devtools = await mcp.call("codara_browser_use", { code: `await tab.goto(${JSON.stringify(fixture.url("/login"))});
const sub = await tab.cdp.on("Network.responseReceived");
await tab.cdp.send("Network.disable");
await tab.evaluate("fetch(location.href + '?probe=1')");
const event = await sub.next({ filter: (params) => params.response.url.includes("probe=1"), timeout: 10000 });
await sub.close();
const doc = await tab.cdp.send("DOM.getDocument", { depth: 0 });
const ax = await tab.cdp.send("Accessibility.getFullAXTree");
const refused = [];
for (const method of ["Browser.getVersion", "Target.getTargets", "Fetch.enable", "Storage.clearDataForOrigin", "Input.dispatchMouseEvent"]) {
  refused.push(await tab.cdp.send(method).then(() => method + " sent", (error) => error.name));
}
const fileNav = await tab.cdp.send("Page.navigate", { url: "file:///etc/hostname" }).then(() => "navigated", (error) => error.message);
const rows = await tab.network.list({ filter: "probe=1" });
const detail = await tab.network.get(rows[0].id);
({ status: event.params.response.status, root: doc.root.nodeName, axNodes: ax.nodes.length > 3, refused, fileNav, rows: rows.length, detailStatus: detail.status })` });
    expect(devtools.isError, devtools.text).toBe(false);
    const probe = json(devtools.text);
    expect(probe).toMatchObject({ status: 200, root: "#document", axNodes: true, rows: 1, detailStatus: 200 });
    expect(probe.refused).toEqual(["BrowserError", "BrowserError", "BrowserError", "BrowserError", "BrowserError"]);
    expect(probe.fileNav).toMatch(/http and https pages only/);
    expect(await pageValue("location.protocol")).toBe("http:");

    // Bindings persist, and another MCP process (a new agent session) starts clean.
    const again = await mcp.call("codara_browser_use", { code: "typeof tab.goto" });
    expect(again.text).toBe("function");
    const other = startMcp(home);
    await other.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "another-agent", version: "1" } });
    expect((await other.call("codara_browser_use", { code: "typeof tab" })).text).toBe("undefined");
    other.close();

    // Page model: the outline every tool reads against an accessibility-tree
    // snapshot of the same page (role and name per line, ignored and generic
    // nodes left out), read from the preview's webContents over CDP.
    const pageModel: Array<{ page: string; outlineChars: number; axNodes: number; axChars: number; axJsonChars: number }> = [];
    for (const path of ["/login", "/form", "/table", "/mail"]) {
      await mcp.call("codara_preview_navigate", { url: fixture.url(path) });
      const outline = await mcp.call("codara_preview_snapshot");
      const ax = await app.evaluate(async ({ webContents }, url) => {
        const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url);
        if (!contents) throw new Error(`no webContents at ${url}`);
        const attached = contents.debugger.isAttached();
        if (!attached) contents.debugger.attach("1.3");
        try {
          const { nodes } = await contents.debugger.sendCommand("Accessibility.getFullAXTree");
          const byId = new Map(nodes.map((node: any) => [node.nodeId, node]));
          const lines: string[] = [];
          const walk = (node: any, depth: number) => {
            const role = node.role?.value ?? "";
            const name = node.name?.value ?? "";
            const shown = !node.ignored && !["generic", "none", "InlineTextBox", "LineBreak"].includes(role) && !(role === "StaticText" && !name.trim());
            if (shown) lines.push(`${"  ".repeat(depth)}${role}${name ? ` ${JSON.stringify(name)}` : ""}`);
            for (const id of node.childIds ?? []) {
              const child = byId.get(id);
              if (child) walk(child, shown ? depth + 1 : depth);
            }
          };
          walk(nodes.find((node: any) => !node.parentId), 0);
          return { axNodes: lines.length, axChars: lines.join("\n").length, axJsonChars: JSON.stringify(nodes).length };
        } finally {
          if (!attached) contents.debugger.detach();
        }
      }, fixture.url(path));
      pageModel.push({ page: path, outlineChars: outline.text.length, ...ax });
    }

    const lines = ["| Flow | Way | Tool calls | Characters sent | Characters read | Images | Wall time (ms) |", "|---|---|---:|---:|---:|---:|---:|"];
    for (const [flow, ways] of Object.entries(bench)) {
      for (const [way, tally] of Object.entries(ways)) {
        lines.push(`| ${flow} | ${way} | ${tally.calls} | ${tally.argChars} | ${tally.resultChars} | ${tally.images} | ${tally.ms} |`);
      }
    }
    lines.push("", "| Page | Outline chars | AX tree lines | AX tree chars (compact) | AX tree JSON chars |", "|---|---:|---:|---:|---:|");
    for (const row of pageModel) lines.push(`| ${row.page} | ${row.outlineChars} | ${row.axNodes} | ${row.axChars} | ${row.axJsonChars} |`);
    await writeFile(join(OUT, "browser-code-bench.json"), JSON.stringify({ flows: bench, pageModel }, null, 2));
    await writeFile(join(OUT, "browser-code-bench.md"), `${lines.join("\n")}\n`);
    console.log(lines.join("\n"));
    for (const ways of Object.values(bench)) {
      expect(ways.codara_browser_use.calls).toBeLessThan(ways["single tools"].calls);
    }
  } finally {
    mcp?.close();
    await app.close();
    fixture.server.closeAllConnections();
    fixture.server.close();
    await rm(root, { recursive: true, force: true });
  }
});
