// A headless Firefox on a throwaway profile for the Firefox extension's
// specs. WebDriver BiDi is the test's remote control only: it installs the
// extension as a temporary add-on and reads and clicks the extension's own
// pages, as a user would. The extension itself never uses it.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WebSocket } from "ws";

/** The extension's gecko id (extensions/firefox/manifest.json). */
export const FIREFOX_EXTENSION_ID = "@codara-firefox";
/** The moz-extension:// uuid the throwaway profile gives it, fixed so the spec can open its pages. */
export const FIREFOX_EXTENSION_UUID = "0d0d0d0d-1111-4222-8333-444444444444";
export const MIN_FIREFOX = 153;

/** A Firefox binary at least MIN_FIREFOX: CODARA_E2E_FIREFOX, else firefox on PATH. */
export function findFirefox(): { path: string; version: number } | null {
  const candidate = process.env.CODARA_E2E_FIREFOX?.trim() || "firefox";
  try {
    const text = execFileSync(candidate, ["--version"], { encoding: "utf8", timeout: 20_000, env: { ...process.env, MOZ_HEADLESS: "1" } });
    const version = Number(/Firefox\s+(\d+)/.exec(text)?.[1] ?? 0);
    return version >= MIN_FIREFOX ? { path: candidate, version } : null;
  } catch {
    return null;
  }
}

export interface HeadlessFirefox {
  readonly pid: number | undefined;
  readonly version: number;
  call<T = any>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** Install a folder as a temporary add-on. */
  install(dir: string): Promise<void>;
  /** A new tab on url, loaded; its browsing context id. */
  open(url: string): Promise<string>;
  /** A new tab on one of the extension's own pages, loaded; its browsing context id. */
  openExtensionPage(url: string): Promise<string>;
  closeTab(context: string): Promise<void>;
  navigate(context: string, url: string): Promise<void>;
  /** An expression's value in a tab or an extension page. */
  evaluate<T = any>(context: string, expression: string): Promise<T>;
  /** A real mouse click on an element, which Firefox counts as the user's (permissions.request needs one). */
  click(context: string, selector: string): Promise<void>;
  /** The lines Firefox's install question shows for these permissions. */
  installQuestion(permissions: string[]): Promise<string[]>;
  /** Whether Firefox shows its "add permissions" question for an extension. */
  permissionQuestionShown(): Promise<boolean>;
  /** Answer that question as the user's Allow or Deny would; fails if none shows within 10 s. */
  answerPermissionQuestion(allow: boolean): Promise<void>;
  screenshot(context: string): Promise<Buffer>;
  close(): Promise<void>;
}

