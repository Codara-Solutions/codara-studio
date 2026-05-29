import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeHighlight from "rehype-highlight";
import MermaidBlock from "./MermaidBlock";
import "./markdown.css";

// VS Code-parity markdown preview for the editor pane. Wired through
// react-markdown so we get tables, task lists, strikethrough, autolinks
// (via remark-gfm), inline HTML (via rehype-raw), and code-block syntax
// highlighting (via rehype-highlight / highlight.js). Mermaid is intercepted
// at the `code` renderer and rendered through a lazy-loaded component so the
// 600KB mermaid bundle never touches the eager path.
//
// `basePath` is the absolute path of the markdown file on disk; we use its
// directory to resolve relative image / link references to file:// URLs so
// `![](./diagram.png)` shows the actual image instead of a broken icon.

interface Props {
  text: string;
  basePath: string;
}

function dirnameOf(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const slash = norm.lastIndexOf("/");
  return slash >= 0 ? norm.slice(0, slash) : "";
}

function isAbsoluteUrl(href: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|mailto:|data:)/i.test(href);
}

function resolveResource(href: string, baseDir: string): string {
  if (!href) return href;
  if (isAbsoluteUrl(href)) return href;
  // file:// URLs need a forward-slash separator on every platform. Electron
  // accepts the unencoded form for local assets in renderer img tags.
  const trimmed = href.replace(/^\.\//, "");
  if (trimmed.startsWith("/")) return `file://${trimmed}`;
  if (!baseDir) return href;
  return `file://${baseDir}/${trimmed}`;
}

export default function MarkdownPreview({ text, basePath }: Props) {
  const baseDir = useMemo(() => dirnameOf(basePath), [basePath]);

  const components = useMemo(
    () => ({
      // Intercept mermaid fences before they hit highlight.js. react-markdown
      // v9 dropped the `inline` prop, so we differentiate via the
      // `language-*` class that remark adds to fenced blocks only — inline
      // code (`like this`) carries no className.
      code(props: { className?: string; children?: React.ReactNode }) {
        const { className, children, ...rest } = props;
        const match = /language-(\w+)/.exec(className ?? "");
        const lang = match ? match[1] : "";
        if (lang === "mermaid") {
          return <MermaidBlock code={String(children ?? "").trim()} />;
        }
        return (
          <code className={className} {...rest}>
            {children}
          </code>
        );
      },
      // Resolve relative paths and ensure links open externally instead of
      // navigating away from the renderer.
      a(props: { href?: string; children?: React.ReactNode }) {
        const { href, children, ...rest } = props;
        const resolved = href ? resolveResource(href, baseDir) : "#";
        return (
          <a
            href={resolved}
            onClick={(event) => {
              if (!href) return;
              if (href.startsWith("#")) return;
              event.preventDefault();
              void window.spark?.openExternal?.(resolved);
            }}
            {...rest}
          >
            {children}
          </a>
        );
      },
      img(props: { src?: string; alt?: string }) {
        const { src, alt, ...rest } = props;
        const resolved = src ? resolveResource(src, baseDir) : src;
        return <img src={resolved} alt={alt ?? ""} {...rest} />;
      },
    }),
    [baseDir],
  );

  return (
    <div
      className="spark-markdown"
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        background: "var(--bg)",
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, rehypeHighlight]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
