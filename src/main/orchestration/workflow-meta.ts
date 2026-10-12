// Reads a workflow script's literal `export const meta = {...}` header without
// running any code, so listing, checking and the consent card never execute a
// script. Pure: no Node, no Electron.

import type { WorkflowMeta, WorkflowPhaseMeta } from "@shared/workflow";

export class WorkflowSourceError extends Error {
  readonly line: number | undefined;
  constructor(message: string, line?: number) {
    super(line ? `line ${line}: ${message}` : message);
    this.name = "WorkflowSourceError";
    this.line = line;
  }
}

export interface ParsedWorkflowSource {
  meta: WorkflowMeta;
  /**
   * The script with the meta statement blanked to spaces. Newlines are kept,
   * so a line number the sandbox reports is the line in the original file.
   */
  body: string;
}

const MAX_SOURCE_BYTES = 512 * 1024;
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function parseWorkflowSource(source: string): ParsedWorkflowSource {
  if (typeof source !== "string" || !source.trim()) {
    throw new WorkflowSourceError("The workflow script is empty.");
  }
  if (source.length > MAX_SOURCE_BYTES) {
    throw new WorkflowSourceError(`The workflow script is larger than ${MAX_SOURCE_BYTES / 1024} KB.`);
  }
  const reader = new LiteralReader(source);
  reader.skipTrivia();
  const start = reader.pos;
  if (!reader.matchWord("export")) {
    throw new WorkflowSourceError(
      "A workflow must start with `export const meta = { ... }` (comments may come first).",
      reader.line(),
    );
  }
  reader.skipTrivia();
  if (!reader.matchWord("const")) {
    throw new WorkflowSourceError("Expected `const meta = { ... }` after `export`.", reader.line());
  }
  reader.skipTrivia();
  if (!reader.matchWord("meta")) {
    throw new WorkflowSourceError("The first export must be named `meta`.", reader.line());
  }
  reader.skipTrivia();
  if (!reader.matchChar("=")) {
    throw new WorkflowSourceError("Expected `=` after `export const meta`.", reader.line());
  }
  reader.skipTrivia();
  if (reader.peek() !== "{") {
    throw new WorkflowSourceError("`meta` must be an object literal.", reader.line());
  }
  const value = reader.readValue();
  const afterValue = reader.pos;
  reader.skipInlineTrivia();
  if (reader.peek() === ";") reader.pos += 1;
  else reader.pos = afterValue;
  const end = reader.pos;
  const meta = validateMeta(value, reader.lineAt(start));
  const blank = (text: string) => text.replace(/[^\n]/g, " ");
  const prefix = source.startsWith("#!")
    ? blank(source.slice(0, source.indexOf("\n") === -1 ? source.length : source.indexOf("\n"))) +
      source.slice(source.indexOf("\n") === -1 ? source.length : source.indexOf("\n"), start)
    : source.slice(0, start);
  return { meta, body: prefix + blank(source.slice(start, end)) + source.slice(end) };
}

/** Meta only; the body is not needed for listing. */
export function readWorkflowMeta(source: string): WorkflowMeta {
  return parseWorkflowSource(source).meta;
}

