import type { Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { rehypeHighlightShared } from "../../lib/rehype-highlight-shared";

// The markdown pipeline, shared by the preview pane and the Share packager so
// a shared page is rendered by exactly the code the user previewed.
//
// Sanitizer schema for the raw HTML that rehype-raw expands. The preview
// renders fully untrusted markdown (model-generated plans, arbitrary repo
// READMEs) in the privileged renderer that exposes the window.spark IPC
// surface, so the raw HTML MUST be scrubbed before it reaches React. We extend
// the GitHub-style defaultSchema (which already strips script/style/iframe,
// event-handler attributes, and javascript: URLs) with two minimal additions:
//   - `data` protocol on img[src] so inline `![](data:image/png;base64,...)`
//     images keep working (defaultSchema only allows http/https for src).
//   - details/summary are already in defaultSchema's tagNames, so no change
//     needed there.
// Code-fence highlighting is unaffected: sanitize runs BEFORE rehypeHighlight,
// defaultSchema already allows the remark-added `language-*` className on
// <code>, and the `hljs*` classes rehypeHighlight injects afterward are never
// seen by the sanitizer. Mermaid is likewise unaffected: it is intercepted at
// the `code` component via the `language-mermaid` class (preserved by the
// `language-*` allowance) and rendered from the code's text content, not from
// raw HTML. Relative/anchor/root-relative img+link refs pass through cleanly,
// so the preview's custom `a`/`img` components still resolve them to file://
// URLs and the Share packager can inline them.
export const markdownSanitizeSchema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    src: [...(defaultSchema.protocols?.src ?? []), "data"],
  },
};

export const markdownRemarkPlugins: NonNullable<Options["remarkPlugins"]> = [remarkGfm];

type RehypePlugins = NonNullable<Options["rehypePlugins"]>;

// `afterSanitize` runs between the sanitizer and the highlighter: the preview
// adds its source-line marks there, which the sanitizer would strip.
export function markdownRehypePipeline(afterSanitize: RehypePlugins = []): RehypePlugins {
  return [rehypeRaw, [rehypeSanitize, markdownSanitizeSchema], ...afterSanitize, rehypeHighlightShared];
}

export const markdownRehypePlugins: RehypePlugins = markdownRehypePipeline();
