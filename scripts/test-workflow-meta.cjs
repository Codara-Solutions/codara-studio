// Guards the workflow meta reader (src/main/orchestration/workflow-meta.ts):
// listing saved workflows and drawing the consent card read `meta` without
// running the script, so the reader must accept only a literal and refuse
// anything that would need evaluation.
//
//   node scripts/test-workflow-meta.cjs

const { bundleModule, check, finish } = require("./workflow-test-harness.cjs");

async function main() {
  const { parseWorkflowSource, readWorkflowMeta } = await bundleModule("workflow-meta.ts");

  const throwsWith = (source, pattern) => {
    try {
      parseWorkflowSource(source);
      return "accepted";
    } catch (err) {
      return pattern.test(err.message) ? true : err.message;
    }
  };

  {
    const source = `#!/usr/bin/env cora
// A review workflow.
export const meta = {
  name: 'review-changes',
  description: "Find bugs",
  whenToUse: \`Before a pull request\`,
  phases: [
    { title: 'Find', detail: 'one per dimension', },
    { title: "Verify", model: 'claude-sonnet-5' },
  ],
  caps: { maxAgents: 120, concurrency: 6 },
  args: { type: 'object', properties: { base: { type: 'string' } } },
};

return 1;
`;
    const parsed = parseWorkflowSource(source);
    check("reads name and description", parsed.meta.name === "review-changes" && parsed.meta.description === "Find bugs");
    check("reads backtick strings without interpolation", parsed.meta.whenToUse === "Before a pull request");
    check("reads phases with trailing commas", parsed.meta.phases.length === 2 && parsed.meta.phases[1].model === "claude-sonnet-5", parsed.meta.phases);
    check("reads caps", parsed.meta.caps.maxAgents === 120 && parsed.meta.caps.concurrency === 6);
    check("reads an args schema", parsed.meta.args.properties.base.type === "string");
    check("the body keeps every line", parsed.body.split("\n").length === source.split("\n").length);
    check("the meta statement is blanked", !/export|review-changes/.test(parsed.body));
    check("the code after meta is kept", /return 1;/.test(parsed.body));
    check("the shebang is blanked", !parsed.body.startsWith("#!"));
  }

  check("rejects a missing meta", throwsWith(`return 1;`, /must start with `export const meta/));
  check("rejects meta that is not first", throwsWith(`const x = 1;\nexport const meta = { name: "a", description: "b" };`, /must start with/));
  check("rejects an identifier value", throwsWith(`export const meta = { name: NAME, description: "b" };`, /line 1/));
  check("rejects a call", throwsWith(`export const meta = { name: make(), description: "b" };`, /line/));
  check("rejects a spread", throwsWith(`export const meta = { ...base, name: "a", description: "b" };`, /line/));
  check("rejects interpolation", throwsWith("export const meta = { name: `a${x}`, description: 'b' };", /line/));
  check("rejects a computed key", throwsWith(`export const meta = { ["name"]: "a", description: "b" };`, /line/));
  check("rejects __proto__", throwsWith(`export const meta = { __proto__: {}, name: "a", description: "b" };`, /__proto__/));
  check("rejects a bad name", throwsWith(`export const meta = { name: "Has Spaces", description: "b" };`, /name/));
  check("requires a description", throwsWith(`export const meta = { name: "ok" };`, /description/));
  check("names the line of an error", throwsWith(`// one\n// two\nexport const meta = {\n  name: "a",\n  description: oops,\n};`, /line 5/));
  check("readWorkflowMeta returns the meta only", readWorkflowMeta(`export const meta = { name: "x", description: "y" }`).name === "x");
}

main()
  .catch((err) => {
    check("suite crashed", false, err && err.stack ? err.stack : String(err));
  })
  .finally(finish);
