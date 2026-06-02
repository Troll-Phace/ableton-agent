import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Webview SPA build config. Roots at `src/webview` and emits a SINGLE
// self-contained HTML file (all JS/CSS inlined) into `dist/webview/` so it never
// collides with the extension bundle at `dist/extension.js`. The single-file
// output keeps the A/B `data:`-URL embedding story open while staying
// transport-agnostic (Spike R3 decides the actual transport).
export default defineConfig({
  root: "src/webview",
  plugins: [viteSingleFile()],
  server: { port: 5173 },
  build: {
    outDir: "../../dist/webview",
    emptyOutDir: true,
  },
});
