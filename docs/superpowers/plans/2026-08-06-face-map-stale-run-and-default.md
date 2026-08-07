# Face Map: stale runs and the neighbourhood default — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the Face Map serving a map of a library that no longer exists (#325), and move the UMAP neighbourhood default to the value that was actually measured (#326).

**Architecture:** Three small changes in three layers. The server stops honouring a run-cache hit whose member count no longer matches the library, because the cache key covers the parameters and not the inputs. The view turns its existing staleness caption into a button that triggers the rebuild it already describes. The schema's `nNeighbors` default moves 50 → 30, and its comment records the measurement that refutes deriving it from the point count.

**Tech Stack:** Node/Express (ESM), better-sqlite3, Svelte 5 runes, vitest, Playwright.

## Global Constraints

- **Branch `issue-325-stale-map-and-default`, based on `origin/testing`.** PR targets `testing`, never `main`.
- **Claimed version: `2.20.4`.** Do not hand-pick another. `package.json` and `CHANGELOG.md` are bumped in Task 4, not earlier.
- **ESM everywhere**, plain JS with JSDoc — no TypeScript.
- **Prettier** formats everything: `npm run format` before each commit.
- **A fixed bug gets a test that would have caught it, and the test must be seen to fail first.** Revert the fix, watch red, restore. This is not optional (`CLAUDE.md`).
- **Never edit anything under `server/` while an e2e run is in flight** — the dev server runs under `node --watch --watch-path=server` and restarts mid-suite, producing a 502 in an unrelated spec (`docs/AGENT-NOTES.md`).
- **`npm ci` has not necessarily run in this worktree.** Node resolution walks up to the parent checkout, so imports work and the suite looks fine — run `npm ci` before trusting a test result.
- Commit messages end with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

---

## File Structure

| File                                   | Responsibility                                      | Change                          |
| -------------------------------------- | --------------------------------------------------- | ------------------------------- |
| `server/projection/algorithms.js`      | The parameter schema and its measured justification | Modify (default + comment)      |
| `server/projection/algorithms.test.js` | Pins the default and keeps its note honest          | Modify                          |
| `server/api.js`                        | `POST /api/projections` cache-hit validity          | Modify (~line 2527)             |
| `server/projectionRoutes.test.js`      | The job/cache contract around the route             | Modify (helper + one test)      |
| `ui/src/lib/views/FaceMapView.svelte`  | The staleness affordance                            | Modify (~line 321)              |
| `e2e/helpers.js`                       | Shared selectors and index seeding                  | Modify (selector + `addPeople`) |
| `e2e/face-map.spec.js`                 | The map as a human meets it                         | Modify (one test)               |
| `package.json`, `CHANGELOG.md`         | Version and user-facing changelog                   | Modify (Task 4)                 |

---

## Task 1: The neighbourhood default (#326)

**Files:**

- Modify: `server/projection/algorithms.js:109-129`
- Modify: `server/projection/algorithms.test.js:217-241`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `ALGORITHMS` (unchanged shape) with the `umap` `nNeighbors` spec's `default` now `30`. `defaultParams({algorithm:"umap"}).nNeighbors === 30`.

- [ ] **Step 1: Update the failing assertion first, and watch it fail**

In `server/projection/algorithms.test.js`, replace the whole `describe("UMAP's default neighbourhood (#307)", …)` block with:

