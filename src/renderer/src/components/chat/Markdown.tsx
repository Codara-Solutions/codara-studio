import React, { useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { rehypeHighlightShared } from "../../lib/rehype-highlight-shared";
import {
  classifyChatHref,
  codeSpanFileReference,
  isAbsoluteChatPath,
  resolveChatPath,
} from "./markdown-links";
import { chatUrlTransform, remarkTabLinks } from "./remark-tab-links";
import { splitMarkdownBlocks } from "./markdown-blocks";
import { cachedMermaidSvg, rememberMermaidSvg } from "./mermaid-cache";
import { isTabLink } from "@shared/tab-links";
import { openTabLink } from "../../tabs/tabLinkBridge";

// Hoisted so streaming re-renders reuse the same plugin arrays and component
// map — a fresh object here re-runs the whole remark/rehype pipeline per render.
// remark-breaks keeps single newlines as line breaks: chat prose is written
// line-by-line, and collapsing soft breaks is what produced wall-of-text
// question cards.
const REMARK_PLUGINS = [remarkGfm, remarkBreaks, remarkTabLinks];
// react-markdown still rebuilds its processor per render; the shared plugin
// keeps the highlighter it attaches from being rebuilt with it.
const REHYPE_PLUGINS = [rehypeHighlightShared];

// The workspace that relative paths in an answer belong to. Null (the
// default) keeps links external-only, for markdown rendered outside a run.
export const MarkdownWorkspaceContext = React.createContext<string | null>(null);

function openWorkspaceFile(cwd: string, path: string, line?: number): void {
  const resolved = resolveChatPath(cwd, path);
  window.dispatchEvent(
    new CustomEvent("spark:open-file", { detail: line ? { path: resolved, line } : { path: resolved } }),
  );
}

function MarkdownLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  const cwd = useContext(MarkdownWorkspaceContext);
  const target = classifyChatHref(href);
  return (
    <a
      href={href}
      title={href}
      onClick={(event) => {
        event.preventDefault();
        if (href && isTabLink(href)) openTabLink(href);
        else if (target.kind === "external") void window.spark.openExternal(target.url);
        else if (target.kind === "path" && cwd) openWorkspaceFile(cwd, target.path, target.line);
      }}
      rel="noreferrer"
      style={{ color: "var(--accent-text)", textDecoration: "none" }}
    >
      {children}
    </a>
  );
}

// A code span that reads like a file path opens it on click. Existence is
// probed only then (one IPC per click, never per streamed render); a remote
// workspace cannot be probed locally, so it opens directly.
function InlineCode({ text, children }: { text: string; children?: React.ReactNode }) {
  const cwd = useContext(MarkdownWorkspaceContext);
  const reference = useMemo(() => (cwd ? codeSpanFileReference(text) : null), [cwd, text]);
  const [missing, setMissing] = useState(false);
  if (!cwd || !reference || missing) {
    return (
      <code style={INLINE_CODE_STYLE} title={missing ? "Not found in this workspace" : undefined}>
        {children}
      </code>
    );
  }
  const open = () => {
    const remote = /^[a-z][a-z0-9+.-]*:\/\//i.test(cwd);
    if (remote) {
      openWorkspaceFile(cwd, reference.path, reference.line);
      return;
    }
    const absolute = isAbsoluteChatPath(reference.path);
    void window.spark.fs
      .pathExists(absolute ? { target: reference.path } : { target: reference.path, baseDir: cwd })
      .then((result) => {
        if (result.exists && result.isFile) openWorkspaceFile(cwd, reference.path, reference.line);
        else setMissing(true);
      })
      .catch(() => setMissing(true));
  };
  return (
    <code
      className="cora-md-file-ref"
      role="link"
      tabIndex={0}
      title={`Open ${reference.path}`}
      style={INLINE_CODE_STYLE}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          open();
        }
      }}
    >
      {children}
    </code>
  );
}

function nodeText(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) return nodeText(node.props.children);
  return "";
}

