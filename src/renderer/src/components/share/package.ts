// Builds the page a share link serves, from the file as it is in the editor.
// It is built on this computer and nothing of the user's is sent until they
// choose Share in the prompt. Before that, the only network use is
// downloading the public CDN files the page itself loads, so the prompt can
// show them as embedded.

import { shareableKind } from "@shared/share";
import { packageHtmlPage, type AssetReader, type PackagedPage, type RemoteFetcher } from "./inline";
import { renderMarkdownDocument, type MermaidRenderer } from "./markdown";
import { basenameOf, dirnameOf, isAbsoluteFsPath, isInsideDir } from "./paths";

export interface ShareSource {
  path: string;
  text: string;
  /** Workspace folders open in Codara; the deepest one holding the page may lend it files. */
  workspaceRoots: readonly string[];
}

export interface PackagedShare extends PackagedPage {
  title: string;
}

export interface PackageDeps {
  reader: AssetReader;
  /** Downloads CDN files; without it they are only reported. */
  remote?: RemoteFetcher;
  renderMermaid?: MermaidRenderer;
}

// Local files a page may embed: its own folder and the workspace it is in.
// A file outside every workspace embeds from its own folder only.
export function allowedRootsFor(path: string, workspaceRoots: readonly string[]): string[] {
  if (!isAbsoluteFsPath(path)) return [];
  const roots = [dirnameOf(path)];
  const workspace = workspaceRoots
    .filter((root) => isAbsoluteFsPath(root) && isInsideDir(root, path))
    .sort((a, b) => b.length - a.length)[0];
  if (workspace) roots.push(workspace);
  return roots;
}

export async function packageForShare(source: ShareSource, deps: PackageDeps): Promise<PackagedShare> {
  const kind = shareableKind(source.path);
  if (!kind) throw new Error("Only HTML and Markdown files can be shared as a link.");
  const title = basenameOf(source.path);
  const options = {
    sourcePath: source.path,
    allowedRoots: allowedRootsFor(source.path, source.workspaceRoots),
    reader: deps.reader,
    remote: deps.remote,
  };
  const html =
    kind === "markdown" ? await renderMarkdownDocument(source.text, title, deps.renderMermaid) : source.text;
  return { ...(await packageHtmlPage(html, options)), title };
}

let diagramCounter = 0;

/** The app's reader, downloader and Mermaid, for the real prompt. Tests pass their own. */
export function appPackageDeps(): PackageDeps {
  return {
    // Main reads and downloads, and checks each file again where it really
    // is (src/main/share/assets.ts, remote.ts).
    reader: { read: (request) => window.spark.share.readAsset(request) },
    remote: { fetch: (request) => window.spark.share.fetchRemote(request) },
    renderMermaid: async (code) => {
      const { loadMermaid } = await import("../markdown-preview/mermaid");
      const mermaid = await loadMermaid();
      await mermaid.parse(code);
      // The preview draws diagrams for the dark app; a shared page shows them
      // on a white card, so they use Mermaid's default (light) theme. The
      // directive applies to this render only.
      const { svg } = await mermaid.render(
        `share-diagram-${++diagramCounter}`,
        `%%{init: {"theme": "default"}}%%\n${code}`,
      );
      return svg;
    },
  };
}
