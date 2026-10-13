import type { PointElement, PointRegionHit } from "./preview-point";
import { plainTerminalText } from "./terminal-text";

// What pointing at the page produces once main has mapped the page's source
// hints to files, and the short text an agent receives for it. The same
// text goes to every runtime (a paste into a CLI agent's prompt, a Cora chat
// message, an inbox item), so it is plain text that reads well in a
// terminal: one block per element, with the full details in a JSON file
// under Codara's workspace data folder that the text names.

export interface ResolvedSource {
  /** Workspace-relative when inside the workspace. */
  file: string;
  line?: number;
  column?: number;
  via: string;
  component?: string;
  /** The file was found on disk. */
  exists: boolean;
}

export interface SourceCandidateHint {
  file: string;
  line: number;
  reason: string;
}

export interface PointCrop {
  mimeType: string;
  /** Base64; present when the caller asked for the bytes. */
  data?: string;
  path: string | null;
}

export interface InspectedElement extends Omit<PointElement, "sources"> {
  /** The best source location, or null when none resolved to a file. */
  source: ResolvedSource | null;
  sources: ResolvedSource[];
  /** Likely files from a workspace search, when no source resolved. */
  candidates: SourceCandidateHint[];
  crop?: PointCrop;
}

export interface InspectedRegion extends Omit<PointRegionHit, "elements"> {
  elements: Array<Omit<PointRegionHit["elements"][number], "sources"> & { source: ResolvedSource | null }>;
}

export interface PointInspection {
  /** The tab id agents pass back (tab-3, chrome:12). */
  tabId: string;
  url: string;
  title: string;
  viewport: { width: number; height: number };
  scroll: { x: number; y: number };
  devicePixelRatio: number;
  elements: InspectedElement[];
  regions: InspectedRegion[];
  missing: Array<{ selector: string; error: string }>;
}

/** One box or arrow drawn on the page, in viewport CSS pixels at the time it was drawn. */
export interface PointAnnotation {
  kind: "box" | "arrow" | "pen";
  x: number;
  y: number;
  width: number;
  height: number;
  /** Arrow start and tip. */
  from?: { x: number; y: number };
  to?: { x: number; y: number };
  note: string;
}

export function sourceLabel(source: Pick<ResolvedSource, "file" | "line" | "column">): string {
  return source.line ? `${source.file}:${source.line}${source.column ? `:${source.column}` : ""}` : source.file;
}

function round(value: number): number {
  return Math.round(value);
}

function edgeText(values: readonly number[]): string {
  const [t, r, b, l] = values.map(round);
  if (t === r && r === b && b === l) return `${t}`;
  if (t === b && r === l) return `${t} ${r}`;
  return `${t} ${r} ${b} ${l}`;
}

const STYLE_LINE_KEYS = [
  "display", "position", "flex-direction", "justify-content", "align-items", "gap", "grid-template-columns",
  "font-family", "font-size", "font-weight", "line-height", "color", "background-color", "border", "border-radius",
  "box-shadow", "opacity",
];

function elementLabel(element: Pick<InspectedElement, "tag" | "role" | "name">): string {
  const name = element.name ? ` "${element.name.slice(0, 60)}"` : "";
  const role = element.role && element.role !== "generic" && element.role !== element.tag ? ` ${element.role}` : "";
  return `<${element.tag}>${role}${name}`;
}

function provenanceLine(element: InspectedElement): string | null {
  const components = element.components.length ? element.components.slice(-3).map((name) => `<${name}>`).join(" > ") : "";
  if (element.source) {
    const how = element.framework ? `${element.framework}${components ? `, ${components}` : ""}` : components || element.source.via;
    return `source: ${sourceLabel(element.source)}${element.source.exists ? "" : " (not found in workspace)"}${how ? ` (${how})` : ""}`;
  }
  if (element.candidates.length) {
    const list = element.candidates.slice(0, 3).map((candidate) => `${candidate.file}:${candidate.line} (${candidate.reason})`).join("; ");
    return `source: not reported by the page; likely ${list}${components ? `; components ${components}` : ""}`;
  }
  return components ? `components: ${components}` : null;
}

/** The block for one element: label, selector, source, box and the styles that matter. */
export function formatElementBlock(element: InspectedElement, index: number): string {
  const lines = [`${index}. ${elementLabel(element)} ${element.ref}`];
  lines.push(`   selector: ${element.selector}`);
  const provenance = provenanceLine(element);
  if (provenance) lines.push(`   ${provenance}`);
  const box = element.box;
  const model = element.boxModel;
  const spacing = [
    model.margin.some(Boolean) ? `margin ${edgeText(model.margin)}` : "",
    model.padding.some(Boolean) ? `padding ${edgeText(model.padding)}` : "",
  ].filter(Boolean).join(", ");
  lines.push(`   box: ${round(box.width)}x${round(box.height)} at ${round(box.x)},${round(box.y)} (page ${round(box.pageX)},${round(box.pageY)})${spacing ? `; ${spacing}` : ""}`);
  const styles = STYLE_LINE_KEYS.filter((key) => element.styles[key]).map((key) => `${key}: ${element.styles[key]}`);
  if (styles.length) lines.push(`   styles: ${styles.join("; ")}`);
  const rules = element.rules.filter((rule) => rule.selector !== "style attribute").slice(-3);
  if (rules.length) lines.push(`   rules: ${rules.map((rule) => `${rule.selector}${rule.source && rule.source !== "inline" ? ` (${rule.source})` : ""}`).join(", ")}`);
  if (element.text && element.text !== element.name) lines.push(`   text: "${element.text.slice(0, 100)}"`);
  if (element.crop?.path) lines.push(`   image: ${element.crop.path}`);
  return lines.join("\n");
}