function codeLanguage(children: React.ReactNode): string | null {
  const child = React.Children.toArray(children)[0];
  if (!React.isValidElement<{ className?: string }>(child)) return null;
  return child.props.className?.match(/\blanguage-([\w+#-]+)/)?.[1] ?? null;
}

function CodeBlock({ children }: { children?: React.ReactNode }) {
  const language = codeLanguage(children);
  if (language === "mermaid") return <pre style={CODE_BLOCK_STYLE}>{children}</pre>;
  return (
    <div className="cora-md-code">
      <div className="cora-md-code__bar">
        <span className="cora-md-code__lang">{language ?? ""}</span>
        <CopyCodeButton getText={() => nodeText(children).replace(/\n$/, "")} />
      </div>
      <pre style={CODE_BLOCK_STYLE}>{children}</pre>
    </div>
  );
}

function CopyCodeButton({ getText }: { getText: () => string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);
  return (
    <button
      type="button"
      className="cora-md-code__copy"
      aria-label="Copy code"
      title={copied ? "Copied" : "Copy code"}
      onClick={() => {
        void window.spark.clipboard.writeText(getText()).then(() => {
          setCopied(true);
          if (timer.current !== null) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

const COMPONENTS: Components = {
  a: ({ href, children }) => <MarkdownLink href={href}>{children}</MarkdownLink>,
  code: ({ className, children, ...props }) => {
    const content = String(children).replace(/\n$/, "");
    if (/language-mermaid\b/.test(className ?? "")) {
      return <MermaidDiagram source={content} />;
    }
    const block = Boolean(className) || content.includes("\n");
    return block ? (
      <code className={className} {...props}>{children}</code>
    ) : (
      <InlineCode text={content}>{children}</InlineCode>
    );
  },
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  table: ({ children }) => (
    <div style={{ overflowX: "auto", maxWidth: "100%" }}>
      <table style={TABLE_STYLE}>{children}</table>
    </div>
  ),
  th: ({ children, style }) => <th style={{ ...TABLE_HEAD_STYLE, ...style }}>{children}</th>,
  td: ({ children, style }) => <td style={{ ...TABLE_CELL_STYLE, ...style }}>{children}</td>,
  p: ({ children }) => <p style={PARA_STYLE}>{children}</p>,
  ul: ({ children }) => <ul style={LIST_STYLE}>{children}</ul>,
  ol: ({ children }) => <ol style={LIST_STYLE}>{children}</ol>,
  blockquote: ({ children }) => <blockquote style={QUOTE_STYLE}>{children}</blockquote>,
  h1: ({ children }) => <h1 style={HEADING_STYLE}>{children}</h1>,
  h2: ({ children }) => <h2 style={HEADING_STYLE}>{children}</h2>,
  h3: ({ children }) => <h3 style={HEADING_STYLE}>{children}</h3>,
  h4: ({ children }) => <h4 style={HEADING_STYLE}>{children}</h4>,
  hr: () => <hr style={RULE_STYLE} />,
};

/** Shared safe markdown renderer for chat and result prose. Raw HTML is not
 * enabled, so model output cannot inject DOM. GFM and highlight.js cover the
 * common tables/task-lists/code path; Mermaid runs in strict security mode. */
function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  // Only text that is still growing is cut: every piece costs a parser setup,
  // which a finished message would pay on every mount for nothing.
  const blocks = useMemo(() => (streaming ? splitMarkdownBlocks(text) : [text]), [streaming, text]);
  // The newline between pieces is the text node the whole document's hast
  // puts between top-level blocks, so the DOM matches an unsplit render.
  return (
    <div className="cora-md">
      {blocks.map((block, index) => (
        <React.Fragment key={index}>
          {index > 0 && "\n"}
          <MarkdownBlock text={block} />
        </React.Fragment>
      ))}
    </div>
  );
}

export default React.memo(Markdown);

// Memoized per piece: while a reply streams, only the piece still growing
// gets new text, so the finished ones above it are never parsed again.
const MarkdownBlock = React.memo(function MarkdownBlock({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      rehypePlugins={REHYPE_PLUGINS}
      components={COMPONENTS}
      urlTransform={chatUrlTransform}
    >
      {text}
    </ReactMarkdown>
  );
});

function MermaidDiagram({ source }: { source: string }) {
  const reactId = useId();
  const id = useMemo(() => `cora-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`, [reactId]);
  const [svg, setSvg] = useState<string>(() => cachedMermaidSvg(source, id));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const cached = cachedMermaidSvg(source, id);
    if (cached) {
      setSvg(cached);
      return;
    }
    let cancelled = false;
    void import("mermaid").then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "dark" });
      try {
        const rendered = await mermaid.render(id, source);
        if (!cancelled) {
          rememberMermaidSvg(source, id, rendered.svg);
          setSvg(rendered.svg);
        }
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      }
    });
    return () => { cancelled = true; };
  }, [id, source]);
  if (error) return <pre style={CODE_BLOCK_STYLE}><code>{source}</code></pre>;
  if (!svg) return <div data-mermaid-pending style={{ color: "var(--muted)", fontSize: 12 }}>Rendering diagram…</div>;
  return <div style={{ maxWidth: "100%", overflowX: "auto" }} dangerouslySetInnerHTML={{ __html: svg }} />;
}

const INLINE_CODE_STYLE: React.CSSProperties = {
  fontFamily: "var(--font-mono)", fontSize: "0.86em",
  background: "color-mix(in oklab, var(--ink) 8%, transparent)",
  padding: "1px 5px", borderRadius: 5, color: "var(--ink)",
};
// Block margins and the heading scale live in styles.css (.cora-md) so the
// first and last block of a message can drop their outer margins; inline
// margins here would outrank those rules.
const CODE_BLOCK_STYLE: React.CSSProperties = {
  margin: 0, fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.55,
  background: "var(--bg)", border: "1px solid var(--rule-soft)", borderRadius: 10,
  padding: "11px 13px", overflow: "auto", maxHeight: 420,
  color: "var(--ink-dim)", whiteSpace: "pre",
};
const PARA_STYLE: React.CSSProperties = {};
const LIST_STYLE: React.CSSProperties = { paddingLeft: 20 };
const HEADING_STYLE: React.CSSProperties = { color: "var(--ink)" };
const RULE_STYLE: React.CSSProperties = { border: "none", borderTop: "1px solid var(--rule-soft)" };
const QUOTE_STYLE: React.CSSProperties = { padding: "2px 12px", borderLeft: "2px solid var(--rule-strong)", color: "var(--ink-dim)" };
const TABLE_STYLE: React.CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: 12.5 };
const TABLE_CELL_STYLE: React.CSSProperties = {
  borderBottom: "1px solid var(--rule-soft)", padding: "6px 10px", verticalAlign: "top",
};
const TABLE_HEAD_STYLE: React.CSSProperties = {
  ...TABLE_CELL_STYLE, textAlign: "left", fontWeight: 600, fontSize: 12, color: "var(--ink-dim)",
  borderBottom: "1px solid var(--rule)",
  background: "color-mix(in oklab, var(--ink) 3%, transparent)",
};
