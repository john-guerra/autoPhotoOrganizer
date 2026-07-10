import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Config lives in ui/ and is used via `vite ui` (root = ui).
export default defineConfig({
  plugins: [svelte()],
  server: {
    port: 5173,
    proxy: {
      // Dev: forward API calls to the Express server. The port is resolved by
      // scripts/dev.mjs (issue #65) and passed via VITE_API_PORT so the proxy
      // stays in sync when 4321 is busy; falls back to 4321 for a bare
      // `vite ui` invocation.
      "/api": `http://localhost:${process.env.VITE_API_PORT || 4321}`,
    },
  },
  build: {
    // Emit the production bundle to the repo-root dist/, which the Express
    // server serves in production.
    outDir: "../dist",
    emptyOutDir: true,
  },
});
