// codara_preview_chrome: the state of the browser link, and opening, closing
// or bringing forward a tab of the user's browser. The extension decides
// again: it opens tabs only when the user turned that on, closes only tabs
// an agent opened, and brings forward only shared tabs. An opened tab always
// goes in a tab group: the one the agent names, or its workspace's.

import { normalizeTabGroupName } from "../../../shared/tab-group-name";
import { PreviewToolParamsError, type PreviewToolHost } from "../../preview-tools/types";
import { parseTabRef } from "../tab-ref";
import { chromeAgentLabel, recordChromeActivity } from "./activity";
import { chromeLinkRuntime } from "./runtime";

/** The group of a tab opened without one: named like the caller's workspace, so each workspace gets its own. */
async function workspaceGroup(params: Record<string, unknown>, host: PreviewToolHost): Promise<string> {
  const workspaceId = typeof params.workspaceId === "string" && params.workspaceId ? params.workspaceId : null;
  const name = host.workspaceName ? await host.workspaceName(workspaceId).catch(() => null) : null;
  return normalizeTabGroupName(name) || "Codara";
}

export async function chromeLinkTool(params: Record<string, unknown>, _method: string, host: PreviewToolHost): Promise<unknown> {
  if (!(await host.mayUseUserBrowser(params))) throw new PreviewToolParamsError("This session may not use tabs of your own browser.");
  const action = typeof params.action === "string" ? params.action : "status";
  const runtime = chromeLinkRuntime();
  if (!runtime) throw new Error("The browser extension link is turned off in this Codara.");
  const { server, backend } = runtime;
  const links = server.links();
  switch (action) {
    case "status":
      return {
        connected: links.length > 0,
        browsers: links.map((link) => ({
          linkId: link.linkId,
          browser: `${link.browser.name} ${link.browser.version}`.trim(),
          sharedTabs: [...link.tabs.values()].filter((tab) => !tab.blocked).length,
          mayOpenTabs: link.allowOpen,
        })),
        tabs: backend.summaries(),
        ...(links.length === 0
          ? { hint: "No browser is connected. The user installs the Codara extension (Settings, Browser) and connects it from its popup." }
          : {}),
      };
    case "open": {
      const url = typeof params.url === "string" ? params.url.trim() : "";
      if (!/^https?:\/\//i.test(url)) throw new PreviewToolParamsError("open needs an http or https url.");
      if (links.length === 0) throw new Error("No browser is connected to Codara.");
      const link = links.find((candidate) => candidate.allowOpen);
      if (!link) {
        throw new Error('The user has not let agents open tabs. They can turn on "Let agents open new tabs" in the Codara extension popup, or share an existing tab.');
      }
      const group = normalizeTabGroupName(params.group) || (await workspaceGroup(params, host));
      const opened = await link.request<{ tabId: number; url?: string; title?: string; blocked?: boolean; group?: string }>(
        "open",
        { url, group },
        30_000,
      );
      const tabId = backend.refFor(link, opened.tabId);
      recordChromeActivity({
        at: new Date().toISOString(),
        tool: "codara_preview_chrome",
        tab: tabId,
        agent: chromeAgentLabel(params),
        workspaceId: typeof params.workspaceId === "string" ? params.workspaceId : null,
        detail: `opened ${url}`,
      });
      if (opened.blocked) {
        return { ok: true, tabId, url: "", title: "", blocked: true, note: "The page ended on a site the user blocked for agents, so this tab cannot be used." };
      }
      return {
        ok: true,
        tabId,
        url: opened.url ?? url,
        title: opened.title ?? "",
        ...(typeof opened.group === "string" && opened.group ? { group: opened.group } : {}),
      };
    }
    case "close":
    case "activate": {
      const ref = parseTabRef(params.tabId);
      if (ref?.kind !== "chrome") throw new PreviewToolParamsError(`${action} needs the tabId of a Chrome tab, such as chrome:123.`);
      const { link, tab } = backend.locate(ref);
      await link.request(action, { tabId: tab.tabId });
      return { ok: true, tabId: backend.refFor(link, tab.tabId), action };
    }
    default:
      throw new PreviewToolParamsError(`Unknown action ${action}; use status, open, close or activate.`);
  }
}
