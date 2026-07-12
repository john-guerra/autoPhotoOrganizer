import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Config lives in ui/ and is used via `vite ui` (root = ui).
const pkg = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../package.json", import.meta.url)),
    "utf8"
  )
);

export default defineConfig({
  plugins: [svelte()],
  // Compile-time constant so the UI can show its version without importing the
  // whole package.json into the bundle.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    // VITE_PORT lets the e2e stack run on its own port (playwright.config.js) so
    // it never collides with a dev server you already have on 5173.
    port: Number(process.env.VITE_PORT) || 5173,
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
