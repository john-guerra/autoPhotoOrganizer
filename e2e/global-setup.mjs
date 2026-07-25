import { chromium } from "@playwright/test";
import { buildFixture, PHOTOS_DIR } from "./fixture.mjs";

const API = `http://127.0.0.1:${process.env.E2E_API_PORT ?? 4399}`;

async function waitForApi(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${API}/api/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`API never came up at ${API}`);
}

/**
 * Build the fixture photos, then scan them into the temp index so the UI has a
 * library to render. Runs after Playwright's webServer starts (its `url` probe
 * guarantees the stack is listening).
 */
export default async function globalSetup(config) {
  // E2E_KEEP_FIXTURE reuses whatever is already in e2e/.tmp/photos instead of
  // regenerating the small one — used to point the suite at a large library when
  // measuring performance (#97). Still hermetic: same temp dir, same temp index.
  if (!process.env.E2E_KEEP_FIXTURE) await buildFixture();
  await waitForApi();
  const res = await fetch(`${API}/api/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dir: PHOTOS_DIR, recursive: true }),
  });
  if (!res.ok) {
    throw new Error(`fixture scan failed: ${res.status} ${await res.text()}`);
  }

  // Warm the Vite dev server before any spec asserts (#190). On a COLD optimizer
  // cache — always the case in CI — the first page load makes Vite discover a
  // dep and log "Forced re-optimization of dependencies", which forces a full
  // reload; requests in flight for the pre-optimize /node_modules/.vite/deps/
  // chunks then 404. The browser logs that as a console error, which
  // `trackPageErrors` (watching console "error" events) catches, failing
  // a11y.spec.js's `expect(errors).toEqual([])`. Doing that first load HERE
  // absorbs the one-time re-optimize+reload; `networkidle` waits for it to
  // settle, so every spec afterwards loads against a stable, warm bundle. Best-
  // effort: a warmup hiccup must not block the suite — a genuinely broken app
  // still fails loudly in the specs themselves.
  const baseURL =
    config?.projects?.[0]?.use?.baseURL ??
    `http://localhost:${process.env.E2E_UI_PORT ?? process.env.VITE_PORT ?? 5399}`;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(baseURL, { waitUntil: "networkidle" });
  } catch (err) {
    console.warn(`[global-setup] Vite warmup skipped: ${err.message}`);
  } finally {
    await browser.close();
  }
}
