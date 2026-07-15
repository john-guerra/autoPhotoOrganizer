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
  resolve: {
    alias: {
      // multi-auto-select's UMD build expects sortablejs's default export to BE
      // the Sortable class — it calls `Sortable.create(...)`. Vite 8 / esbuild
      // resolves sortablejs through its ESM "module" field and hands the UMD
      // factory the ESM *namespace* ({ default, Sortable, Swap, MultiDrag })
      // instead, so `.create` is undefined on the root and the grouping widget
      // throws "e.create is not a function", blanking the whole app. Point
      // sortablejs at its CJS/UMD build, whose single default export IS the
      // class. (Vite 5 interoped this the old way; Vite 8 changed it.)
      sortablejs: "sortablejs/Sortable.min.js",
    },
  },
  // Compile-time constant so the UI can show its version without importing the
  // whole package.json into the bundle.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    // Bind IPv4 loopback explicitly. Left to its default, Vite resolves its
    // `localhost` host under Node's verbatim DNS order and, on machines that list
    // ::1 first, binds IPv6-ONLY. Electron's Chromium loads `localhost` as IPv4
    // 127.0.0.1 first, finds nothing there, and shows a blank window (and the
    // Express API is IPv4-only too). Pinning 127.0.0.1 keeps the whole dev stack
    // on one address family.
    host: "127.0.0.1",
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
