// Electron prefixes an error thrown in a main-process handler with
// "Error invoking remote method 'channel': Error: ". The user reads only the
// message main wrote.
export function shareErrorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const message = raw.replace(/^Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)?/, "").trim();
  return message || "Something went wrong. Try again.";
}
