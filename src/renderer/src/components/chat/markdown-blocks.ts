// Splits chat markdown into top-level pieces that parse the same on their own
// as they do inside the whole text, so a streamed reply re-parses only its
// last piece per flush instead of everything written so far.
//
// A cut is made only at a blank line that CommonMark guarantees closes every
// open block: the next line starts at column 0, is not a list item while a
// list may be open (it would continue that list, and could turn it loose),
// and no top-level code fence is open. Anything this scanner cannot be sure of stops cutting
// from there on, which only makes the last piece longer. Raw HTML is one of
// those: an HTML block can run past blank lines, and a fence line inside one
// is not a fence, so the first line that may start one ends the cutting.
// Link reference and footnote definitions apply to the whole document, so a
// text that may contain one is never cut at all; a label can hold escaped
// brackets and line breaks, so any "]:" after a line opening a bracket counts.
// A lone CR is a line ending to the parser but not to this scanner, so a text
// holding one is never cut either.

const DEFINITION_START = /^[ \t>*+\-.)\d]*\[/gm;
const LONE_CR = /\r(?!\n)/;
const BLANK = /^[ \t]*$/;
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const BACKTICK_FENCE = /^( {0,3})(`{3,})[^`]*$/;
const TILDE_FENCE = /^( {0,3})(~{3,})[^]*$/;
const FENCE_CLOSE = /^( {0,3})(`{3,}|~{3,})[ \t]*$/;
const HTML_START = /^ {0,3}</;

interface OpenFence {
  char: string;
  length: number;
  indent: number;
}

function indentOf(line: string): number {
  let column = 0;
  for (const char of line) {
    if (char === " ") column += 1;
    else if (char === "\t") column += 4 - (column % 4);
    else break;
  }
  return column;
}

function openingFence(line: string): OpenFence | null {
  const match = BACKTICK_FENCE.exec(line) ?? TILDE_FENCE.exec(line);
  return match ? { char: match[2][0], length: match[2].length, indent: match[1].length } : null;
}

function mayHoldDefinition(text: string): boolean {
  for (const match of text.matchAll(DEFINITION_START)) {
    if (text.includes("]:", match.index)) return true;
  }
  return false;
}

export function splitMarkdownBlocks(text: string): string[] {
  if (LONE_CR.test(text) || mayHoldDefinition(text)) return [text];
  const blocks: string[] = [];
  let start = 0;
  let offset = 0;
  let fence: OpenFence | null = null;
  let blankFrom = -1;
  let listOpen = false;
  for (const raw of text.split("\n")) {
    const lineStart = offset;
    offset += raw.length + 1;
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (fence) {
      const close = FENCE_CLOSE.exec(line);
      if (close && close[2][0] === fence.char && close[2].length >= fence.length) {
        // An indented fence may sit in a list item; a closer left of the
        // opener could end that item instead and open a new fence.
        if (close[1].length < fence.indent) break;
        fence = null;
      } else if (fence.indent > 0 && !BLANK.test(line) && indentOf(line) < fence.indent) {
        break;
      }
      continue;
    }
    if (BLANK.test(line)) {
      if (blankFrom < 0) blankFrom = lineStart;
      continue;
    }
    const listItem = LIST_ITEM.test(line);
    if (blankFrom > start && indentOf(line) === 0 && !(listItem && listOpen)) {
      blocks.push(text.slice(start, blankFrom - 1));
      start = lineStart;
      listOpen = false;
    }
    blankFrom = -1;
    if (listItem) listOpen = true;
    if (HTML_START.test(line)) break;
    fence = openingFence(line);
  }
  blocks.push(text.slice(start));
  return blocks;
}
