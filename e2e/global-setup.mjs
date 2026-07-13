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
export default async function globalSetup() {
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
}
