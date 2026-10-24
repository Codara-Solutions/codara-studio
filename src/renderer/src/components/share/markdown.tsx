// A Markdown file as one standalone HTML document, rendered with the same
// plugins and sanitizer schema as the preview (markdown-preview/pipeline.ts),
// so raw HTML in the file is scrubbed exactly as it is on screen. Mermaid
// diagrams become inline SVG; local images are embedded afterwards by
// inline.ts like any other page.

import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { markdownRehypePlugins, markdownRemarkPlugins } from "../markdown-preview/pipeline";
import { SHARED_MARKDOWN_CSS } from "./page-style";

/** SVG markup for a diagram, or null to show its source instead. */
export type MermaidRenderer = (code: string) => Promise<string | null>;

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function placeholderNonce(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function renderMarkdownDocument(
  text: string,
  title: string,
  renderMermaid?: MermaidRenderer,
): Promise<string> {
  // Diagrams render asynchronously, renderToStaticMarkup does not: each one
  // leaves a placeholder no Markdown can forge (the nonce), replaced below.
  const nonce = placeholderNonce();
  const diagrams: string[] = [];
  const body = renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={markdownRemarkPlugins}
      rehypePlugins={markdownRehypePlugins}
      components={{
        code(props: { className?: string; children?: React.ReactNode }) {
          const { className, children } = props;
          const lang = /language-(\w+)/.exec(className ?? "")?.[1] ?? "";
          if (lang === "mermaid" && renderMermaid) {
            diagrams.push(String(children ?? "").trim());
            return <span data-share-diagram={`${nonce}-${diagrams.length - 1}`} />;
          }
          return <code className={className}>{children}</code>;
        },
      }}
    >
      {text}
    </ReactMarkdown>,
  );
  let html = body;
  for (let i = 0; i < diagrams.length; i += 1) {
    const code = diagrams[i] ?? "";
    let svg: string | null = null;
    try {
      svg = renderMermaid ? await renderMermaid(code) : null;
    } catch {
      svg = null;
    }
    const replacement = svg
      ? `<div class="diagram">${svg}</div>`
      : `<pre><code class="language-mermaid">${escapeHtml(code)}</code></pre>`;
    const marker = `<span data-share-diagram="${nonce}-${i}"></span>`;
    html = html.replace(`<pre>${marker}</pre>`, replacement).replace(marker, replacement);
  }
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${SHARED_MARKDOWN_CSS}</style>`,
    "</head>",
    "<body>",
    `<main>${html}</main>`,
    "</body>",
    "</html>",
  ].join("\n");
}
