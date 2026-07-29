import { defineConfig } from "@playwright/test";
import { join } from "node:path";

/**
 * End-to-end UI tests.
 *
 * Why these exist: the vitest suite covers PURE modules only ("components are
 * exercised in the browser"), so nothing automated ever clicked anything. Every
 * regression in the 2.9.x usability batch — a hover that ballooned the header, a
 * renderer id colliding with a CSS class, a collapse that threw TypeError — was a
 * click-level bug that pure-function tests structurally cannot catch. These do.
 *
 * Hermetic: a temp AUTOGALLERY_HOME and generated fixture photos. The real
 * library and ~/.autogallery are never touched (CLAUDE.md's read-only rule
 * applies to tests too). High ports so a running dev server doesn't collide.
 *
 * Ports come from E2E_API_PORT / E2E_UI_PORT, defaulting to 4399 / 5399 (#192).
 * Several agents work this repo at once; with the ports hardcoded, a second
 * agent's `npx playwright test` collided on them and couldn't run until the
 * first finished (observed 3× in one session). An agent can now run on a
 * private pair, e.g. `E2E_API_PORT=4601 E2E_UI_PORT=5601 npx playwright test`.
 * global-setup.mjs already reads E2E_API_PORT for its API probe.
 */
const API_PORT = Number(process.env.E2E_API_PORT) || 4399;
const UI_PORT = Number(process.env.E2E_UI_PORT) || 5399;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.js/,
  globalSetup: "./e2e/global-setup.mjs",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false, // one shared library + one dev server
  workers: 1,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: `http://localhost:${UI_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    // Wipe the scratch index BEFORE the server opens it.
    //
    // The ordering here is load-bearing and was invisible for a long time.
    // Playwright starts this webServer FIRST, then runs globalSetup — which
    // used to `rm -rf` the whole `e2e/.tmp`, including the `index.db` the
    // server had already opened. SQLite carried on through the open
    // descriptor, so the suite worked perfectly, but the database existed at
    // no path at all and nothing outside the server process could read or seed
    // it.
    //
    // Doing the wipe here instead keeps the property that mattered (a fresh
    // index every run — tags, keep-scope and ratings must not leak between
    // runs) while making the file real, which is what lets a spec seed rows no
    // API can create (see `seedFaces`, #232). `buildFixture` now clears only
    // the photos.
    //
    // Spelled with node rather than `rm -rf` so it works wherever npm does.
    command: `node -e "require('node:fs').rmSync(${JSON.stringify(
      join(process.cwd(), "e2e", ".tmp", "home")
    ).replace(/"/g, "'")}, { recursive: true, force: true })" && npm run dev`,
    url: `http://localhost:${UI_PORT}`,
    reuseExistingServer: false,
    timeout: 90_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PORT: String(API_PORT),
      VITE_API_PORT: String(API_PORT),
      VITE_PORT: String(UI_PORT),
      AUTOGALLERY_HOME: join(process.cwd(), "e2e", ".tmp", "home"),
    },
  },
});