```js
describe("UMAP's default neighbourhood (#326)", () => {
  it("defaults to 30 — the value John picked on his own library", () => {
    // 30, from a sweep of 40 real UMAP runs across five photo scopes, John
    // picking the best cell in each. 30 is his pick for the WHOLE-LIBRARY
    // case, which is the case a default actually serves.
    const umap = ALGORITHMS.find((a) => a.id === "umap");
    const n = umap.params.find((p) => p.key === "nNeighbors");
    expect(n.default).toBe(30);
    expect(n.default).toBeGreaterThanOrEqual(n.min);
    expect(n.default).toBeLessThanOrEqual(n.max);
  });

  it("keeps the measured note honest about WHICH setting it measured", () => {
    // The 58.3% top-5 figure was measured at nNeighbors=15 and is not the
    // default. A measured number attached to the wrong configuration is worse
    // than no number — this repo has been bitten by comments describing states
    // that do not exist (#250, #279).
    const src = readFileSync(
      new URL("./algorithms.js", import.meta.url),
      "utf8"
    );
    expect(src).toMatch(/58\.3% top-5.*nNeighbors=15/);
  });

  it("records that the default must NOT be derived from the member count", () => {
    // #307's note argued the opposite ("a default derived from the point count
    // would preserve what he actually saw"), and that idea was tested and
    // refuted (#326). The refutation lives in a comment, so a test keeps the
    // comment alive — exactly like the 58.3% assertion above.
    const src = readFileSync(
      new URL("./algorithms.js", import.meta.url),
      "utf8"
    );
    expect(src).toMatch(/do not derive this from the member count/i);
  });
});
```

- [ ] **Step 2: Run it and verify two of the three fail**

Run: `npx vitest run server/projection/algorithms.test.js`
Expected: FAIL — `expected 50 to be 30`, and the "must NOT be derived" test fails because the phrase is not in the source yet. The 58.3% test passes.

- [ ] **Step 3: Change the default and rewrite its comment**

In `server/projection/algorithms.js`, replace the `nNeighbors` spec (currently lines 109–129) with:

```js
      Object.freeze({
        key: "nNeighbors",
        label: "Neighbours",
        min: 2,
        max: 200,
        step: 1,
        // 30, measured (#326). 40 real UMAP runs over the real library —
        // one seed, one minDist, 200 epochs, only this parameter moving —
        // rendered as small multiples with real face crops across five photo
        // scopes, and John picked the best cell in each:
        //
        //   whole library  255 people -> 30       Austria 2   42 -> 15
        //   Austria 5      151 people -> 22       Austria 4   53 -> 36
        //
        // DO NOT DERIVE THIS FROM THE MEMBER COUNT. #307's note argued for
        // exactly that ("a default derived from the point count would preserve
        // what he actually saw"), and the sweep above refutes it: Austria 2
        // and Austria 4 are 42 and 53 people — nearly the same size — and want
        // values 2.4x apart, so no f(members) can return both. Fitting one
        // anyway gives `k = 12.4 * members^0.149`, R^2 = 0.11 (linear would be
        // exponent 1.0, sqrt 0.5). A cheap clustering pass does not rescue it
        // either: those two scopes have near-identical structure (9 vs 15
        // components at cosine 0.5, mean cluster size 4.7 vs 3.5) and every
        // structural measure correlates r ~ 0.2 with the picks.
        //
        // The honest reading is that the right neighbourhood is a property of
        // the photographs, not of anything the index can count — which is why
        // #327 makes the control live rather than making the default cleverer.
        // Full method and caveats:
        // `docs/superpowers/specs/2026-08-06-face-map-neighbourhood-design.md`.
        default: 30,
        help: "How much of the neighbourhood each point is fitted to. Low values keep tight local groups; high values favour the overall shape.",
      }),
```

- [ ] **Step 4: Run the projection unit tests**

Run: `npx vitest run server/projection/`
Expected: PASS, all files.

- [ ] **Step 5: Verify the module still loads under real Node**

