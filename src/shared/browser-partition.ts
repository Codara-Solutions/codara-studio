// The only browser partition a Codara tab may run in besides the default
// session that holds the user's logins: a logged-out tab's own temporary
// one. The name has no `persist:` prefix, so Electron keeps it in memory and
// nothing the page stores reaches disk.

export const FRESH_PARTITION_PREFIX = "codara-fresh-";
const FRESH_PARTITION = /^codara-fresh-[a-f0-9]{12}$/;

export function isFreshPartition(value: unknown): value is string {
  return typeof value === "string" && FRESH_PARTITION.test(value);
}
