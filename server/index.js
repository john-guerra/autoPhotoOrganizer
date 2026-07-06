import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { registerApi } from "./api.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT ? Number(process.env.PORT) : 4321;
// Bind loopback only — this app serves the local user's photo library and must
// never be reachable from the network.
const HOST = "127.0.0.1";

export function createApp() {
  const app = express();
  app.use(express.json());

  // Health check — proves the dev loop end to end.
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", version });
  });

  // v0.1 culling API: scan, thumbnails, full images, ratings.
  registerApi(app);

  // In production, serve the built UI. In dev, the Vite server owns the UI
  // and proxies /api here (see ui/vite.config.js).
  //
  // NOTE: there is intentionally no user-controlled file-serving endpoint yet.
  // When one is added, every path MUST be validated with server/lib/safeResolve.js
  // to prevent the path-traversal class of bug the legacy app was flagged for.
  const distDir = join(__dirname, "..", "dist");
  if (existsSync(distDir)) {
    app.use(express.static(distDir));
  }

  return app;
}

// Only listen when run directly (not when imported by tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = createApp();
  app.listen(PORT, HOST, () => {
    console.log(`AutoGallery server listening on http://${HOST}:${PORT}`);
  });
}
