import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeHighlight from "rehype-highlight";
import MermaidBlock from "./MermaidBlock";
import "./markdown.css";

// Sanitizer schema for the raw HTML that rehype-raw expands. This file renders
// fully untrusted markdown (model-generated plans, arbitrary repo READMEs) in
// the privileged renderer that exposes the window.spark IPC surface, so the
// raw HTML MUST be scrubbed before it reaches React. We extend the GitHub-style
// defaultSchema (which already strips script/style/iframe, event-handler
// attributes, and javascript: URLs) with two minimal additions:
//   - `data` protocol on img[src] so inline `![](data:image/png;base64,...)`
//     images keep working (defaultSchema only allows http/https for src).
//   - details/summary are already in defaultSchema's tagNames, so no change
//     needed there.
// Code-fence highlighting is unaffected: sanitize runs BEFORE rehypeHighlight,
// defaultSchema already allows the remark-added `language-*` className on
// <code>, and the `hljs*` classes rehypeHighlight injects afterward are never
// seen by the sanitizer. Mermaid is likewise unaffected — it is intercepted at
// the `code` component via the `language-mermaid` class (preserved by the
// `language-*` allowance) and rendered from the code's text content, not from
// raw HTML. Relative/anchor/root-relative img+link refs pass through cleanly,
// so the custom `a`/`img` components below still resolve them to file:// URLs.
const sanitizeSchema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.src ?? []), "data"],
  },
};

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
      // navigating away from the renderer. onClick preventDefaults and routes
      // through the in-app browser, but dragging a link and dropping it back
      // onto the window bypasses onClick entirely and would navigate the
      // privileged renderer to the dragged URL. The main-process navigation
      // guard now blocks that class regardless of vector; as defense in depth
      // we also stop the anchor from initiating a URL drag in the first place.
      a(props: { href?: string; children?: React.ReactNode }) {
        const { href, children, ...rest } = props;
        const resolved = href ? resolveResource(href, baseDir) : "#";
        return (
          <a
            href={resolved}
            draggable={false}
            onDragStart={(event) => event.preventDefault()}
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
        rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema], rehypeHighlight]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
