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
        input: { index: resolve(__dirname, "src/preload/index.ts") },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
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
            if (id.includes("react-dom") || id.match(/[\\/]react[\\/]/)) return "react-vendor";
            if (
              id.includes("@codemirror") ||
              id.includes("@lezer") ||
              id.includes("@uiw/codemirror")
            )
              return "codemirror-vendor";
            if (id.includes("@xterm")) return "xterm-vendor";
            if (id.includes("react-virtuoso")) return "virtuoso-vendor";
            if (id.includes("@iconify")) return "icons-vendor";
            return "vendor";
          },
        },
      },
    },
  },
});
