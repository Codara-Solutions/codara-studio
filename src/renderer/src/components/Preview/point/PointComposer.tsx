import { useCallback, useEffect, useRef, useState } from "react";
import { formatPickText, pickDetails, sourceLabel, type InspectedElement, type PointInspection } from "@shared/point-format";
import type { SelectionAttachment, SelectionPayload } from "../../../routing/SelectionRoutingContext";
import { CloseIcon } from "../../icons";
import SendControls, { type SendOutcome } from "./SendControls";

// The popover a pick opens: each picked element with its crop and where it
// lives in the source, a note, and where to send it. The text the agent gets
// is formatPickText (src/shared/point-format.ts); the crops travel as files
// and the full details are saved to a file the text names.

interface Props {
  tabId: string;
  workspaceId: string | null;
  inspection: PointInspection | null;
  loading: boolean;
  error: string | null;
  /** Where the first picked element sits, in the layer's pixels, to open beside it. */
  anchor: { left: number; top: number; width: number; height: number } | null;
  hostSize: { width: number; height: number };
  onRemove: (ref: string) => void;
  onAddMore: () => void;
  onClose: () => void;
  onDone: (outcome: SendOutcome) => void;
}

const WIDTH = 400;
const GAP = 12;

function sourceLine(element: InspectedElement): { kind: "source" | "guess" | "none"; text: string; title: string } {
  if (element.source) {
    const component = element.source.component ?? element.components.at(-1);
    return {
      kind: "source",
      text: `${sourceLabel(element.source)}${component ? `  <${component}>` : ""}`,
      title: `${sourceLabel(element.source)} (from ${element.source.via})${element.source.exists ? "" : ", not found in this workspace"}`,
    };
  }
  const candidate = element.candidates[0];
  if (candidate) return { kind: "guess", text: `likely ${candidate.file}:${candidate.line}`, title: candidate.reason };
  return { kind: "none", text: "No source file found", title: "The page reports no source and the workspace search found nothing" };
}

function position(anchor: Props["anchor"], host: Props["hostSize"]): React.CSSProperties {
  if (!anchor || host.width < WIDTH + 2 * GAP) return { right: GAP, bottom: GAP };
  const right = anchor.left + anchor.width + GAP;
  if (right + WIDTH + GAP <= host.width) return { left: right, top: Math.min(Math.max(GAP, anchor.top), Math.max(GAP, host.height - 360)) };
  const left = anchor.left - WIDTH - GAP;
  if (left >= GAP) return { left, top: Math.min(Math.max(GAP, anchor.top), Math.max(GAP, host.height - 360)) };
  return anchor.top + anchor.height / 2 > host.height / 2 ? { left: GAP, top: GAP } : { left: GAP, bottom: GAP };
}