Run: `node -e "import('./server/projection/algorithms.js').then(m => console.log(m.ALGORITHMS.find(a=>a.id==='umap').params.find(p=>p.key==='nNeighbors').default))"`
Expected: prints `30`. (Vitest's SSR transform can hide a real `SyntaxError` — `docs/AGENT-NOTES.md`.)

- [ ] **Step 6: Format and commit**

```bash
npm run format
git add server/projection/algorithms.js server/projection/algorithms.test.js
git commit -m "fix(face-map): default the neighbourhood to 30, and record why it cannot be computed (#326)

A sweep of 40 real UMAP runs across five photo scopes: two scopes of nearly
the same size (42 and 53 people) want neighbourhoods 2.4x apart, so no
f(members) fits. A power law gives exponent 0.149 at R^2 = 0.11.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: A cache hit must still describe the library (#325, server)

**Files:**

- Modify: `server/projectionRoutes.test.js:73` (the `seedPeople` helper) and the `POST /api/projections` describe block
- Modify: `server/api.js:2527-2540`

**Interfaces:**

- Consumes: `seedPeople(n, facesEach)` from the existing test file; `settled(jobId)`; `post(body)`.
- Produces: `seedPeople(n, facesEach = 2, from = 1)` — seeding people `from..n` inclusive, so a test can add people to an existing library. No production interface changes: `POST /api/projections` keeps returning `{reused, runId, members}` on a valid hit and `{jobId, members, algorithm}` (201) otherwise.

- [ ] **Step 1: Let the test helper add people without re-seeding the old ones**

In `server/projectionRoutes.test.js`, change the `seedPeople` signature and loop:

```js
/**
 * People `from..n` with `facesEach` faces apiece, spread over distinct
 * directions.
 *
 * `from` exists so a test can GROW the library after a map has been built —
 * the case #325 is about. Re-running from 1 would collide on
 * `persons.id`, since the ids are explicit.
 */
function seedPeople(n, facesEach = 2, from = 1) {
  const db = getDb();
  for (let p = from; p <= n; p++) {
```

Leave the body of the loop exactly as it is.

- [ ] **Step 2: Write the failing test**

Add this immediately after the existing `it("a cache hit starts NO job at all", …)` in the `POST /api/projections` describe block:

```js
it("does NOT reuse a run whose library has grown since (#325)", async () => {
  // The cache key covers the PARAMETERS. The run's real input is the member
  // set, which the key cannot see — so a map built while face grouping was
  // half done was served forever, and the DEFAULT parameters are the worst
  // case because they are the first map anyone builds.
  seedPeople(8);
  const first = await post({ minFaces: 2, nEpochs: 30 });
  await settled(first.body.jobId);

  seedPeople(12, 2, 9); // four more people since that map was built

  const again = await post({ minFaces: 2, nEpochs: 30 });
  expect(again.body.reused).toBeUndefined();
  expect(again.status).toBe(201);
  const job = await settled(again.body.jobId);
  expect(job.result.members).toBe(12);
});

it("still reuses a run when the library has NOT changed (#325)", async () => {
  // The other half: revalidating must not turn every hit into a rebuild.
  seedPeople(8);
  const first = await post({ minFaces: 2, nEpochs: 30 });
  await settled(first.body.jobId);
  const again = await post({ minFaces: 2, nEpochs: 30 });
  expect(again.body.reused).toBe(true);
  expect(again.body.jobId).toBeUndefined();
});
```

- [ ] **Step 3: Run it and verify the first one fails**

Run: `npx vitest run server/projectionRoutes.test.js -t "library has grown"`
Expected: FAIL — `expected true to be undefined` (the route reuses the 8-person run).

- [ ] **Step 4: Make the cache hit conditional**

In `server/api.js`, replace the cache block (currently lines 2527–2540) with:

```js
const pk = paramsKey(params);
const cached = findRun(db, {
  kind: "person",
  model: modelId,
  algorithm,
  paramsKey: pk,
});
// A hit is only honoured while the run still DESCRIBES the library (#325).
// `paramsKey` covers the parameters; the run's real input is the member
// set, which the key cannot see — so a map built while face grouping was
// half done was served forever, and the DEFAULT parameters are the worst
// case, because they are the first map anyone builds and therefore the
// stalest run they own.
//
// Comparing the count here rather than folding a member fingerprint INTO
// the key is deliberate: a fingerprint would make a background face sweep
// silently invalidate every map the user owns, each costing 4-20s to
// rebuild. This gets the same correctness at the one moment the user has
// actually asked for a map. `GET /current` is unchanged — a read must not
// start a job — and keeps reporting `staleness` for the view to act on.
if (cached && cached.members === members) {
  return res.json({
    reused: true,
    runId: cached.id,
    members: cached.members,
  });
}
```

- [ ] **Step 5: Run the route tests**

Run: `npx vitest run server/projectionRoutes.test.js`
Expected: PASS, including the pre-existing "a cache hit starts NO job at all".

- [ ] **Step 6: Confirm the new test would have caught the bug**

Revert only the guard — change `if (cached && cached.members === members)` back to `if (cached)` — and run:

Run: `npx vitest run server/projectionRoutes.test.js -t "library has grown"`
Expected: FAIL. Then restore the guard and re-run: PASS. A test that never failed proves nothing.

- [ ] **Step 7: Verify the server still boots under real Node**

Run: `node -e "import('./server/api.js').then(() => console.log('api.js loads'))"`
Expected: prints `api.js loads`.

- [ ] **Step 8: Format and commit**

```bash
npm run format
git add server/api.js server/projectionRoutes.test.js
git commit -m "fix(face-map): a run-cache hit must still describe the library (#325)

findRun keys on the parameters, not on the member set, so a map built while
face grouping was half done was reused forever. The default parameters are
the worst case: they are the first map anyone builds, and the one the app
shows on every fresh session.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: The staleness caption becomes a button (#325, UI)

**Files:**

- Modify: `ui/src/lib/views/FaceMapView.svelte:321-328` (markup) and its `<style>` block
- Modify: `e2e/helpers.js` — add `faceMap.stale` and an `addPeople` seeder
- Modify: `e2e/face-map.spec.js` — one test

**Interfaces:**

- Consumes: `applyGear()` and the `loading` prop, both already in `FaceMapView.svelte`; the route behaviour from Task 2.
- Produces: `faceMap.stale(page)` — a Playwright locator for `[data-testid="map-stale"]`, now a `<button>`. `addPeople(from, to, facesEach)` — adds people to the scratch index **without** wiping faces, persons or projection runs (which is what `seedFaces` does).

- [ ] **Step 1: Add the helper and the selector**

In `e2e/helpers.js`, add to the `faceMap` object, just after the `count` entry:

```js
  /**
   * The "N added since — rebuild to place them" affordance.
   *
   * A BUTTON, not a caption (#325). `docs/TESTING.md` exists because a
   * "Remove" button once rendered correctly and silently did nothing.
   */
  stale: (page) => page.locator('[data-testid="map-stale"]'),
```

And add this exported function immediately after `seedFaces`:

```js
/**
 * Add people to the scratch index WITHOUT wiping what is already there.
 *
 * `seedFaces` deletes every face, person and projection run before it seeds,
 * which is right for a fresh test and useless for #325 — that bug is
 * specifically "a run exists and the library grew underneath it". Same
 * scratch-index-only guarantee as `seedFaces`.
 *
 * @param {number} from first person id to create (inclusive)
 * @param {number} to last person id to create (inclusive)
 * @param {number} facesEach faces per person; must clear the product's
 *   `minFaces` default or the new people never reach the map
 */
export async function addPeople(from, to, facesEach = 5) {
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(
    join(process.cwd(), "e2e", ".tmp", "home", "index.db")
  );
  try {
    const model = "buffalo_s";
    const photos = db
      .prepare(
        `SELECT id FROM photos WHERE stale = 0 AND kind = 'image' ORDER BY id`
      )
      .all()
      .map((r) => r.id);
    if (!photos.length) throw new Error("addPeople: no photos to attach to");

    const DIM = 16;
    const insPerson = db.prepare(
      `INSERT INTO persons (id, name, created_at) VALUES (?, ?, ?)`
    );
    const insFace = db.prepare(
      `INSERT INTO photo_faces
         (photo_id, model, box_x, box_y, box_w, box_h, det_score,
          dim, scale, vec, person_id, person_source, created_at)
       VALUES (?, ?, 0, 0, 10, 10, 0.9, ?, ?, ?, ?, 'model', ?)`
    );
    db.transaction(() => {
      for (let p = from; p <= to; p++) {
        insPerson.run(p, null, 1000 + p);
        for (let f = 0; f < facesEach; f++) {
          const bytes = new Int8Array(DIM);
          for (let i = 0; i < DIM; i++) {
            bytes[i] = Math.round(Math.sin(i * 0.7 + p * 1.3 + f * 0.05) * 100);
          }
          insFace.run(
            photos[(p * facesEach + f) % photos.length],
            model,
            DIM,
            0.01,
            Buffer.from(bytes.buffer),
            p,
            Date.now()
          );
        }
      }
    })();
  } finally {
    db.close();
  }
}
```

- [ ] **Step 2: Write the failing e2e test**

In `e2e/face-map.spec.js`, add `addPeople` to the import list from `./helpers.js`, and add this test inside the `face map @p1` describe block, after `"says what it cannot show, and builds a map on request"`:

```js
test("a map built before more people arrived offers a rebuild that WORKS", async ({
  page,
}) => {
  // #325: the run cache keyed on parameters only, so a map built while face
  // grouping was still running was served forever. The view knew — it has
  // always rendered "N added since" — but it was a CAPTION beside a map that
  // looks broken, not something you could press.
  const errors = trackPageErrors(page);
  await openApp(page);
  await views.show(page, "face-map");
  await faceMap.build_(page);
  await expect(faceMap.count(page)).toContainText(String(PEOPLE));

  // Grouping carries on: 30 more people now clear the threshold.
  await addPeople(PEOPLE + 1, PEOPLE + 30, FACES_EACH);

  // Leaving and returning re-fetches /current, which is what reports drift.
  await views.show(page, "grid");
  await views.show(page, "face-map");
  await expect(faceMap.stale(page)).toContainText("30");

  // Press it. This is the assertion the whole test exists for.
  await faceMap.stale(page).click();
  await expect(faceMap.count(page)).toContainText(String(PEOPLE + 30), {
    timeout: 30_000,
  });
  await expect(faceMap.stale(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});
```

- [ ] **Step 3: Run it and verify it fails**

Run: `npm run test:e2e -- e2e/face-map.spec.js -g "offers a rebuild that WORKS"`
Expected: FAIL — the locator resolves to a `<span>`, and Playwright's click on it does nothing, so `map-count` never reaches 150.

- [ ] **Step 4: Make it a button**

In `ui/src/lib/views/FaceMapView.svelte`, replace the staleness block (currently lines 321–328) with:

```svelte
{#if staleness?.missing > 0}
  <!-- A BUTTON, not a caption (#325). The join keeps WHO is on the map
             truthful and only positions age — but a map missing a third of the
             library beside a line of grey text reads as "broken", not as
             "press this". `applyGear` is reused rather than a second code
             path: it is already "clear the selection and run with the current
             parameters", which is exactly what this is. -->
  <button
    class="stale"
    data-testid="map-stale"
    disabled={loading}
    onclick={applyGear}
  >
    {n(staleness.missing)} added since — rebuild to place them
  </button>
{/if}
```

And add to the component's `<style>` block, next to the existing `.warn` rule:

```css
.stale {
  font: inherit;
  font-size: 0.85em;
  color: var(--warn, #d08a20);
  background: transparent;
  border: 1px solid currentColor;
  border-radius: 999px;
  padding: 2px 10px;
  cursor: pointer;
}
.stale:hover:not(:disabled) {
  background: color-mix(in srgb, currentColor 14%, transparent);
}
.stale:disabled {
  cursor: default;
  opacity: 0.6;
}
```

- [ ] **Step 5: Run the e2e test again**

Run: `npm run test:e2e -- e2e/face-map.spec.js -g "offers a rebuild that WORKS"`
Expected: PASS.

- [ ] **Step 6: Run the whole face-map spec, so the new seeding does not leak**

Run: `npm run test:e2e -- e2e/face-map.spec.js`
Expected: PASS. The file's `beforeEach` calls `seedFaces`, which wipes persons/faces/runs, so people 121–150 cannot reach the next test; `afterAll` calls `clearFaces`. If anything downstream goes red, re-read the leaking-spec section of `docs/AGENT-NOTES.md` before changing the test.

- [ ] **Step 7: Format and commit**

```bash
npm run format
git add ui/src/lib/views/FaceMapView.svelte e2e/helpers.js e2e/face-map.spec.js
git commit -m "fix(face-map): make the 'N added since' notice a button that rebuilds (#325)

It has always said the map is out of date; it was a caption beside a map
that looks broken. e2e presses it, because a control that renders and does
nothing is the bug class docs/TESTING.md exists for.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Version, changelog, and the full suite

**Files:**

- Modify: `package.json` (version)
- Modify: `CHANGELOG.md` (new top entry)

**Interfaces:**

- Consumes: everything from Tasks 1–3.
- Produces: nothing downstream.

- [ ] **Step 1: Bump to the claimed version**

Set `"version": "2.20.4"` in `package.json`. **Do not pick a different number** — `2.20.4` was claimed with `claim-version.sh` and a remote `claim/2.20.4` tag holds it.

- [ ] **Step 2: Add the changelog entry**

Insert directly below the intro paragraph in `CHANGELOG.md`, above `## 2.20.2`:

```markdown
## 2.20.4

- **The Face Map no longer shows you a map of a library you no longer have.**
  A map is stored under the settings it was built with, and asking for those
  same settings handed back the old map even after face grouping had found
  hundreds more people — with the default settings hit hardest, since that is
  the first map you ever build. Building now notices and rebuilds (#325).
- **"N added since" is a button.** It always told you the map was out of date;
  now you can press it (#325).
- **Neighbours defaults to 30.** Picked from 40 real projections of your own
  library across five albums. The previous 50 came from one screenshot, and a
  fresh comparison did not reproduce it (#326).
```

- [ ] **Step 3: Run the full unit suite**

Run: `npm test`
Expected: PASS, with the new projection-route tests included. Note the count.

- [ ] **Step 4: Run the critical-path e2e**

Run: `npm run test:e2e -- --grep @p0`
Expected: PASS. Then `npm run test:e2e -- e2e/face-map.spec.js`.

- [ ] **Step 5: Commit**

```bash
npm run format
git add package.json CHANGELOG.md
git commit -m "chore(release): 2.20.4 — face map staleness and neighbourhood default (#325, #326)

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: Manually drive the reported scenario**

`CLAUDE.md` requires this for anything touching the Face Map's state: start the app, build a map, add people (or let a face sweep run), return to the view, and press the rebuild button. Confirm the count moves and the badge disappears. **Read the version in the title bar first** — an abandoned dev server on another port will happily serve you stale code (`docs/AGENT-NOTES.md`).

- [ ] **Step 7: Open the PR**

```bash
gh pr create --base testing \
  --title "fix(face-map): stop serving stale maps, and default the neighbourhood to 30 (#325, #326)" \
  --body "Refs #325
Refs #326

<what the user can now do, the evidence, and the revert-to-red confirmation>"
```

Then per the `working-issues` skill: swap `wip` → `needs-validation` on both issues after merge, post an evidence comment, release the claim tag with `git push origin :refs/tags/claim/2.20.4`, and leave the issues **open** for John to close.

---

## Self-review

**Spec coverage.** Spec §"What we build" has three numbered items: (1) the default and its comment → Task 1; (2) a cache hit must still describe the library, including `GET /current` unchanged and the badge becoming a button → Tasks 2 and 3; (3) tests at the tier that would have caught it → Task 2 Step 6 (revert-to-red on the server) and Task 3 Step 3 (the e2e fails before the button exists). Spec §"What this deliberately does not do" adds no tasks by design.

**Placeholder scan.** One intentional placeholder remains: the PR body in Task 4 Step 7, which cannot be written before the test counts exist. Every code step carries real code.

**Type consistency.** `seedPeople(n, facesEach, from)` is defined in Task 2 Step 1 and used in Step 2. `addPeople(from, to, facesEach)` is defined in Task 3 Step 1 and used in Step 2. `faceMap.stale` is added in Task 3 Step 1 and used in Steps 2 and 4. `applyGear` and `loading` already exist in `FaceMapView.svelte` and are not redefined. `job.result.members` matches `registry.finish(job.id, { runId, members, algorithm })` in `server/api.js:2577`, as asserted by the existing "finishes with a summary" test.
