# Testing AutoGallery

Two tiers, on purpose. They fail for different reasons, and you run them at
different moments.

| Tier            | Tool       | Where                                            | Runs in | Answers                                         |
| --------------- | ---------- | ------------------------------------------------ | ------- | ----------------------------------------------- |
| **Unit / core** | vitest     | `server/**/*.test.js`, `ui/src/lib/**/*.test.js` | ~2s     | "is this function's logic right?"               |
| **UI / e2e**    | Playwright | `e2e/*.spec.js`                                  | ~30s    | "does the app still work when a human uses it?" |

```bash
npm test              # tier 1 — fast, DOM-free, run constantly
npm run test:e2e      # tier 2 — real Chromium against a real server
npm run test:e2e -- e2e/culling.spec.js    # one module, for a tight loop
npm run test:e2e -- --grep @p0             # just the critical path
```

## Why the second tier exists

During the 2.9.x usability round **619 unit tests stayed green while five bugs
shipped to the user**, including two hard crashes. Every one of them lived in the
gap the unit tests could not see:

- a CSS class collision that flex-grew a toggle button to 1193px;
- a regex edit that ate a shared selector list, ballooning a header on hover;
- `Cannot read properties of undefined (reading 'replace')` when collapsing a
  nested group;
- `_collapsedKeys.has is not a function` — one call site still passing an Array;
- a "Remove" button that rendered on `folderName` groups and **silently did
  nothing** when clicked.

The lesson is specific: **a green suite plus a plausible screenshot is not
verification.** The last one is the sharpest — the button was verified to
_appear_ and was never _clicked_. So the e2e tests click things, and every spec
asserts `expect(errors).toEqual([])` via `trackPageErrors`, which alone would
have caught the two crashes.

## The pyramid, and what belongs where

Push logic **down** into tier 1 wherever you can — it's 15× faster and it
localizes the failure. Reach for tier 2 only for what genuinely needs a browser:

**Tier 1 (vitest)** — pure functions and data shape: layout math
(`sectionedJustified`), the renderer registry (`groupRenderers`), filter specs,
album clustering, SQLite queries, path safety (`safeResolve`).

**Tier 2 (Playwright)** — anything where the bug lives _between_ the parts:

- **rendering & CSS** (geometry, collisions, hover states) — unreachable from JS assertions;
- **persistence round-trips** — did the rating actually reach SQLite?
- **wiring** — is the button connected to a handler that does something?
- **crash regressions** — did this interaction throw?

## Priority tags

Specs are tagged so you can run the important ones alone (`--grep @p0`).

| Tag   | Meaning                                                              |
| ----- | -------------------------------------------------------------------- |
| `@p0` | If this breaks, the app has failed at its job or has destroyed work. |
| `@p1` | A core workflow is broken but the user's data is safe.               |
| `@p2` | Polish, affordances, edge cases.                                     |

### Current coverage

| Spec               | Tag | Covers                                                                                                                                                                                                                         |
| ------------------ | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `culling.spec.js`  | @p0 | **Rating photos** — the thing the app is FOR. 1–5 and 0 persist across a reload; loupe stars persist; a rating lands on the right photo and not its neighbour; typing digits in a text field does not silently re-rate.        |
| `grouping.spec.js` | @p0 | **Nested groups** — the feed nests/indents; folding a child, folding a parent, and snapshotting a parent after a child all work and do not throw. Every test here is a crash that shipped.                                     |
| `feed.spec.js`     | @p1 | Feed loads and renders headers; a group cycles grid → snapshot → collapsed; the header does not resize on hover; the toggle stays icon-sized; the select circle selects without opening the loupe; the loupe opens and closes. |

Next up (see issue #101): select-all/clear/keep-only, export (copy **and** move,
plus undo), the tree sidebar, and the offline/server-down banner.

## How the e2e stack works

It is **hermetic** — it never touches your real photo library, and it must stay
that way.

- `playwright.config.js` boots its own API (`:4399`) and Vite (`:5399`), so it
  never collides with a dev server on 4321/5173.
- `AUTOGALLERY_HOME` points at `e2e/.tmp/home`, so the SQLite index is a scratch
  database, not `~/.autogallery/`.
- `e2e/fixture.mjs` generates the photos with sharp: 2 folders × 2 days, tiny
  JPEGs with real EXIF capture dates.
- `e2e/global-setup.mjs` builds the fixture, waits for `/api/health`, and scans.

> **EXIF gotcha:** `DateTimeOriginal` must be written to **`IFD2`** (the Exif
> IFD). Put it in `IFD0` and sharp accepts it, exifr never finds it, every photo
> scans with no capture date, and every date group silently renders "Unknown."
> The fixture shipped that way once.

## Writing a spec

**Selectors live in `e2e/helpers.js`, never in a spec.** A spec should read as
behaviour — `rate the focused photo 3, reload, it's still 3` — so that when the
markup changes you fix one line in one file. The helpers also encode the app's
real quirks, and one of them will bite you:

> **A click opens the loupe on a tile that is _already_ focused** — and
> `selected` defaults to **0**, so a plain click on the _first_ tile opens the
> loupe straight away. A spec that assumes "first click just focuses" ends up
> typing into the loupe, where rating **auto-advances**, so every keystroke
> lands on the _next_ photo and the assertions fail for a reason that has
> nothing to do with the bug you're chasing. Use `grid.focus()` (grid, loupe
> closed) and `loupe.open()` (loupe up) instead of clicking by hand.

Three rules learned the hard way:

1. **Always call `trackPageErrors(page)` and assert it's empty.** It's free and
   it catches the class of bug that hurt most.
2. **Reset global state in `beforeEach`.** Ratings live in SQLite and outlive a
   spec — use `resetRatings(page)`, or a photo rated by test 1 will fail an
   "unrated" assertion in test 5 and look like a product bug.
3. **Seed state instead of driving third-party widgets.** `openApp(page, {
groupBy: ["folder", "day"] })` writes the same localStorage key the app reads
   on boot. A test about _folding_ should not break because the Group-by
   combobox changed its markup.

## Before you call something done

Per `CLAUDE.md`: if you touched feed-window ordering, selection, or CSS, run the
app and **drive the actual reported scenario**. The e2e suite is a floor, not a
ceiling — it catches what it was written to catch.
