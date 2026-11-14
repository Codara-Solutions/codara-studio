import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";

/**
 * Read a small file synchronously, for code that runs before app ready.
 * A plain readFileSync blocks the process for good on a named pipe (or a link
 * to one), and a device or huge file stalls it. Opened non-blocking, so a pipe
 * opens at once; the open handle is then checked, so a path swapped between a
 * stat and the read cannot slip through. Throws on anything that is not a
 * regular file of at most maxBytes, like any other read error.
 */
export function readRegularFileSync(path: string, maxBytes: number): string {
  // Windows has no O_NONBLOCK, and no named pipes in the file system either.
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw Object.assign(new Error(`not a regular file: ${path}`), { code: "ENOTREGULAR" });
    if (stat.size > maxBytes) throw Object.assign(new Error(`larger than ${maxBytes} bytes: ${path}`), { code: "EFBIG" });
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}
