// Turns an agent's snippet into a script the kernel can run with top-level
// await while keeping its declarations for the next call (REPL semantics):
// top-level const, let, var, function and class become properties of the
// session's global object, and the last expression statement is returned.
// A redeclaration in a later call replaces the value instead of failing.

import { parse, type Node, type Pattern, type Program, type Statement } from "acorn";

export class SnippetSyntaxError extends Error {}

interface Edit {
  start: number;
  end: number;
  text: string;
}

function boundNames(pattern: Pattern, into: string[]): void {
  switch (pattern.type) {
    case "Identifier":
      into.push(pattern.name);
      break;
    case "ObjectPattern":
      for (const property of pattern.properties) {
        boundNames(property.type === "RestElement" ? property.argument : property.value, into);
      }
      break;
    case "ArrayPattern":
      for (const element of pattern.elements) if (element) boundNames(element, into);
      break;
    case "AssignmentPattern":
      boundNames(pattern.left, into);
      break;
    case "RestElement":
      boundNames(pattern.argument, into);
      break;
    default:
      break;
  }
}

function source(code: string, node: Node): string {
  return code.slice(node.start, node.end);
}

/** The script for one snippet: an async function call whose promise settles with the snippet's value. */
export function transformSnippet(code: string): string {
  let program: Program;
  try {
    program = parse(code, {
      ecmaVersion: "latest",
      sourceType: "script",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    });
  } catch (error) {
    throw new SnippetSyntaxError(`SyntaxError: ${error instanceof Error ? error.message : String(error)}`);
  }

  const edits: Edit[] = [];
  const names: string[] = [];
  const functions: string[] = [];
  const body = program.body as Statement[];

  for (const node of body) {
    if (node.type === "VariableDeclaration") {
      const parts: string[] = [];
      for (const declarator of node.declarations) {
        boundNames(declarator.id, names);
        if (declarator.init) parts.push(`(${source(code, declarator.id)} = ${source(code, declarator.init)})`);
        else if (node.kind !== "var") parts.push(`(${source(code, declarator.id)} = undefined)`);
      }
      edits.push({ start: node.start, end: node.end, text: parts.length ? `void (${parts.join(", ")});` : ";" });
    } else if (node.type === "FunctionDeclaration" && node.id) {
      functions.push(node.id.name);
    } else if (node.type === "ClassDeclaration" && node.id) {
      names.push(node.id.name);
      edits.push({ start: node.start, end: node.end, text: `${node.id.name} = ${source(code, node)};` });
    }
  }

  const last = body.at(-1);
  if (last && last.type === "ExpressionStatement" && !("directive" in last && last.directive)) {
    edits.push({ start: last.start, end: last.end, text: `return (${source(code, last.expression)});` });
  }

  let out = code;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }

  // Every declared name exists on the global object before the body runs, so
  // `var x;` alone still declares x, and reading a name before its
  // assignment gives undefined instead of a ReferenceError. The prefix also
  // ends any "use strict" prologue, which keeps the rewritten assignments
  // legal.
  const unique = [...new Set(names)];
  const declare = unique.length
    ? `for (const __codaraName of ${JSON.stringify(unique)}) if (!(__codaraName in globalThis)) globalThis[__codaraName] = undefined; `
    : "";
  // Function declarations are hoisted inside the wrapper, so publishing them
  // first makes them callable from anywhere in the snippet and in later calls.
  const publish = functions.map((name) => `globalThis[${JSON.stringify(name)}] = ${name}; `).join("");
  // Everything added goes on the snippet's first line, so the line numbers in
  // errors match what the agent wrote.
  return `(async () => { ${declare}${publish}${out}\n})()`;
}
