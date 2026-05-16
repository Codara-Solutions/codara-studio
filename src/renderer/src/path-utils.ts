export function basename(p: string): string {
  if (!p) return "";
  // strip trailing slashes/backslashes
  const trimmed = p.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

// dirname returns the parent directory of a path, working with either slash
// style. A Windows drive root is kept whole ("C:\\foo" -> "C:\\"), and a path
// with no separator (or a leading-only separator) is returned unchanged so
// callers never walk above the value they were given.
export function dirname(path: string): string {
  const idx = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  if (idx === 2 && path[1] === ":") return path.slice(0, 3);
  return idx > 0 ? path.slice(0, idx) : path;
}
