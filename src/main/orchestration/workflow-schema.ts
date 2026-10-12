// Result schemas for workflow agent() calls. The caller's schema becomes the
// `result` property of the worker's submit_result tool, so Pi rejects a bad
// result inside the worker's own turn; main validates again here because the
// report file on disk is untrusted.

import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";

import { WORKFLOW_HARD_LIMITS } from "@shared/workflow";

const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
const compiled = new Map<string, ValidateFunction>();
const COMPILED_CACHE_LIMIT = 256;

export type SchemaCheck =
  | { ok: true; schema: Record<string, unknown>; canonical: string }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function checkResultSchema(schema: unknown): SchemaCheck {
  if (!isRecord(schema)) return { ok: false, error: "schema must be a JSON Schema object" };
  let canonical: string;
  try {
    canonical = JSON.stringify(schema);
  } catch {
    return { ok: false, error: "schema must be plain JSON" };
  }
  if (canonical.length > WORKFLOW_HARD_LIMITS.schemaBytes) {
    return { ok: false, error: `schema is larger than ${WORKFLOW_HARD_LIMITS.schemaBytes / 1024} KB` };
  }
  if (schema.type !== "object" || !isRecord(schema.properties)) {
    return { ok: false, error: "schema root must be {type: 'object', properties: {...}}" };
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== "string")) {
      return { ok: false, error: "schema.required must be an array of property names" };
    }
    const missing = (schema.required as string[]).filter(
      (key) => !Object.prototype.hasOwnProperty.call(schema.properties, key),
    );
    if (missing.length > 0) {
      return { ok: false, error: `schema.required names properties the schema does not define: ${missing.join(", ")}` };
    }
  }
  try {
    compile(canonical, schema);
  } catch (err) {
    return { ok: false, error: `invalid schema: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true, schema, canonical };
}

function compile(canonical: string, schema: Record<string, unknown>): ValidateFunction {
  const hit = compiled.get(canonical);
  if (hit) return hit;
  const validate = ajv.compile(schema);
  if (compiled.size >= COMPILED_CACHE_LIMIT) {
    const oldest = compiled.keys().next().value;
    if (oldest !== undefined) compiled.delete(oldest);
  }
  compiled.set(canonical, validate);
  return validate;
}

function formatError(error: ErrorObject): string {
  const path = error.instancePath ? error.instancePath.replace(/^\//, "").replace(/\//g, ".") : "result";
  if (error.keyword === "required" && typeof error.params.missingProperty === "string") {
    return `${path === "result" ? "" : `${path}.`}${error.params.missingProperty}: is required`;
  }
  if (error.keyword === "additionalProperties" && typeof error.params.additionalProperty === "string") {
    return `${path}: unexpected property ${error.params.additionalProperty}`;
  }
  if (error.keyword === "enum" && Array.isArray(error.params.allowedValues)) {
    return `${path}: must be one of ${error.params.allowedValues.map((v: unknown) => JSON.stringify(v)).join(", ")}`;
  }
  return `${path}: ${error.message ?? "is invalid"}`;
}

export function validateWorkflowResult(
  schema: Record<string, unknown>,
  value: unknown,
): { ok: true } | { ok: false; errors: string[] } {
  let validate: ValidateFunction;
  try {
    validate = compile(JSON.stringify(schema), schema);
  } catch (err) {
    return { ok: false, errors: [`schema does not compile: ${err instanceof Error ? err.message : String(err)}`] };
  }
  if (validate(value)) return { ok: true };
  const errors = (validate.errors ?? []).slice(0, 12).map(formatError);
  return { ok: false, errors: errors.length > 0 ? errors : ["result does not match the schema"] };
}

/** Bytes of the value's JSON, or Infinity when it cannot be serialized. */
export function jsonSize(value: unknown): number {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? 0 : Buffer.byteLength(text, "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

// A deterministic value that satisfies the common shapes of a schema. The dry
// run feeds these to the script instead of real results, so a loop that ends
// when an agent reports nothing new ends in the estimate too: arrays get two
// items at the top level and none below it.
export function sampleFromSchema(schema: unknown, depth = 0, topArrayItems = 2): unknown {
  if (!isRecord(schema)) return "sample";
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (schema.default !== undefined) return schema.default;
  for (const key of ["oneOf", "anyOf"] as const) {
    const options = schema[key];
    if (Array.isArray(options) && options.length > 0) return sampleFromSchema(options[0], depth + 1, topArrayItems);
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    const merged: Record<string, unknown> = {};
    for (const part of schema.allOf) {
      const sample = sampleFromSchema(part, depth + 1, topArrayItems);
      if (isRecord(sample)) Object.assign(merged, sample);
    }
    return merged;
  }
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type;
  switch (type) {
    case "object": {
      const out: Record<string, unknown> = {};
      const props = isRecord(schema.properties) ? schema.properties : {};
      for (const [key, sub] of Object.entries(props)) {
        if (depth > 6) break;
        out[key] = sampleFromSchema(sub, depth + 1, topArrayItems);
      }
      return out;
    }
    case "array": {
      const minItems = typeof schema.minItems === "number" ? schema.minItems : 0;
      const count = Math.max(minItems, depth <= 1 ? topArrayItems : 0);
      return Array.from({ length: Math.min(count, 4) }, () => sampleFromSchema(schema.items, depth + 1, topArrayItems));
    }
    case "string":
      return "sample";
    case "integer":
    case "number":
      return typeof schema.minimum === "number" ? schema.minimum : 1;
    case "boolean":
      return true;
    case "null":
      return null;
    default:
      return isRecord(schema.properties) ? sampleFromSchema({ ...schema, type: "object" }, depth, topArrayItems) : "sample";
  }
}
