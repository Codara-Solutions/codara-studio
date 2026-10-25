// Splits chat markdown into top-level pieces that parse the same on their own
// as they do inside the whole text, so a streamed reply re-parses only its
// last piece per flush instead of everything written so far.
//
// A cut is made only at a blank line that CommonMark guarantees closes every
// open block: the next line starts at column 0, is not a list item while a
// list may be open (it would continue that list, and could turn it loose) or
// right after indented code (micromark then reads the item, quoted or not, as
// paragraph text), no blank line in between is indented enough to continue
// that code, and no top-level code fence is open. Anything this scanner cannot be sure of stops cutting
// from there on, which only makes the last piece longer. Raw HTML is one of
// those: an HTML block can run past blank lines, and a fence line inside one
// is not a fence, so the first line that may start one ends the cutting
// (inside a list item at any indent, since the item's column is unknown). A
// fence opened on a list or quote marker line is another: its container, not
// a closing fence, may end it, with or without the blank lines before. A
// fence indented 4 or more columns while a list is open sits in an item too,
// but cutting goes on once a closer at its own column ends it.
// Link reference and footnote definitions apply to the whole document, so a
// text that may contain one is never cut at all: a line opening a bracket
// whose first unescaped "]" is followed by ":" (a label can hold escaped
// brackets and line breaks).
// A lone CR is a line ending to the parser but not to this scanner, and a
// byte-order mark is dropped only at the start of a document, so a text with
// either past its first character is never cut either. A CR ending the text
// is the first half of a CRLF still streaming in and ends the last line
// either way.

const DEFINITION_START = /^[ \t>*+\-.)\d]*\[/gm;
const UNCUTTABLE = /\r(?!\n|$)|[^]\uFEFF/;
const BLANK = /^[ \t]*$/;
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const QUOTED_LIST_ITEM = /^(?: {0,3}>[ \t]?)+ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;
const BACKTICK_FENCE = /^( {0,3})(`{3,})[^`]*$/;
const TILDE_FENCE = /^( {0,3})(~{3,})[^]*$/;
const FENCE_CLOSE = /^( {0,3})(`{3,}|~{3,})[ \t]*$/;
const HTML_START = /^ {0,3}</;
const ITEM_HTML_START = /^[ \t]*</;
const INDENTED_FENCE = /^([ \t]*)(`{3,}(?=[^`]*$)|~{3,})/;
const DEEP_CLOSE = /^([ \t]*)(`{3,}|~{3,})[ \t]*$/;
const CONTAINER_FENCE = /^ {0,3}(?:[-*+]|\d{1,9}[.)]|>)[ \t>*+\-.)\d]*(?:`{3}|~{3})/;

interface OpenFence {
  char: string;
  length: number;
  indent: number;
  deep?: boolean;
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
    for (let index = match.index + match[0].length; index < text.length; index += 1) {
      const char = text[index];
      if (char === "\\") index += 1;
      else if (char === "]") {
        if (text[index + 1] === ":") return true;
        break;
      }
    }
  }
  return false;
}

export function splitMarkdownBlocks(text: string): string[] {
  if (UNCUTTABLE.test(text) || mayHoldDefinition(text)) return [text];
  const blocks: string[] = [];
  let start = 0;
  let offset = 0;
  let fence: OpenFence | null = null;
  let blankFrom = -1;
  let listOpen = false;
  let lastIndent = 0;
  let blankIndent = 0;
  for (const raw of text.split("\n")) {
    const lineStart = offset;
    offset += raw.length + 1;
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (fence) {
      const close = (fence.deep ? DEEP_CLOSE : FENCE_CLOSE).exec(line);
      if (close && close[2][0] === fence.char && close[2].length >= fence.length) {
        // An indented fence may sit in a list item; a closer left of the
        // opener could end that item instead and open a new fence. A fence
        // indented 4+ columns is in an item whose content column is unknown,
        // so a closer right of it may be 4+ columns into that item: code.
        const column = indentOf(close[1]);
        if (column < fence.indent || (fence.deep && column > fence.indent)) break;
        fence = null;
      } else if (fence.indent > 0 && !BLANK.test(line) && indentOf(line) < fence.indent) {
        break;
      }
      continue;
    }
    if (BLANK.test(line)) {
      if (blankFrom < 0) {
        blankFrom = lineStart;
        blankIndent = 0;
      }
      blankIndent = Math.max(blankIndent, indentOf(line));
      continue;
    }
    const listItem = LIST_ITEM.test(line);
    const indent = indentOf(line);
    const codeContinues = lastIndent >= 4 && (listItem || blankIndent >= 4 || QUOTED_LIST_ITEM.test(line));
    if (blankFrom > start && indent === 0 && !codeContinues && !(listItem && listOpen)) {
      blocks.push(text.slice(start, blankFrom - 1));
      start = lineStart;
      listOpen = false;
    }
    blankFrom = -1;
    lastIndent = indent;
    if (listItem) listOpen = true;
    if (HTML_START.test(line) || (listOpen && ITEM_HTML_START.test(line)) || CONTAINER_FENCE.test(line)) break;
    const deep = listOpen && indent >= 4 ? INDENTED_FENCE.exec(line) : null;
    fence = deep ? { char: deep[2][0], length: deep[2].length, indent, deep: true } : openingFence(line);
  }
  blocks.push(text.slice(start));
  return blocks;
}
