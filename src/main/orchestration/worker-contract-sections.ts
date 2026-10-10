// The worker-prompt sections a worker cannot finish without: acceptance,
// expected outputs, verification, and the final-report contract that
// worker-prompt.ts renders into prompt.md.
//
// A Pi worker that crosses the context threshold compacts, and the LLM-written
// summary may drop them. The continuation and the finalize re-prompt in
// run-store's runPiWorkerSession re-send them verbatim from the original
// prompt instead of pointing at text the session no longer holds.
//
// Pure, so scripts/test-pi-worker-compaction.cjs can load it directly.

const CONTRACT_SECTION_TITLES = new Set([
  "FINAL REPORT",
  "FINISH",
  "ACCEPTANCE",
  "ACCEPTANCE CRITERIA",
  "EXPECTED OUTPUTS",
  "IMPLEMENTATION WORKER'S EXPECTED OUTPUTS",
  "VERIFICATION",
  "VERIFICATION TASK",
  "VERIFICATION COMMANDS",
  "VERIFY",
  "SELF-CHECK",
  "SPEC EXACTNESS",
  "PIPELINE OUTPUT",
  "BOUNDARIES",
]);
const REPORT_SECTION_TITLES = new Set(["FINAL REPORT", "FINISH"]);

function promptSections(promptText: string): Array<{ key: string; text: string }> {
  const sections: Array<{ key: string; text: string }> = [];
  let current: { key: string; lines: string[] } | null = null;
  for (const line of promptText.split("\n")) {
    const heading = /^## (.+)$/.exec(line);
    if (heading) {
      if (current) sections.push({ key: current.key, text: current.lines.join("\n").trim() });
      current = { key: heading[1].replace(/\s*\(.*$/, "").trim().toUpperCase(), lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push({ key: current.key, text: current.lines.join("\n").trim() });
  return sections;
}

/** The FINAL REPORT (or direct-lane FINISH) section, verbatim. */
export function workerReportSection(promptText: string): string {
  return promptSections(promptText)
    .filter((section) => REPORT_SECTION_TITLES.has(section.key))
    .map((section) => section.text)
    .join("\n\n");
}

/**
 * The contract sections of a worker prompt, report first, capped so a
 * continuation prompt cannot by itself push the session back over the
 * compaction threshold.
 */
export function workerContractSections(promptText: string, maxChars = 12_000): string {
  const sections = promptSections(promptText).filter((section) => CONTRACT_SECTION_TITLES.has(section.key));
  const ordered = [
    ...sections.filter((section) => REPORT_SECTION_TITLES.has(section.key)),
    ...sections.filter((section) => !REPORT_SECTION_TITLES.has(section.key)),
  ];
  const kept: string[] = [];
  let used = 0;
  for (const section of ordered) {
    if (used + section.text.length + 2 > maxChars) continue;
    kept.push(section.text);
    used += section.text.length + 2;
  }
  return kept.join("\n\n");
}
