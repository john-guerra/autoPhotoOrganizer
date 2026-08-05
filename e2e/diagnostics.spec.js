import { test, expect } from "@playwright/test";
import { openApp, trackPageErrors } from "./helpers.js";

/**
 * The flight recorder, as a user reaches it (#314).
 *
 * A log nobody can find is a log nobody attaches to a bug report, so the path
 * has to be reachable from the app — and the button has to WORK, not merely
 * render. `docs/TESTING.md` exists because a "Remove" button once rendered
 * perfectly and silently did nothing when pressed.
 *
 * Tier 2 on purpose: the thing under test is the seam between a panel, a
 * route, and the file the server actually opened. Every part is correct alone.
 */

test("@p2 the app records what it was doing, and says where", async ({
  page,
  context,
}) => {
  // The panel copies the path, and headless Chromium refuses clipboard writes
  // without this. The refusal path has its own assertion below.
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const errors = trackPageErrors(page);
  await openApp(page);

  // Opening the app is itself traffic, so by now the log has content.
  const before = await page.evaluate(async () => {
    const r = await fetch("/api/debug/trace?limit=500");
    return r.json();
  });
  expect(before.enabled).toBe(true);
  expect(before.path).toMatch(/logs\/trace-\d{8}-\d{6}\.ndjson$/);
  // Requests are recorded with a verb, a URL and a status — the three things
  // that make a line worth having.
  const http = before.entries.filter((e) => e.ch === "http");
  expect(http.length).toBeGreaterThan(0);
  expect(http[0]).toMatchObject({
    m: expect.any(String),
    s: expect.any(Number),
  });

  // The BROWSER's half lands in the same stream, which is the whole point:
  // one clock, both sides.
  await page.evaluate(async () => {
    await fetch("/api/debug/trace", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        entries: [{ ev: "spec-marker", t: Date.now(), ch: "health", ms: 4000 }],
      }),
    });
  });
  const after = await page.evaluate(async (since) => {
    const r = await fetch(`/api/debug/trace?since=${since}`);
    return r.json();
  }, before.entries.at(-1).seq);
  const mine = after.entries.find((e) => e.ev === "spec-marker");
  expect(mine).toBeTruthy();
  expect(mine.ch).toBe("ui:health");
  // The client's own timestamp survives alongside the server's receipt time.
  expect(mine.ct).toBeGreaterThan(0);

  // And a user can get at it. `,` opens the settings panel (App.svelte owns
  // the key).
  await page.keyboard.press(",");
  await expect(page.getByTestId("diagnostics")).toBeVisible();
  await page.getByTestId("diag-copy").click();
  // The path shown is the file the SERVER actually opened, not a guess
  // assembled in the client.
  await expect(page.getByTestId("diag-path")).toHaveText(before.path);

  expect(errors).toEqual([]);
});
