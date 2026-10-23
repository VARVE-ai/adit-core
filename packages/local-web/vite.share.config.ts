import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// Ship the same renderer as the local preview, including its dependencies.
// The installed CLI loads this Node module; recipients need only the resulting HTML.
export default defineConfig({
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  ssr: { noExternal: true },
  build: {
    ssr: fileURLToPath(new URL("./src/share-html.tsx", import.meta.url)),
    outDir: "../cli/local-assets/share",
    emptyOutDir: true,
    copyPublicDir: false,
    rollupOptions: { output: { entryFileNames: "render.mjs", inlineDynamicImports: true } },
  },
});
