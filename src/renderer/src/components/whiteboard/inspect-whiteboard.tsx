import { createRoot } from "react-dom/client";
import { toPng } from "html-to-image";
import type { CoraWhiteboard } from "@shared/types";
import { whiteboardIssues, whiteboardRect, type WhiteboardIssue } from "@shared/whiteboard-quality";
import CoraWhiteboardCanvas from "./CoraWhiteboardCanvas";

// Capture a separate instance of the real canvas so background review never
// pans the user's board, changes their selection, or steals keyboard focus.
export async function inspectWhiteboard(board: CoraWhiteboard, nodeIds: string[] = []) {
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "position:fixed;left:-20000px;top:0;width:1600px;height:1000px;pointer-events:none;";
  document.body.appendChild(host);
  const root = createRoot(host);
  const issues: WhiteboardIssue[] = whiteboardIssues(board);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Whiteboard renderer did not initialize.")), 10_000);
      root.render(<CoraWhiteboardCanvas board={board} onReady={() => { clearTimeout(timer); resolve(); }} />);
    });
    await document.fonts.ready;
    const deadline = Date.now() + 5000;
    while (host.querySelectorAll("[data-whiteboard-node]").length !== board.nodes.length) {
      if (Date.now() > deadline) throw new Error("Whiteboard cards did not finish rendering.");
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    const viewport = host.querySelector<HTMLElement>(".react-flow__viewport");
    if (!viewport) throw new Error("Whiteboard viewport is unavailable.");
    // Full-detail typography is needed to detect clipping, even when the
    // overview is zoomed out. The capture includes the same cards and edges.
    host.querySelector<HTMLElement>("[data-zoom]")!.dataset.zoom = "near";
    for (const card of host.querySelectorAll<HTMLElement>("[data-whiteboard-node]")) {
      for (const text of card.querySelectorAll<HTMLElement>(".cora-board-card__title, .cora-board-card__body")) {
        if (text.scrollHeight > text.clientHeight + 2 || text.scrollWidth > text.clientWidth + 2) {
          issues.push({ code: "clipped-text", severity: "error", ids: [card.dataset.whiteboardNode!], message: `Text is clipped in ${card.dataset.whiteboardNode}. Enlarge the card or shorten its text.` });
          break;
        }
      }
    }
    const targets = nodeIds.length ? board.nodes.filter((node) => nodeIds.includes(node.id)) : board.nodes;
    if (!targets.length) throw new Error("No matching whiteboard nodes to inspect.");
    const rects = targets.map(whiteboardRect);
    const x = Math.min(...rects.map((rect) => rect.x)) - 40;
    const y = Math.min(...rects.map((rect) => rect.y)) - 40;
    const width = Math.max(...rects.map((rect) => rect.x + rect.width)) - x + 40;
    const height = Math.max(...rects.map((rect) => rect.y + rect.height)) - y + 40;
    const scale = Math.min(1.5, 1600 / width, 1000 / height);
    const imageSize = { width: Math.ceil(width * scale), height: Math.ceil(height * scale) };
    const dataUrl = await toPng(viewport, {
      ...imageSize, pixelRatio: 1, skipFonts: true,
      backgroundColor: getComputedStyle(document.body).backgroundColor,
      style: { width: `${imageSize.width}px`, height: `${imageSize.height}px`, transform: `translate(${-x * scale}px, ${-y * scale}px) scale(${scale})`, transformOrigin: "0 0" },
    });
    return { dataUrl, revision: board.revision ?? 0, imageSize, scale, bounds: { x, y, width, height }, nodeIds: board.nodes.filter((node) => {
        const rect = whiteboardRect(node);
        return rect.x >= x && rect.y >= y && rect.x + rect.width <= x + width && rect.y + rect.height <= y + height;
      }).map((node) => node.id), issues,
      detailNeeded: scale < 0.55,
      next: "Inspect the image and source evidence, fix issues with merge/arrange, then inspect again and review that revision. Use nodeIds for readable detail crops." };
  } finally {
    root.unmount();
    host.remove();
  }
}
