// Does a Quick Open query spell a path rather than a name? Shared because the
// renderer picks the list to show from this and main resolves the same text.

import { isRemotePath } from "./remote";

export const MAX_PATH_QUERY_LENGTH = 4096;

// "~user" and ".env" stay names: the first is rarely a path here and the
// second is how hidden files are found by name.
const PATH_QUERY_RE = /^(?:~(?:\/|$)|\/|\.{1,2}\/)/;

export function isPathQuery(raw: string, cwd: string | null): boolean {
  const query = raw.trimStart();
  if (!PATH_QUERY_RE.test(query) || query.length > MAX_PATH_QUERY_LENGTH || query.includes("\0")) return false;
  // "./" means the workspace folder, which a remote workspace has on another
  // computer; the listing runs on this one.
  return !query.startsWith(".") || (Boolean(cwd) && !isRemotePath(cwd));
}
