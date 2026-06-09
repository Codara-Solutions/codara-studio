import React from "react";

// Minimal markdown renderer for chat prose. Spark's assistant turns are short
// plain-English replies plus the occasional structured summary, so this
// covers paragraphs, headings, fenced + inline code, bullet / ordered lists,
// bold text, and links. No tables, blockquotes, or images by design — a real
// markdown dependency would dwarf what the conversation actually needs.

type Block =
  | { type: "code"; code: string }
  | { type: "heading"; level: number; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "para"; text: string };

const LIST_RE = /^\s*([-*]|\d+\.)\s+/;

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    const fenceOpen = /^\s*(`{3,})/.exec(line);
    if (fenceOpen) {
      const fenceLen = fenceOpen[1].length;
      const code: string[] = [];
      i++;
      while (i < lines.length) {
        const fenceClose = /^\s*(`{3,})/.exec(lines[i]);
        if (fenceClose && fenceClose[1].length >= fenceLen) break;
        code.push(lines[i]);
        i++;
      }
      i++; // consume the closing fence
      blocks.push({ type: "code", code: code.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2].trim() });
      i++;
      continue;
    }
    if (LIST_RE.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && LIST_RE.test(lines[i])) {
        items.push(lines[i].replace(LIST_RE, ""));
        i++;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^\s*```/.test(lines[i]) &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !LIST_RE.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push({ type: "para", text: para.join("\n") });
  }
  return blocks;
}

// Matches inline code, bold, then links — code first so `**` inside a span of
// code stays literal.
const INLINE_RE = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\))/g;

function renderInline(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  INLINE_RE.lastIndex = 0;
  while ((match = INLINE_RE.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push(
        <code key={key++} style={INLINE_CODE_STYLE}>
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**")) {
      nodes.push(
        <strong key={key++} style={{ fontWeight: 700, color: "var(--ink)" }}>
          {token.slice(2, -2)}
        </strong>,
      );
    } else {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
      if (link) {
        const href = link[2];
        nodes.push(
          <a
            key={key++}
            href={href}
            onClick={(event) => {
              event.preventDefault();
              void window.spark.openExternal(href);
            }}
            style={{ color: "var(--accent)", textDecoration: "none", cursor: "pointer" }}
          >
            {link[1]}
          </a>,
        );
      } else {
        nodes.push(token);
      }
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

// Soft line breaks inside a paragraph become <br>; the surrounding fragment
// keys keep the per-line inline keys from colliding.
function renderParagraph(text: string): React.ReactNode {
  return text.split("\n").map((line, i) => (
    <React.Fragment key={i}>
      {i > 0 && <br />}
      {renderInline(line)}
    </React.Fragment>
  ));
}

export default function Markdown({ text }: { text: string }) {
  const blocks = React.useMemo(() => parseBlocks(text), [text]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {blocks.map((block, index) => {
        if (block.type === "code") {
          return (
            <pre key={index} style={CODE_BLOCK_STYLE}>
              <code>{block.code}</code>
            </pre>
          );
        }
        if (block.type === "heading") {
          return (
            <div
              key={index}
              style={{
                fontSize: block.level <= 2 ? 14 : 13,
                fontWeight: 700,
                color: "var(--ink)",
                lineHeight: 1.3,
              }}
            >
              {renderInline(block.text)}
            </div>
          );
        }
        if (block.type === "list") {
          const liNodes = block.items.map((item, j) => (
            <li key={j} style={{ marginBottom: 2 }}>
              {renderInline(item)}
            </li>
          ));
          return block.ordered ? (
            <ol key={index} style={LIST_STYLE}>
              {liNodes}
            </ol>
          ) : (
            <ul key={index} style={LIST_STYLE}>
              {liNodes}
            </ul>
          );
        }
        return (
          <p key={index} style={PARA_STYLE}>
            {renderParagraph(block.text)}
          </p>
        );
      })}
    </div>
  );
}

const INLINE_CODE_STYLE: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "0.9em",
  background: "color-mix(in oklch, var(--ink) 8%, transparent)",
  padding: "1px 5px",
  borderRadius: 4,
  color: "var(--ink)",
};

const CODE_BLOCK_STYLE: React.CSSProperties = {
  margin: 0,
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  lineHeight: 1.5,
  background: "var(--bg)",
  border: "1px solid var(--rule-soft)",
  borderRadius: "var(--radius-control, 7px)",
  // Recessed well — depth via the foundation token (light-theme-safe) so the
  // code block reads as a sunk surface rather than a flat outlined box.
  boxShadow: "var(--well)",
  padding: "9px 11px",
  overflowX: "auto",
  color: "var(--ink-dim)",
  whiteSpace: "pre",
};

const PARA_STYLE: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  lineHeight: 1.55,
};

const LIST_STYLE: React.CSSProperties = {
  margin: 0,
  paddingLeft: 18,
  fontSize: 13,
  lineHeight: 1.55,
};
