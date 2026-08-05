import { test, expect } from "@playwright/test";
import {
  openApp,
  trackPageErrors,
  views,
  seedFaces,
  clearFaces,
} from "./helpers.js";

/**
 * The People and Face Map buttons follow the people who actually exist (#300).
 *
 * John, on 2.19.32, right after validating #250:
 *
 * > "the find faces, might have worked, but I cannot see the faces view or
 * > face map anymore"
 *
 * Both buttons are gated on `peopleCount`, and the only thing that set it ran
 * on mount, on entering People, when the ML panel closed, and after a merge —
 * never when a face JOB finished. So the everyday sequence left it stale: open
 * the panel, start Find faces, close the panel (the refresh fires there, with
 * nothing found yet), then the scan runs for minutes and App never learns.
 *
 * This is a tier-2 test on purpose. The staleness lives in the seam between
 * the jobs SSE store, `refreshPeople`, and the switcher's `offerable`
 * predicate — three modules that are each correct alone. A unit test on
 * `offerable` passes either way, which is exactly why the bug shipped:
 * `registry.test.js` has always covered the predicate.
 */

test.afterAll(async () => {
  // Seeded people persist for the rest of the RUN, and enough of them render
  // two extra toolbar controls. The toolbar folds by WIDTH, so leaving them
  // breaks specs that have never heard of faces (docs/AGENT-NOTES.md).
  await clearFaces();
});

test("@p1 the People and Face Map buttons appear once people exist, without a reload", async ({
  page,
}) => {
  const errors = trackPageErrors(page);
  await clearFaces();
  await openApp(page);

  // Nobody yet: neither button is offered.
  await expect(views.switchBtn(page, "people")).toHaveCount(0);
  await expect(views.switchBtn(page, "face-map")).toHaveCount(0);

  // People come into existence while the app is open, exactly as the end of a
  // face job does it.
  await seedFaces(6, 2);
  // The client learns through the jobs store, so nudge the same path a
  // finished scan takes rather than reloading — reloading is what used to be
  // required, and is the thing under test.
  await page.evaluate(async () => {
    await fetch("/api/ml/faces/cluster", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "regroup" }),
    });
  });

  await expect(views.switchBtn(page, "people")).toHaveCount(1, {
    timeout: 15000,
  });
  // A map of six is offered too, since #300 lowered the gate from 100 to
  // "any people at all".
  await expect(views.switchBtn(page, "face-map")).toHaveCount(1, {
    timeout: 15000,
  });

  expect(errors).toEqual([]);
});
