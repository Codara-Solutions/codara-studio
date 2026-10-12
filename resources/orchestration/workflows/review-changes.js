export const meta = {
  name: "review-changes",
  description: "Find bugs in the current branch's changes, then have skeptics verify each one",
  whenToUse: "Before opening a pull request, or after a large change",
  args: {
    type: "object",
    properties: {
      base: { type: "string", description: "Branch or commit to diff against (default: main)" },
    },
  },
  phases: [
    { title: "Find", detail: "one reviewer per dimension" },
    { title: "Verify", detail: "two skeptics per finding" },
  ],
  caps: { maxAgents: 60, concurrency: 4 },
};

const base = (args && args.base) || "main";
const DIMENSIONS = [
  "correctness and logic errors",
  "error handling and edge cases",
  "concurrency, ordering and state bugs",
  "security: injection, secrets, unsafe input",
  "tests that no longer cover the changed behavior",
];

const FINDINGS = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          line: { type: "integer" },
          title: { type: "string" },
          why: { type: "string" },
        },
        required: ["file", "title", "why"],
      },
    },
  },
  required: ["findings"],
};

const VERDICT = {
  type: "object",
  properties: {
    real: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["real", "reason"],
};

phase("Find");
const found = await parallel(DIMENSIONS.map((dimension) => () =>
  agent(
    `Review the changes in \`git diff ${base}...HEAD\` for ${dimension} only. ` +
      "Report concrete bugs you can point to in the diff, with file and line. Report nothing you cannot justify from the code.",
    { label: `find: ${dimension.split(":")[0]}`, schema: FINDINGS, access: "readonly" },
  )));

const findings = [];
for (const result of found) {
  for (const finding of (result && result.findings) || []) findings.push(finding);
}
log(`${findings.length} candidate findings`);

phase("Verify");
const verdicts = await parallel(findings.map((finding, index) => () =>
  parallel([0, 1].map((skeptic) => () =>
    agent(
      `A reviewer claims this bug in \`git diff ${base}...HEAD\`:\n` +
        `${finding.file}${finding.line ? `:${finding.line}` : ""}: ${finding.title}\n${finding.why}\n\n` +
        "Be skeptical. Read the code and decide whether it is a real bug that a user or caller can hit.",
      { label: `verify #${index + 1}.${skeptic + 1}`, schema: VERDICT, agentType: "verifier" },
    )))));

const confirmed = findings.filter((finding, index) => {
  const votes = (verdicts[index] || []).filter((verdict) => verdict && verdict.real);
  return votes.length === 2;
});
log(`${confirmed.length} confirmed by both skeptics`);
return { confirmed, candidates: findings.length };
