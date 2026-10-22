import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

/**
 * jsPDF lazily imports html2canvas / dompurify / canvg for its HTML and SVG-to-image
 * helpers, which Flow never calls. Stub them so they are not inlined.
 */
function stubOptional(names: string[]): Plugin {
  return {
    name: "flow-stub-optional",
    enforce: "pre",
    resolveId(id) { return names.includes(id) ? `\0stub:${id}` : null; },
    load(id) { return id.startsWith("\0stub:") ? "export default null;" : null; },
  };
}

// One self-contained dist/index.html: JS, CSS, fonts and the simulation worker (inlined as a Blob) are all in it.
export default defineConfig({
  plugins: [stubOptional(["html2canvas", "dompurify", "canvg"]), react(), viteSingleFile({ removeViteModuleLoader: true })],
  server: { port: 5176 },
  build: { target: "es2022", chunkSizeWarningLimit: 8000, assetsInlineLimit: 100_000_000, cssCodeSplit: false },
  worker: { format: "iife" },
});
