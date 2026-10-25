import rehypeHighlight from "rehype-highlight";

// rehype-highlight creates a lowlight instance, registering every common
// highlight.js grammar, each time a processor attaches the plugin, and
// react-markdown builds a new processor on every render. A streamed reply
// re-renders per flush and a long chat per message it mounts, so that setup
// (and recompiling each grammar it then uses) ran again every time. The
// transformer the plugin returns keeps no per-document state, so one instance,
// created on first use, gives identical output and keeps its grammars compiled.
type HighlightTransformer = ReturnType<typeof rehypeHighlight>;

let sharedTransformer: HighlightTransformer | null = null;

export function rehypeHighlightShared(): HighlightTransformer {
  sharedTransformer ??= rehypeHighlight();
  return sharedTransformer;
}