export async function launchFirefox(
  binary: { path: string; version: number },
  { prefs = {}, profileDir }: { prefs?: Record<string, unknown>; /** A profile kept on disk across launches, as a real restart keeps it; the caller removes it. */ profileDir?: string } = {},
): Promise<HeadlessFirefox> {
  const root = mkdtempSync(join(tmpdir(), "codara-firefox-"));
  const profile = profileDir ?? join(root, "profile");
  mkdirSync(profile, { recursive: true });
  const all: Record<string, unknown> = {
    "extensions.webextensions.uuids": JSON.stringify({ [FIREFOX_EXTENSION_ID]: FIREFOX_EXTENSION_UUID }),
    // permissions.request still needs a click in the extension's page; this only skips the doorhanger.
    "extensions.webextOptionalPermissionPrompts": false,
    "browser.shell.checkDefaultBrowser": false,
    "app.normandy.enabled": false,
    "messaging-system.rsexperimentloader.enabled": false,
    "app.shield.optoutstudies.enabled": false,
    "datareporting.policy.dataSubmissionEnabled": false,
    "toolkit.telemetry.reportingpolicy.firstRun": false,
    "browser.startup.homepage_override.mstone": "ignore",
    "extensions.update.enabled": false,
    "extensions.getAddons.cache.enabled": false,
    "browser.safebrowsing.malware.enabled": false,
    "browser.safebrowsing.phishing.enabled": false,
    "services.settings.server": "http://127.0.0.1:9/",
    ...prefs,
  };
  writeFileSync(join(profile, "user.js"), Object.entries(all).map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`).join("\n"));
  const child: ChildProcess = spawn(binary.path, ["--headless", "--no-remote", "--profile", profile, "--remote-debugging-port", "0", "--remote-allow-system-access", "about:blank"], {
    stdio: ["ignore", "ignore", "pipe"],
    // System access (the flag before Firefox 160, the variable since) lets
    // the test read the extension's pages and open them from the browser window.
    env: { ...process.env, MOZ_HEADLESS: "1", MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1" },
  });
  let stderr = "";
  // A Firefox that could not start at all reports an error and no exit.
  let spawnError: Error | null = null;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", (error) => {
      spawnError = error;
      resolve();
    });
  });
  // Stops Firefox and removes its profile, also when it never finished starting.
  const stop = async () => {
    if (child.pid !== undefined && !spawnError && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const killer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      await exited;
      clearTimeout(killer);
    }
    rmSync(root, { recursive: true, force: true });
  };
  try {
    return await connect();
  } catch (error) {
    await stop();
    throw error;
  }

  async function connect(): Promise<HeadlessFirefox> {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Firefox did not start its BiDi server: ${stderr.slice(-1000)}`)), 60_000);
      child.stderr?.on("data", (chunk) => {
        stderr += chunk;
        const match = /WebDriver BiDi listening on (ws:\/\/\S+)/.exec(stderr);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      void exited.then(() => {
        clearTimeout(timer);
        reject(spawnError ?? new Error(`Firefox exited (${child.exitCode}): ${stderr.slice(-1000)}`));
      });
    });
    const socket = new WebSocket(`${url}/session`);
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    let nextId = 1;
    const waiting = new Map<number, (message: any) => void>();
    // A lost connection fails every command still waiting, instead of hanging the test.
    socket.on("close", () => {
      for (const waiter of waiting.values()) waiter({ type: "error", error: "connection closed", message: "Firefox's WebDriver BiDi connection closed" });
      waiting.clear();
    });
    socket.on("message", (data) => {
      const message = JSON.parse(String(data));
      const waiter = typeof message.id === "number" ? waiting.get(message.id) : undefined;
      if (!waiter) return;
      waiting.delete(message.id);
      waiter(message);
    });
    const call = <T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new Error(`${method}: no answer from Firefox in 60 s`));
        }, 60_000);
        waiting.set(id, (message) => {
          clearTimeout(timer);
          if (message.type === "error") reject(new Error(`${method}: ${message.error}: ${message.message}`));
          else resolve(message.result);
        });
        if (socket.readyState !== WebSocket.OPEN) waiting.get(id)!({ type: "error", error: "connection closed", message: "Firefox's WebDriver BiDi connection is not open" });
        else socket.send(JSON.stringify({ id, method, params }));
      });
    await call("session.new", { capabilities: {} });
    // An expression in the browser window itself (its toolbar and doorhangers).
    const inBrowserWindow = async (expression: string): Promise<unknown> => {
      const { contexts } = await call<{ contexts: { context: string }[] }>("browsingContext.getTree", { maxDepth: 0, "moz:scope": "chrome" });
      const answer = await call<{ result?: { value?: unknown } }>("script.evaluate", { expression, target: { context: contexts[0].context }, awaitPromise: false });
      return answer.result?.value;
    };
    const firefox: HeadlessFirefox = {
      pid: child.pid,
      version: binary.version,
      call,
      async installQuestion(permissions) {
        const text = await inBrowserWindow(`(() => { const { ExtensionData } = ChromeUtils.importESModule("resource://gre/modules/Extension.sys.mjs"); return JSON.stringify(ExtensionData.formatPermissionStrings({ permissions: { permissions: ${JSON.stringify(permissions)}, origins: [] } }).msgs); })()`);
        return JSON.parse(String(text));
      },
      async install(dir) {
        await call("webExtension.install", { extensionData: { type: "path", path: dir } });
      },
      async open(target) {
        const { context } = await call<{ context: string }>("browsingContext.create", { type: "tab" });
        await firefox.navigate(context, target);
        return context;
      },
      // Firefox 160 refuses a WebDriver navigation to moz-extension:// pages, so
      // the browser window opens the tab itself, as a click in the toolbar would.
      async openExtensionPage(target) {
        const contentTabs = async () => (await call<{ contexts: { context: string; url: string }[] }>("browsingContext.getTree", { maxDepth: 0 })).contexts;
        const before = new Set((await contentTabs()).map((tab) => tab.context));
        const { contexts } = await call<{ contexts: { context: string }[] }>("browsingContext.getTree", { maxDepth: 0, "moz:scope": "chrome" });
        await call("script.evaluate", {
          expression: `gBrowser.selectedTab = gBrowser.addTab(${JSON.stringify(target)}, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }); true`,
          target: { context: contexts[0].context },
          awaitPromise: false,
        });
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          const opened = (await contentTabs()).find((tab) => !before.has(tab.context) && tab.url === target);
          if (opened) {
            const ready = await firefox.evaluate(opened.context, "document.readyState").catch(() => null);
            if (ready === "complete") return opened.context;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error(`${target} did not open`);
      },
      async closeTab(context) {
        await call("browsingContext.close", { context });
      },
      async navigate(context, target) {
        // After a load that a redirect took to another site's process, Firefox's
        // remote agent can still count that load as running and never answer
        // the next navigate, though the page loads (its trace: "Document already
        // loading", then "Skip stop state"). So the page's own word counts too:
        // a new document (the old one is marked first) at that address, loaded.
        const page = (expression: string) =>
          call<{ result?: { value?: string } }>("script.evaluate", { expression, target: { context }, awaitPromise: false, resultOwnership: "none" }).then((answer) => answer?.result?.value, () => null);
        await page("window.codaraOldDocument = true; ''");
        const navigated = call("browsingContext.navigate", { context, url: target, wait: "complete" });
        const deadline = Date.now() + 60_000;
        let done = false;
        void navigated.then(() => (done = true), () => {});
        while (!done) {
          if (Date.now() > deadline) return void (await navigated);
          await new Promise((resolve) => setTimeout(resolve, 250));
          if ((await page("window.codaraOldDocument ? '' : location.href + ' ' + document.readyState")) === `${new URL(target).href} complete`) {
            navigated.catch(() => {});
            return;
          }
        }
        await navigated;
      },
      async evaluate(context, expression) {
        const answer = await call<{ type: string; result?: any; exceptionDetails?: { text?: string } }>("script.evaluate", {
          expression,
          target: { context },
          awaitPromise: true,
          resultOwnership: "none",
          serializationOptions: { maxObjectDepth: 6 },
        });
        if (answer.type === "exception") throw new Error(answer.exceptionDetails?.text ?? "the page threw");
        return deserialize(answer.result) as any;
      },
      async click(context, selector) {
        const node = await call<{ result: { type: string; sharedId?: string } }>("script.evaluate", {
          expression: `document.querySelector(${JSON.stringify(selector)})`,
          target: { context },
          awaitPromise: false,
          resultOwnership: "root",
        });
        if (node.result.type !== "node" || !node.result.sharedId) throw new Error(`no ${selector} to click`);
        const element = { type: "element", element: { sharedId: node.result.sharedId } };
        await call("input.performActions", {
          context,
          actions: [{ type: "pointer", id: "mouse", actions: [{ type: "pointerMove", x: 0, y: 0, origin: element }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }] }],
        });
      },
      async permissionQuestionShown() {
        return (await inBrowserWindow(`PopupNotifications._currentNotifications.some((note) => note.id === "addon-webext-permissions")`)) === true;
      },
      // The question's own Allow and Deny run these callbacks.
      async answerPermissionQuestion(allow) {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const answered = await inBrowserWindow(`(() => {
            const note = PopupNotifications._currentNotifications.find((note) => note.id === "addon-webext-permissions");
            if (!note) return false;
            (${allow} ? note.mainAction : note.secondaryActions[0]).callback();
            note.remove();
            return true;
          })()`);
          if (answered === true) return;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error("Firefox asked for no permission");
      },
      async screenshot(context) {
        const { data } = await call<{ data: string }>("browsingContext.captureScreenshot", { context });
        return Buffer.from(data, "base64");
      },
      async close() {
        try {
          await Promise.race([call("browser.close").catch(() => {}), new Promise((resolve) => setTimeout(resolve, 10_000))]);
          socket.close();
        } finally {
          await stop();
        }
      },
    };
    return firefox;
  }
}

/** A BiDi remote value as plain JSON. */
function deserialize(value: any): unknown {
  if (!value || typeof value !== "object") return value;
  switch (value.type) {
    case "undefined":
    case "null":
      return null;
    case "string":
    case "number":
    case "boolean":
      return value.value;
    case "array":
      return (value.value ?? []).map(deserialize);
    case "object":
      return Object.fromEntries((value.value ?? []).map(([key, item]: [unknown, unknown]) => [typeof key === "string" ? key : deserialize(key), deserialize(item)]));
    default:
      return value.value ?? null;
  }
}
