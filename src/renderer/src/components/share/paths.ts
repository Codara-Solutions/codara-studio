// Path arithmetic for the Share packager. The renderer has no node:path, and
// the packager must decide which local files a page may pull in without
// touching the disk, so these helpers are lexical and work on POSIX and
// Windows paths alike (separators are normalized to "/").

export function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, "/");
}

const WINDOWS_DRIVE = /^[a-zA-Z]:\//;

export function isAbsoluteFsPath(p: string): boolean {
  const n = normalizeSlashes(p);
  return n.startsWith("/") || WINDOWS_DRIVE.test(n);
}

export function dirnameOf(p: string): string {
  const n = normalizeSlashes(p);
  const slash = n.lastIndexOf("/");
  if (slash < 0) return "";
  if (slash === 0) return "/";
  if (slash === 2 && WINDOWS_DRIVE.test(n)) return n.slice(0, 3);
  return n.slice(0, slash);
}

export function basenameOf(p: string): string {
  const n = normalizeSlashes(p).replace(/\/+$/, "");
  return n.slice(n.lastIndexOf("/") + 1);
}

// Collapses "." and ".." segments of an absolute path. A ".." above the root
// stays at the root, as the OS would resolve it.
export function normalizeAbsolute(p: string): string {
  const n = normalizeSlashes(p);
  const drive = WINDOWS_DRIVE.test(n) ? n.slice(0, 2) : "";
  const rest = drive ? n.slice(2) : n;
  const out: string[] = [];
  for (const seg of rest.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `${drive}/${out.join("/")}`;
}

export function resolveFrom(baseDir: string, ref: string): string {
  const n = normalizeSlashes(ref);
  if (isAbsoluteFsPath(n)) return normalizeAbsolute(n);
  return normalizeAbsolute(`${normalizeSlashes(baseDir)}/${n}`);
}

function comparable(p: string): string {
  const n = normalizeAbsolute(p);
  // Windows paths compare without case, like the file system does.
  return WINDOWS_DRIVE.test(n) ? n.toLowerCase() : n;
}

export function isInsideDir(root: string, target: string): boolean {
  const r = comparable(root).replace(/\/+$/, "");
  const t = comparable(target);
  return t === r || t.startsWith(`${r}/`) || r === "";
}

/** Path relative to `root` for display, or the full path when it is outside. */
export function relativeTo(root: string, target: string): string {
  const r = normalizeAbsolute(root).replace(/\/+$/, "");
  const t = normalizeAbsolute(target);
  return t.startsWith(`${r}/`) ? t.slice(r.length + 1) : t;
}

/** `target` as seen from `fromDir`, with ".." steps; the full path across drives. */
export function relativePath(fromDir: string, target: string): string {
  const from = normalizeAbsolute(fromDir).split("/").filter(Boolean);
  const to = normalizeAbsolute(target).split("/").filter(Boolean);
  if (WINDOWS_DRIVE.test(`${from[0] ?? ""}/`) && from[0]?.toLowerCase() !== to[0]?.toLowerCase()) {
    return normalizeAbsolute(target);
  }
  let common = 0;
  while (common < from.length && common < to.length && from[common] === to[common]) common += 1;
  return [...from.slice(common).map(() => ".."), ...to.slice(common)].join("/");
}