export default function PointComposer({ tabId, workspaceId, inspection, loading, error, anchor, hostSize, onRemove, onAddMore, onClose, onDone }: Props) {
  const [note, setNote] = useState("");
  const noteRef = useRef<HTMLTextAreaElement | null>(null);
  const sendRef = useRef<(() => void) | null>(null);
  const elements = inspection?.elements ?? [];

  useEffect(() => {
    noteRef.current?.focus();
  }, []);

  const prepare = useCallback(
    async (purpose: "deliver" | "copy"): Promise<SelectionPayload> => {
      if (!inspection || !inspection.elements.length) throw new Error("Nothing is picked.");
      if (!workspaceId) throw new Error("Open a workspace first.");
      const plain = { ...inspection, elements: inspection.elements.map((element) => ({ ...element, crop: undefined })) };
      const detailsPath = await window.spark.point.saveDetails({ workspaceId, label: "picked-elements", details: pickDetails(plain) }).catch(() => null);
      if (purpose === "deliver") {
        // The delivery service saves the crops and lists their paths after
        // the text, so the blocks do not name a path of their own.
        const attachments: SelectionAttachment[] = [];
        inspection.elements.forEach((element, index) => {
          if (element.crop?.data) attachments.push({ name: `element-${index + 1}.jpg`, mimeType: element.crop.mimeType, data: element.crop.data });
        });
        return { source: "inspect", text: formatPickText(plain, note, { detailsPath }), attachments, tabId: inspection.tabId, url: inspection.url };
      }
      const saved = await Promise.all(
        inspection.elements.map(async (element, index) => {
          if (!element.crop?.data || element.crop.path) return element;
          const path = await window.spark.point.saveImage({ workspaceId, label: `element-${index + 1}`, mimeType: "image/jpeg", data: element.crop.data });
          return { ...element, crop: { ...element.crop, path } };
        }),
      );
      return { source: "inspect", text: formatPickText({ ...inspection, elements: saved }, note, { detailsPath }), tabId: inspection.tabId, url: inspection.url };
    },
    [inspection, note, workspaceId],
  );

  const host = (() => {
    try {
      return inspection ? new URL(inspection.url).host || inspection.url : "";
    } catch {
      return inspection?.url ?? "";
    }
  })();

  return (
    <div
      className="cp-panel cp-composer spark-glass--strong spark-overlay-surface spark-fade-in"
      role="dialog"
      aria-label="Send picked elements"
      data-testid="point-composer"
      style={position(anchor, hostSize)}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="cp-composer__head">
        <div className="cp-composer__title">
          <strong>{loading ? "Reading the page…" : elements.length === 1 ? "1 element" : `${elements.length} elements`}</strong>
          <span title={inspection ? `${inspection.url} (tab ${tabId})` : tabId}>{host ? `${host} · ${tabId}` : tabId}</span>
        </div>
        <button type="button" className="spark-btn cp-btn" onClick={onAddMore} title="Pick more elements on the page">
          Add more
        </button>
        <button type="button" className="spark-icon-btn" onClick={onClose} title="Close (Esc)" aria-label="Close" style={{ ["--spark-icon-btn-size" as string]: "24px" }}>
          <CloseIcon size={12} />
        </button>
      </div>
      <div className="cp-composer__body">
        {loading ? (
          <>
            <div className="cp-skeleton" />
            <div className="cp-skeleton" style={{ opacity: 0.6 }} />
          </>
        ) : null}
        {error ? <div className="cp-status" data-tone="error" role="alert">{error}</div> : null}
        {elements.map((element, index) => {
          const line = sourceLine(element);
          return (
            <div key={element.ref} className="cp-element" data-testid="point-element">
              <span className="cp-element__num">{index + 1}</span>
              {element.crop?.data ? (
                <img className="cp-element__thumb" alt="" src={`data:${element.crop.mimeType};base64,${element.crop.data}`} />
              ) : (
                <span className="cp-element__thumb" />
              )}
              <div className="cp-element__text">
                <span className="cp-element__label" title={element.selector}>
                  {element.tag}
                  {element.name ? <span className="cp-element__name"> {element.name.slice(0, 60)}</span> : null}
                </span>
                <span className="cp-element__source" data-kind={line.kind} title={line.title}>{line.text}</span>
              </div>
              <button
                type="button"
                className="spark-icon-btn"
                onClick={() => onRemove(element.ref)}
                title="Remove from the selection"
                aria-label={`Remove element ${index + 1}`}
                style={{ ["--spark-icon-btn-size" as string]: "22px" }}
              >
                <CloseIcon size={11} />
              </button>
            </div>
          );
        })}
        {inspection?.missing.length ? (
          <div className="cp-status">{inspection.missing.length} picked element{inspection.missing.length === 1 ? " is" : "s are"} gone from the page.</div>
        ) : null}
      </div>
      <div className="cp-composer__foot">
        <textarea
          ref={noteRef}
          className="cp-note"
          value={note}
          placeholder="What should change? (optional)"
          aria-label="Note for the agent"
          onChange={(event) => setNote(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              sendRef.current?.();
            }
          }}
        />
        <SendControls tabId={tabId} disabled={loading || !elements.length} prepare={prepare} onDone={onDone} sendRef={sendRef} />
      </div>
    </div>
  );
}
