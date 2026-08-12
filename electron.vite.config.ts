import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        "@shared": resolve(__dirname, "src/shared"),
      },
    },
    build: {
      minify: "esbuild",
      rollupOptions: {
        input: { index: resolve(__dirname, "src/main/index.ts") },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        "@shared": resolve(__dirname, "src/shared"),
      },
    },
    build: {
      minify: "esbuild",
      rollupOptions: {
        input: {
          // Main renderer preload — exposes window.spark.
          index: resolve(__dirname, "src/preload/index.ts"),
          // Webview-side preload used by the browser pane's inspect mode.
          // Loaded into the embedded <webview>'s renderer via the `preload`
          // attribute on the tag; communicates with the host via
          // `ipcRenderer.sendToHost`.
          "inspector-preload": resolve(__dirname, "src/preload/inspector-preload.ts"),
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
    plugins: [react()],
    resolve: {
      alias: {
        "@shared": resolve(__dirname, "src/shared"),
        "@": resolve(__dirname, "src/renderer/src"),
      },
    },
    build: {
      minify: "esbuild",
      target: "chrome128",
      modulePreload: { polyfill: false },
      chunkSizeWarningLimit: 1500,
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
        },
        output: {
          manualChunks(id: string) {
            if (!id.includes("node_modules")) return undefined;
            // react-vendor must stay a leaf chunk (no imports back into "vendor",
            // which would make the chunk graph circular), so react-dom's runtime
            // helpers ride along with it.
            // Anchor to node_modules/react(-dom)/ — a bare /react/ segment also
            // matches @xyflow/react's own source, which would yank the flow
            // editor into react-vendor and create a flow-vendor <-> react-vendor
            // cycle.
            if (
              /[\\/]node_modules[\\/](react|react-dom)[\\/]/.test(id) ||
              /[\\/]node_modules[\\/](scheduler|loose-envify|js-tokens|use-sync-external-store)[\\/]/.test(
                id,
              )
            )
              return "react-vendor";
            // Anything codemirror-shaped (@codemirror/*, @uiw/react-codemirror,
            // @replit/codemirror-vim, the `codemirror` meta-package) plus the
            // micro-helpers only codemirror imports — splitting any of these out
            // creates a vendor <-> codemirror-vendor cycle.
            if (
              id.includes("codemirror") ||
              id.includes("@lezer") ||
              id.includes("@uiw/") ||
              /[\\/]node_modules[\\/](crelt|style-mod|w3c-keyname|@marijn)[\\/]/.test(id)
            )
              return "codemirror-vendor";
            if (id.includes("@xterm")) return "xterm-vendor";
            // @xyflow/react (the node-graph editor) + its deps. Isolated so it
            // doesn't bloat the generic vendor chunk; it only imports React
            // (the leaf react-vendor), so no vendor <-> flow-vendor cycle.
            // zustand rides here too (@xyflow is its only consumer); leaving it
            // in the generic "vendor" chunk creates a vendor <-> react-vendor
            // cycle via its use-sync-external-store dep, which we keep pinned to
            // the leaf react-vendor (it's a React-runtime helper).
            if (
              id.includes("@xyflow") ||
              id.includes("classcat") ||
              /[\\/]node_modules[\\/]zustand[\\/]/.test(id) ||
              /[\\/]node_modules[\\/]d3-(drag|zoom|selection|transition|color|dispatch|ease|interpolate|timer)[\\/]/.test(
                id,
              )
            )
              return "flow-vendor";
            if (id.includes("react-virtuoso")) return "virtuoso-vendor";
            if (id.includes("@iconify")) return "icons-vendor";
            // pdf.js is only imported by the lazily-loaded PdfPreview chunk;
            // keeping it out of the eager "vendor" chunk means the ~1MB
            // library loads only when a PDF is first previewed.
            if (id.includes("pdfjs-dist")) return "pdfjs-vendor";
            // docx-preview (+ its jszip dep) is only imported by the lazily-
            // loaded DocxPreview chunk — same reasoning as pdfjs-vendor.
            if (id.includes("docx-preview") || id.includes("jszip")) return "docx-vendor";
            // pptx-preview + the echarts stack it renders slide charts with,
            // only reachable from the lazy PptxPreview chunk. jszip is shared
            // with docx-vendor rather than duplicated (opening a deck pulls
            // that chunk too, which is just the zip reader). uuid is
            // deliberately NOT pinned here: mermaid imports it as well, and
            // pinning it would drag all of echarts into the mermaid chunk.
            if (
              id.includes("pptx-preview") ||
              /[\\/]node_modules[\\/](echarts|zrender|lodash)[\\/]/.test(id)
            )
              return "pptx-vendor";
            return undefined;
          },
        },
      },
    },
  },
});
