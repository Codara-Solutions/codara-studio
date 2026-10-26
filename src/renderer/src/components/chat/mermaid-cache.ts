// Drawn Mermaid diagrams by source. A streamed reply's pieces can merge (a definition shows up, the turn
// settles), which remounts the diagrams below; a remount reuses the drawing
// so the diagram does not blank to "Rendering diagram" and jump in height.
export const MERMAID_CACHE_LIMIT = 32;
const mermaidCache = new Map<string, { id: string; svg: string }>();

export function cachedMermaidSvg(source: string, id: string): string {
  const entry = mermaidCache.get(source);
  if (!entry) return "";
  mermaidCache.delete(source);
  mermaidCache.set(source, entry);
  // The drawing's styles and markers are scoped by its render id.
  return entry.svg.split(entry.id).join(id);
}

export function rememberMermaidSvg(source: string, id: string, svg: string) {
  mermaidCache.delete(source);
  mermaidCache.set(source, { id, svg });
  const oldest = mermaidCache.keys().next().value;
  if (mermaidCache.size > MERMAID_CACHE_LIMIT && oldest !== undefined) mermaidCache.delete(oldest);
}