function validateMeta(value: unknown, line: number): WorkflowMeta {
  if (!isRecord(value)) throw new WorkflowSourceError("`meta` must be an object.", line);
  const name = value.name;
  if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
    throw new WorkflowSourceError(
      "`meta.name` must be a lowercase name of letters, digits, '.', '-' or '_' (at most 64 characters).",
      line,
    );
  }
  const description = value.description;
  if (typeof description !== "string" || !description.trim()) {
    throw new WorkflowSourceError("`meta.description` is required.", line);
  }
  const meta: WorkflowMeta = { name, description: description.trim() };
  if (value.whenToUse !== undefined) {
    if (typeof value.whenToUse !== "string") {
      throw new WorkflowSourceError("`meta.whenToUse` must be a string.", line);
    }
    meta.whenToUse = value.whenToUse.trim();
  }
  if (value.args !== undefined) {
    if (!isRecord(value.args)) throw new WorkflowSourceError("`meta.args` must be a JSON Schema object.", line);
    meta.args = value.args;
  }
  if (value.phases !== undefined) {
    if (!Array.isArray(value.phases)) throw new WorkflowSourceError("`meta.phases` must be an array.", line);
    meta.phases = value.phases.map((phase, index): WorkflowPhaseMeta => {
      if (!isRecord(phase) || typeof phase.title !== "string" || !phase.title.trim()) {
        throw new WorkflowSourceError(`\`meta.phases[${index}]\` needs a title.`, line);
      }
      const out: WorkflowPhaseMeta = { title: phase.title.trim() };
      if (typeof phase.detail === "string" && phase.detail.trim()) out.detail = phase.detail.trim();
      if (typeof phase.model === "string" && phase.model.trim()) out.model = phase.model.trim();
      return out;
    });
  }
  if (value.caps !== undefined) {
    if (!isRecord(value.caps)) throw new WorkflowSourceError("`meta.caps` must be an object.", line);
    const caps: NonNullable<WorkflowMeta["caps"]> = {};
    for (const key of ["maxAgents", "concurrency"] as const) {
      const raw = value.caps[key];
      if (raw === undefined) continue;
      if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
        throw new WorkflowSourceError(`\`meta.caps.${key}\` must be a positive integer.`, line);
      }
      caps[key] = raw;
    }
    meta.caps = caps;
  }
  return meta;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// A JSON5-like subset: objects, arrays, single, double and backtick strings
// without interpolation, numbers, true, false, null, identifier keys and
// trailing commas. Anything else (a variable, a call, a spread) is refused,
// because evaluating it would mean running the script.
class LiteralReader {
  pos = 0;
  constructor(private readonly text: string) {}

  peek(): string {
    return this.text[this.pos] ?? "";
  }

  line(): number {
    return this.lineAt(this.pos);
  }

  lineAt(offset: number): number {
    let line = 1;
    for (let i = 0; i < offset && i < this.text.length; i += 1) if (this.text[i] === "\n") line += 1;
    return line;
  }

  fail(message: string): never {
    throw new WorkflowSourceError(message, this.line());
  }

  skipTrivia(): void {
    for (;;) {
      const ch = this.peek();
      if (ch === "") return;
      if (/\s/.test(ch)) {
        this.pos += 1;
        continue;
      }
      if (this.text.startsWith("//", this.pos)) {
        const end = this.text.indexOf("\n", this.pos);
        this.pos = end === -1 ? this.text.length : end + 1;
        continue;
      }
      if (this.text.startsWith("/*", this.pos)) {
        const end = this.text.indexOf("*/", this.pos + 2);
        if (end === -1) this.fail("Unterminated comment.");
        this.pos = end + 2;
        continue;
      }
      if (this.pos === 0 && this.text.startsWith("#!")) {
        const end = this.text.indexOf("\n");
        this.pos = end === -1 ? this.text.length : end + 1;
        continue;
      }
      return;
    }
  }

  skipInlineTrivia(): void {
    while (this.peek() === " " || this.peek() === "\t") this.pos += 1;
  }

  matchWord(word: string): boolean {
    if (!this.text.startsWith(word, this.pos)) return false;
    const next = this.text[this.pos + word.length] ?? "";
    if (/[A-Za-z0-9_$]/.test(next)) return false;
    this.pos += word.length;
    return true;
  }

  matchChar(ch: string): boolean {
    if (this.peek() !== ch) return false;
    this.pos += 1;
    return true;
  }

  readValue(): unknown {
    this.skipTrivia();
    const ch = this.peek();
    if (ch === "{") return this.readObject();
    if (ch === "[") return this.readArray();
    if (ch === "'" || ch === '"' || ch === "`") return this.readString();
    if (ch === "-" || ch === "+" || ch === "." || /[0-9]/.test(ch)) return this.readNumber();
    if (this.matchWord("true")) return true;
    if (this.matchWord("false")) return false;
    if (this.matchWord("null")) return null;
    if (ch === "") this.fail("`meta` ends before its value is complete.");
    if (this.text.startsWith("...", this.pos)) this.fail("Spread syntax is not allowed in `meta`; write the values out.");
    const word = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(this.text.slice(this.pos))?.[0];
    if (word) {
      this.fail(`\`meta\` must be a plain literal; \`${word}\` is a variable or call. Write the value out.`);
    }
    this.fail(`Unexpected \`${ch}\` in \`meta\`.`);
  }

