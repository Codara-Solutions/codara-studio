import { memo, useMemo, useRef } from "react";
import ReactMarkdown from "react-markdown";
import MermaidBlock from "./MermaidBlock";
import MarkdownReviewLayer from "../review/MarkdownReviewLayer";
import { markdownRehypePipeline, markdownRemarkPlugins } from "./pipeline";
import "./markdown.css";

// Plugins and the sanitizer schema live in ./pipeline, shared with the Share
// packager (components/share/) so a shared page renders like this preview.

interface HastNode {
  type: string;
  properties?: Record<string, unknown>;
  position?: { start: { line: number }; end: { line: number } };
  children?: HastNode[];
}

// Marks each rendered element with the source lines it came from, so a review
// note on selected text can say which lines of the file it is about. Runs
// after the sanitizer, which keeps positions but would drop data attributes
// it does not know.
function rehypeSourceLines() {
  return (tree: HastNode) => {
    const walk = (node: HastNode) => {
      if (node.type === "element" && node.position) {
        node.properties = { ...node.properties, dataLine: node.position.start.line, dataLineEnd: node.position.end.line };
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}

const previewRehypePlugins = markdownRehypePipeline([rehypeSourceLines]);

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

function MarkdownPreview({ text, basePath }: Props) {
  const baseDir = useMemo(() => dirnameOf(basePath), [basePath]);
  const rootRef = useRef<HTMLDivElement>(null);

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
      ref={rootRef}
      className="spark-markdown"
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        background: "var(--bg)",
      }}
    >
      <MarkdownReviewLayer containerRef={rootRef} basePath={basePath} text={text} />
      <ReactMarkdown
        remarkPlugins={markdownRemarkPlugins}
        rehypePlugins={previewRehypePlugins}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export default memo(MarkdownPreview);
