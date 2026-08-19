import React, { useEffect, useId, useMemo, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeHighlight from "rehype-highlight";

// Hoisted so streaming re-renders reuse the same plugin arrays and component
// map — a fresh object here re-runs the whole remark/rehype pipeline per render.
// remark-breaks keeps single newlines as line breaks: chat prose is written
// line-by-line, and collapsing soft breaks is what produced wall-of-text
// question cards.
const REMARK_PLUGINS = [remarkGfm, remarkBreaks];
const REHYPE_PLUGINS = [rehypeHighlight];

const COMPONENTS: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault();
        if (href) void window.spark.openExternal(href);
      }}
      rel="noreferrer"
      style={{ color: "var(--accent-text)", textDecoration: "none" }}
    >
      {children}
    </a>
  ),
  code: ({ className, children, ...props }) => {
    const content = String(children).replace(/\n$/, "");
    if (/language-mermaid\b/.test(className ?? "")) {
      return <MermaidDiagram source={content} />;
    }
    const block = Boolean(className) || content.includes("\n");
    return block ? (
      <code className={className} {...props}>{children}</code>
    ) : (
      <code style={INLINE_CODE_STYLE} {...props}>{children}</code>
    );
  },
  pre: ({ children }) => <pre style={CODE_BLOCK_STYLE}>{children}</pre>,
  table: ({ children }) => (
    <div style={{ overflowX: "auto", maxWidth: "100%" }}>
      <table style={TABLE_STYLE}>{children}</table>
    </div>
  ),
  p: ({ children }) => <p style={PARA_STYLE}>{children}</p>,
  ul: ({ children }) => <ul style={LIST_STYLE}>{children}</ul>,
  ol: ({ children }) => <ol style={LIST_STYLE}>{children}</ol>,
  blockquote: ({ children }) => <blockquote style={QUOTE_STYLE}>{children}</blockquote>,
  h1: ({ children }) => <h1 style={HEADING_STYLE}>{children}</h1>,
  h2: ({ children }) => <h2 style={HEADING_STYLE}>{children}</h2>,
  h3: ({ children }) => <h3 style={HEADING_STYLE}>{children}</h3>,
};

/** Shared safe markdown renderer for chat and result prose. Raw HTML is not
 * enabled, so model output cannot inject DOM. GFM and highlight.js cover the
 * common tables/task-lists/code path; Mermaid runs in strict security mode. */
function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      components={COMPONENTS}
    >
      {text}
    </ReactMarkdown>
  );
}

export default React.memo(Markdown);

function MermaidDiagram({ source }: { source: string }) {
  const reactId = useId();
  const id = useMemo(() => `cora-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`, [reactId]);
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void import("mermaid").then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "dark" });
      try {
        const rendered = await mermaid.render(id, source);
        if (!cancelled) setSvg(rendered.svg);
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      }
    });
    return () => { cancelled = true; };
  }, [id, source]);
  if (error) return <pre style={CODE_BLOCK_STYLE}><code>{source}</code></pre>;
  if (!svg) return <div style={{ color: "var(--muted)", fontSize: 12 }}>Rendering diagram…</div>;
  return <div style={{ maxWidth: "100%", overflowX: "auto" }} dangerouslySetInnerHTML={{ __html: svg }} />;
}

const INLINE_CODE_STYLE: React.CSSProperties = {
  fontFamily: "var(--font-mono)", fontSize: "0.9em",
  background: "color-mix(in oklab, var(--ink) 8%, transparent)",
  padding: "1px 5px", borderRadius: 4, color: "var(--ink)",
};
const CODE_BLOCK_STYLE: React.CSSProperties = {
  margin: "8px 0", fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.5,
  background: "var(--bg)", border: "1px solid var(--rule-soft)", borderRadius: 7,
  boxShadow: "var(--well)", padding: "10px 12px", overflow: "auto", maxHeight: 420,
  color: "var(--ink-dim)", whiteSpace: "pre",
};
const PARA_STYLE: React.CSSProperties = { margin: "0 0 8px", fontSize: 13.5, lineHeight: 1.62 };
const LIST_STYLE: React.CSSProperties = { margin: "0 0 8px", paddingLeft: 20, fontSize: 13, lineHeight: 1.55 };
const HEADING_STYLE: React.CSSProperties = { margin: "12px 0 6px", color: "var(--ink)", fontSize: 15, lineHeight: 1.3 };
const QUOTE_STYLE: React.CSSProperties = { margin: "8px 0", padding: "4px 12px", borderLeft: "3px solid var(--accent-edge)", color: "var(--ink-dim)" };
const TABLE_STYLE: React.CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: 12.5 };
