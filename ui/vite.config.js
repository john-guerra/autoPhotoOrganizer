import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Config lives in ui/ and is used via `vite ui` (root = ui).
export default defineConfig({
  plugins: [svelte()],
  server: {
    port: 5173,
    proxy: {
      // Dev: forward API calls to the Express server on 4321.
      "/api": "http://localhost:4321",
    },
  },
  build: {
    // Emit the production bundle to the repo-root dist/, which the Express
    // server serves in production.
    outDir: "../dist",
    emptyOutDir: true,
  },
});
