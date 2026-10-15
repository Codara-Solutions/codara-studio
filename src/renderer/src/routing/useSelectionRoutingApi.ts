import { useCallback, useEffect, useMemo, useRef } from "react";
import type { AgentDeliveryTarget } from "@shared/agent-delivery";
import { makeId } from "@shared/ids";
import type { RunState, Workspace } from "@shared/types";
import { previewTabOwner } from "../components/Preview/registry";
import { isDockLeaf } from "../tabs/dock";
import type { Tab } from "../tabs/types";
import {
  chatDestinations,
  defaultDestination,
  findPaneLeaf,
  INBOX_DESTINATION,
  paneDestinations,
} from "./agent-destinations";
import type {
  RouteOptions,
  RouteResult,
  RoutingDestination,
  SelectionAttachment,
  SelectionPayload,
  SelectionRoutingApi,
} from "./SelectionRoutingContext";

// The routing API App.tsx provides to browser tabs: the destination menu
// for a send, its default, and the send itself. Kept out of App.tsx so the
// menu rules live with their tests (scripts/test-agent-destinations.cjs).

export interface SelectionRoutingInputs {
  activeWorkspace: Workspace | null;
  runs: RunState[];
  activeRunId: string | null;
  // Terminal tabs on screen for the active run, as the workbench shows them.
  tabs: Tab[];
  // The tab on screen and its focused pane, when it is a terminal grid.
  activeTab: Tab | null;
  activePaneId: string | null;
  // Panes main reports an agent CLI in, for the active workspace.
  detectedAgents: Readonly<Record<string, true>>;
  paneRuntime: { readonly current: ReadonlyMap<string, { altScreenActive?: boolean }> };
  selectRun: (runId: string, workspaceId: string) => void;
  refreshRuns: (workspaceId: string) => Promise<unknown> | void;
}

// A new Cora chat takes images as files on disk; PNG is what the chat's
// image store accepts, so other formats are redrawn first.
async function imageAttachmentsForChat(attachments: readonly SelectionAttachment[] | undefined) {
  const out: Array<{ sourcePath: string; kind: "image" }> = [];
  for (const attachment of attachments ?? []) {
    if (!attachment.data || !attachment.mimeType?.startsWith("image/")) continue;
    let dataUrl = `data:${attachment.mimeType};base64,${attachment.data}`;
    if (attachment.mimeType !== "image/png") {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("Could not read an image to attach."));
        image.src = dataUrl;
      });
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext("2d")?.drawImage(image, 0, 0);
      dataUrl = canvas.toDataURL("image/png");
    }
    out.push({ sourcePath: await window.spark.drawing.save({ dataUrl }), kind: "image" });
  }
  return out;
}

function deliveryTarget(destinationId: string): AgentDeliveryTarget | null {
  if (destinationId === "inbox") return { kind: "inbox", paneId: null };
  if (destinationId.startsWith("pane:")) return { kind: "pane", paneId: destinationId.slice("pane:".length) };
  if (destinationId.startsWith("chat:")) return { kind: "chat", runId: destinationId.slice("chat:".length) };
  return null;
}

export function useSelectionRoutingApi(inputs: SelectionRoutingInputs): SelectionRoutingApi {
  const { activeWorkspace, runs, activeRunId, tabs, activeTab, activePaneId, detectedAgents, paneRuntime, selectRun, refreshRuns } = inputs;

  // The terminal pane the user was last in, whatever is on screen now: a send
  // from a browser tab defaults to the agent there. A browser cell docked in
  // the grid is not a terminal, so focusing it keeps the previous pane.
  const lastFocusedPaneId = useRef<string | null>(null);
  useEffect(() => {
    if (!activePaneId || activeTab?.kind !== "terminal") return;
    const leaf = findPaneLeaf(activeTab.root, activePaneId);
    if (leaf && !isDockLeaf(leaf)) lastFocusedPaneId.current = activePaneId;
  }, [activeTab, activePaneId]);

  const destinationsFor = useCallback(
    (tabId: string | null): { destinations: RoutingDestination[]; defaultId: string } => {
      const owner = tabId ? previewTabOwner(tabId) : null;
      const altScreen = new Set<string>();
      for (const [paneId, state] of paneRuntime.current) if (state.altScreenActive) altScreen.add(paneId);
      const panes = paneDestinations(tabs, runs, { detected: detectedAgents, altScreen }, lastFocusedPaneId.current);
      const chats = chatDestinations(runs, activeRunId, owner?.runId ? [owner.runId] : [], Boolean(activeWorkspace));
      const destinations: RoutingDestination[] = [...panes, ...chats, INBOX_DESTINATION];
      return { destinations, defaultId: defaultDestination(destinations, owner, activeRunId) };
    },
    [activeRunId, activeWorkspace, detectedAgents, paneRuntime, runs, tabs],
  );

  const route = useCallback(
    async (payload: SelectionPayload, destinationId: string, options: RouteOptions = {}): Promise<RouteResult> => {
      const workspace = activeWorkspace;
      if (!workspace) throw new Error("Open a workspace first.");
      const label = destinationsFor(payload.tabId ?? null).destinations.find((d) => d.id === destinationId)?.label ?? destinationId;
      if (destinationId === "chat-new") {
        const attachments = await imageAttachmentsForChat(payload.attachments);
        const run = await window.spark.orchestration.startAutopilot({
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          cwd: workspace.cwd,
          initialUserNote: payload.text,
          initialUserNoteClientMessageId: makeId("client-msg"),
          initialAttachments: attachments.length ? attachments : undefined,
        });
        // Bind to the originating workspace: the user may have switched away
        // during the startAutopilot await.
        selectRun(run.id, workspace.id);
        void refreshRuns(workspace.id);
        return { outcome: "started", label };
      }
      const target = deliveryTarget(destinationId);
      if (!target) throw new Error(`Unknown destination: ${destinationId}`);
      const result = await window.spark.agentDelivery.deliver({
        workspaceId: workspace.id,
        target,
        text: payload.text,
        attachments: payload.attachments,
        submit: options.submit === true,
        source: payload.source === "inspect" ? "picker" : payload.source === "draw" ? "comment" : payload.source === "git" ? "git" : "tab",
        ...(payload.tabId ? { tabId: payload.tabId } : {}),
        ...(payload.url ? { url: payload.url } : {}),
      });
      return { outcome: result.outcome, label };
    },
    [activeWorkspace, destinationsFor, refreshRuns, selectRun],
  );

  const tabSession = useCallback(
    (tabId: string): string | null => {
      const owner = previewTabOwner(tabId);
      if (owner?.paneId) {
        const pane = paneDestinations(tabs, runs, { detected: detectedAgents, altScreen: new Set() }, null)
          .find((d) => d.paneId === owner.paneId);
        return pane ? pane.label : `agent pane ${owner.paneId}`;
      }
      if (owner?.runId) {
        const run = runs.find((candidate) => candidate.id === owner.runId);
        return `Cora run ${owner.runId}${run?.title ? ` (${run.title})` : ""}`;
      }
      return null;
    },
    [detectedAgents, runs, tabs],
  );

  return useMemo(
    () => ({ workspaceId: activeWorkspace?.id ?? null, destinationsFor, route, tabSession }),
    [activeWorkspace?.id, destinationsFor, route, tabSession],
  );
}
