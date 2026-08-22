import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist/bridge",
    emptyOutDir: true,
    sourcemap: false,
    minify: false,
    lib: {
      entry: resolve(import.meta.dirname, "src/bridge/bridge.ts"),
      name: "AgentHtmlRenderBridge",
      formats: ["iife"],
      fileName: () => "bridge.js",
    },
  },
});
