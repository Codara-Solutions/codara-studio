// Guards workflow result schemas (src/main/orchestration/workflow-schema.ts):
// the root and `required` checks that make a schema usable as the worker's
// submit_result parameter, main-side validation of the untrusted report, and
// the sample generator the dry-run estimate feeds to scripts.
//
//   node scripts/test-workflow-schema.cjs

const { bundleModule, check, finish } = require("./workflow-test-harness.cjs");

async function main() {
  const schemaMod = await bundleModule("workflow-schema.ts");
  const { checkResultSchema, validateWorkflowResult, sampleFromSchema, jsonSize } = schemaMod;

  const BUGS = {
    type: "object",
    properties: {
      bugs: {
        type: "array",
        items: {
          type: "object",
          properties: {
            file: { type: "string" },
            severity: { enum: ["low", "high"] },
            line: { type: "integer", minimum: 1 },
          },
          required: ["file", "severity"],
        },
      },
      summary: { type: "string" },
    },
    required: ["bugs"],
  };

  check("a well-formed schema passes", checkResultSchema(BUGS).ok === true);
  check("a non-object root is refused", /root must be/.test(checkResultSchema({ type: "array" }).error));
  check("a root without properties is refused", /root must be/.test(checkResultSchema({ type: "object" }).error));
  check("required naming an undefined property is refused", /bugz/.test(checkResultSchema({ type: "object", properties: { a: {} }, required: ["bugz"] }).error));
  check("a schema that does not compile is refused", /invalid schema/.test(checkResultSchema({ type: "object", properties: { a: { type: "nonsense" } } }).error));
  check("a schema over 32 KB is refused", /larger than 32 KB/.test(checkResultSchema({ type: "object", properties: { a: { description: "x".repeat(40_000) } } }).error));
  check("a non-object is refused", checkResultSchema("string").ok === false);

  check("a valid result validates", validateWorkflowResult(BUGS, { bugs: [{ file: "a.ts", severity: "high" }] }).ok === true);
  const missing = validateWorkflowResult(BUGS, {});
  check("a missing required property is named", !missing.ok && missing.errors.some((e) => /bugs: is required/.test(e)), missing);
  const nested = validateWorkflowResult(BUGS, { bugs: [{ file: "a.ts", severity: "medium" }] });
  check("a nested enum error names its path", !nested.ok && nested.errors.some((e) => /bugs\.0\.severity: must be one of/.test(e)), nested);

  const sample = sampleFromSchema(BUGS);
  check("the sample satisfies its schema", validateWorkflowResult(BUGS, sample).ok === true, sample);
  check("top-level arrays get two items", sample.bugs.length === 2);
  check("enums take their first value", sample.bugs[0].severity === "low");
  check("minimum is honored", sample.bugs[0].line === 1);
  const deep = sampleFromSchema({ type: "object", properties: { outer: { type: "object", properties: { inner: { type: "array", items: { type: "string" } } } } } });
  check("nested arrays come back empty so dry-run loops end", Array.isArray(deep.outer.inner) && deep.outer.inner.length === 0, deep);
  check("oneOf takes its first option", sampleFromSchema({ oneOf: [{ type: "boolean" }, { type: "string" }] }) === true);
  check("const wins", sampleFromSchema({ type: "string", const: "fixed" }) === "fixed");
  check("jsonSize counts bytes", jsonSize({ a: "é" }) === Buffer.byteLength('{"a":"é"}'));
  const cyclic = {};
  cyclic.self = cyclic;
  check("jsonSize of a cycle is infinite", jsonSize(cyclic) === Infinity);
}

main()
  .catch((err) => {
    check("suite crashed", false, err && err.stack ? err.stack : String(err));
  })
  .finally(finish);