  private readObject(): Record<string, unknown> {
    this.pos += 1;
    const out: Record<string, unknown> = {};
    for (;;) {
      this.skipTrivia();
      if (this.matchChar("}")) return out;
      if (this.text.startsWith("...", this.pos)) this.fail("Spread syntax is not allowed in `meta`; write the values out.");
      let key: string;
      const ch = this.peek();
      if (ch === "'" || ch === '"') key = this.readString();
      else if (ch === "[") this.fail("Computed keys are not allowed in `meta`.");
      else {
        const word = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(this.text.slice(this.pos))?.[0];
        if (!word) this.fail(`Expected a property name in \`meta\`, found \`${ch || "end of file"}\`.`);
        key = word;
        this.pos += word.length;
      }
      this.skipTrivia();
      if (!this.matchChar(":")) {
        this.fail(`Expected \`:\` after \`${key}\`. Shorthand properties are variables and are not allowed in \`meta\`.`);
      }
      if (key === "__proto__") this.fail("`__proto__` is not a valid key in `meta`.");
      out[key] = this.readValue();
      this.skipTrivia();
      if (this.matchChar(",")) continue;
      if (this.matchChar("}")) return out;
      this.fail("Expected `,` or `}` in `meta`.");
    }
  }

  private readArray(): unknown[] {
    this.pos += 1;
    const out: unknown[] = [];
    for (;;) {
      this.skipTrivia();
      if (this.matchChar("]")) return out;
      out.push(this.readValue());
      this.skipTrivia();
      if (this.matchChar(",")) continue;
      if (this.matchChar("]")) return out;
      this.fail("Expected `,` or `]` in `meta`.");
    }
  }

  private readString(): string {
    const quote = this.peek();
    this.pos += 1;
    let out = "";
    for (;;) {
      const ch = this.peek();
      if (ch === "") this.fail("Unterminated string in `meta`.");
      if (ch === quote) {
        this.pos += 1;
        return out;
      }
      if (quote === "`" && this.text.startsWith("${", this.pos)) {
        this.fail("Template interpolation (`${...}`) is not allowed in `meta`.");
      }
      if (ch === "\n" && quote !== "`") this.fail("Line break inside a quoted string in `meta`.");
      if (ch === "\\") {
        const next = this.text[this.pos + 1] ?? "";
        this.pos += 2;
        switch (next) {
          case "n": out += "\n"; break;
          case "t": out += "\t"; break;
          case "r": out += "\r"; break;
          case "b": out += "\b"; break;
          case "f": out += "\f"; break;
          case "v": out += "\v"; break;
          case "0": out += "\0"; break;
          case "\n": break;
          case "u": {
            const hex = this.text.slice(this.pos, this.pos + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail("Invalid \\u escape in `meta`.");
            out += String.fromCharCode(parseInt(hex, 16));
            this.pos += 4;
            break;
          }
          case "x": {
            const hex = this.text.slice(this.pos, this.pos + 2);
            if (!/^[0-9a-fA-F]{2}$/.test(hex)) this.fail("Invalid \\x escape in `meta`.");
            out += String.fromCharCode(parseInt(hex, 16));
            this.pos += 2;
            break;
          }
          default: out += next;
        }
        continue;
      }
      out += ch;
      this.pos += 1;
    }
  }

  private readNumber(): number {
    const match = /^[+-]?(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?/.exec(this.text.slice(this.pos));
    if (!match) this.fail("Invalid number in `meta`.");
    this.pos += match[0].length;
    const value = Number(match[0].replace(/_/g, ""));
    if (!Number.isFinite(value)) this.fail("Invalid number in `meta`.");
    return value;
  }
}
