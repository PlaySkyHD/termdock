// Builds the renderer only; main and preload are compiled by `tsc -b` (design add-desktop-shell).
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL("./src/renderer", import.meta.url)),
  // Loaded with `loadFile`, so asset URLs must be relative.
  base: "./",
  esbuild: { jsx: "automatic" },
  build: {
    outDir: fileURLToPath(new URL("./dist/renderer", import.meta.url)),
    emptyOutDir: true,
    target: "chrome140",
    // No inline scripts or data-URL modules: the CSP allows only 'self'.
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    // Loaded from disk, not over a network: one chunk of React plus xterm.js is fine.
    chunkSizeWarningLimit: 1_000,
  },
});
