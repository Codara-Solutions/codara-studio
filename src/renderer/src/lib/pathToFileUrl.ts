// Convert an absolute OS path (Windows drive letters included) into an
// encoded file:// URL. Single shared implementation — used by the web
// preview pane, the explorer's "Open in Preview", and the file previewers.
// encodeURI leaves "#" and "?" alone; in a path they are characters of the
// name, never a fragment or a query.
export function pathToFileUrl(osPath: string): string {
  if (!osPath) return osPath;
  if (/^file:\/\//i.test(osPath)) return osPath;
  // A ssh:// remote path has no file:// form — the previewers load remote
  // bytes over IPC into a blob URL instead (never call this for remote).
  if (/^ssh:\/\//i.test(osPath)) return osPath;
  const normalized = osPath.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(normalized)) {
    return `file:///${encodeURI(normalized).replace(/[#?]/g, encodeURIComponent)}`;
  }
  if (normalized.startsWith("/")) {
    return `file://${encodeURI(normalized).replace(/[#?]/g, encodeURIComponent)}`;
  }
  return `file:///${encodeURI(normalized).replace(/[#?]/g, encodeURIComponent)}`;
}