function where(inspection: Pick<PointInspection, "url" | "tabId">): string {
  return `${inspection.url} (tab ${inspection.tabId})`;
}

/**
 * Everything known about picked elements, for the file the text names:
 * every style and the declarations of each CSS rule, all source hints and
 * candidates, the search hints. Image bytes stay out; images are files of
 * their own.
 */
export function pickDetails(inspection: PointInspection): Record<string, unknown> {
  const { regions: _regions, missing, ...page } = inspection;
  return {
    ...page,
    elements: inspection.elements.map(({ crop, ...element }) => ({ ...element, ...(crop?.path ? { image: crop.path } : {}) })),
    ...(missing.length ? { missing } : {}),
  };
}

/** The text sent for picked elements. Files are listed by the delivery service after it. */
export function formatPickText(inspection: PointInspection, note: string, options: { detailsPath?: string | null } = {}): string {
  const count = inspection.elements.length;
  const head = `[Codara] ${count === 1 ? "Picked element" : `Picked ${count} elements`} on ${where(inspection)}`;
  const parts = [head];
  if (note.trim()) parts.push(`Note: ${note.trim()}`);
  parts.push(inspection.elements.map((element, i) => formatElementBlock(element, i + 1)).join("\n"));
  if (options.detailsPath) parts.push(`Every style, CSS rule and source candidate: ${options.detailsPath}`);
  parts.push(`Use tabId "${inspection.tabId}" and the refs above with the codara_preview tools (or \`cora tool\`); refs last until the page reloads.`);
  return plainTerminalText(parts.join("\n\n"));
}

function annotationLine(annotation: PointAnnotation, scroll: { x: number; y: number }): string {
  if (annotation.kind === "arrow" && annotation.from && annotation.to) {
    return `arrow from page ${round(annotation.from.x + scroll.x)},${round(annotation.from.y + scroll.y)} to ${round(annotation.to.x + scroll.x)},${round(annotation.to.y + scroll.y)}`;
  }
  const kind = annotation.kind === "pen" ? "drawing" : "box";
  return `${kind} at page ${round(annotation.x + scroll.x)},${round(annotation.y + scroll.y)} size ${round(annotation.width)}x${round(annotation.height)} (viewport ${round(annotation.x)},${round(annotation.y)})`;
}

/**
 * The text sent for comments drawn on the page: each mark's place, its note
 * and the elements under it. `scroll` is the page scroll when the marks were
 * drawn, which turns viewport positions into page positions.
 */
export function formatCommentText(
  inspection: Pick<PointInspection, "url" | "tabId" | "regions" | "viewport">,
  annotations: readonly PointAnnotation[],
  note: string,
  scroll: { x: number; y: number },
  options: { frozen?: boolean } = {},
): string {
  const count = annotations.length;
  const head = `[Codara] ${count === 1 ? "1 comment" : `${count} comments`} on ${where(inspection)}; the annotated screenshot is attached (numbers match the list${options.frozen ? ", drawn on a frozen screenshot" : ""}).`;
  const parts = [head];
  if (note.trim()) parts.push(`Note: ${note.trim()}`);
  const blocks = annotations.map((annotation, i) => {
    const lines = [`${i + 1}. ${annotation.note.trim() ? `"${annotation.note.trim()}"` : "(no note)"}; ${annotationLine(annotation, scroll)}`];
    const region = inspection.regions.find((hit) => hit.index === i);
    const elements = region?.elements ?? [];
    for (const element of elements.slice(0, 3)) {
      const source = element.source ? `, ${sourceLabel(element.source)}` : "";
      const components = element.components.length ? `, <${element.components.at(-1)}>` : "";
      lines.push(`   ${element.contains ? "in" : "has"} ${elementLabel(element)} ${element.ref} ${element.selector}${source}${components}`);
    }
    if (region && !elements.length) lines.push("   (no element under it is on screen now)");
    return lines.join("\n");
  });
  parts.push(blocks.join("\n"));
  parts.push(`Viewport ${inspection.viewport.width}x${inspection.viewport.height} CSS px. Use tabId "${inspection.tabId}" with the codara_preview tools.`);
  return plainTerminalText(parts.join("\n\n"));
}

export interface TabReference {
  tabId: string;
  url: string;
  title?: string;
  /** Who drives the tab: an agent pane, a Cora run, or the user. */
  session?: string | null;
  workspace?: string | null;
}

export function formatTabReference(tab: TabReference): string {
  const lines = [`tabId: ${tab.tabId}`, `url: ${tab.url || "(blank)"}`];
  if (tab.title) lines.push(`title: ${tab.title}`);
  if (tab.session) lines.push(`session: ${tab.session}`);
  if (tab.workspace) lines.push(`workspace: ${tab.workspace}`);
  lines.push(`Pass "tabId": "${tab.tabId}" to any codara_preview tool, or --tabId ${tab.tabId} to \`cora tool\`.`);
  return plainTerminalText(lines.join("\n"));
}
