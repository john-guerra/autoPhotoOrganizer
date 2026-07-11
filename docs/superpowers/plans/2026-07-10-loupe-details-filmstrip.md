# Loupe Details Panel + Filmstrip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a right-hand details panel with full EXIF and a windowed neighbor filmstrip to the Loupe (detail view), both toggleable and remembered, replacing the current bottom HUD.

**Architecture:** Backend gains EXIF extraction (exifr) persisted in new `photos` columns and returned by `/api/meta`. Frontend splits `Loupe.svelte` into a shell + `LoupeDetails.svelte` + `LoupeFilmstrip.svelte`; the Loupe lazily fetches full per-photo meta so EXIF cost stays off the grid. Pure logic (EXIF mapping, value formatting, filmstrip windowing) is extracted and unit-tested; Svelte components are live-verified (no component-test harness exists).

**Tech Stack:** Node/Express, better-sqlite3, exifr, sharp; Svelte 4 + Vite; vitest.

## Global Constraints

- **ESM everywhere**; **plain JS with JSDoc** (no TypeScript).
- **Svelte 4** idioms only (`export let`, `$:`, `createEventDispatcher`, `class:`); no runes.
- Tests: **vitest**, colocated `*.test.js` next to sources under `server/` (and `ui/src/lib/` for pure UI helpers).
- Every change **bumps the patch version** in `package.json` and adds a user-facing `CHANGELOG.md` line in the same commit; keep the `-alpha` suffix. Current version at plan start: `2.8.0-alpha` → first patch is `2.8.1-alpha`.
- **No Svelte component-test harness** exists — Svelte components are verified by live browser interaction, per CLAUDE.md/ROADMAP. Extract pure logic into `.js` modules and unit-test *those*.
- Format your own changed files only (`npx prettier --write <file>`); the repo is not prettier-clean and `.svelte` has no parser configured.
- Commit after each task.

---

### Task 1: EXIF extraction in the processing engine

**Files:**
- Modify: `server/processing/NodeProcessingService.js` (add `exifToMeta` export; extend `metadata()`'s exifr `pick` + mapping)
- Modify: `server/processing/ProcessingService.js` (extend the `MediaMetadata` typedef)
- Test: `server/processing/NodeProcessingService.test.js` (add an `exifToMeta` describe block)

**Interfaces:**
- Produces: `export function exifToMeta(exif): { aperture: number|null, shutter: number|null, iso: number|null, focalLength: number|null, lens: string }` — maps a parsed exifr result to raw persisted values (aperture as ƒ-number, shutter in seconds, focal length in mm). `lens` is `""` when absent (an "EXIF attempted" sentinel, mirroring how `width` marks dimensions attempted).
- Produces: `metadata()` results now additionally carry `aperture, shutter, iso, focalLength, lens` for image files (unset for videos).

- [ ] **Step 1: Write the failing test**

Add to `server/processing/NodeProcessingService.test.js` (mirror the existing `describe("formatCamera")` block; add the import to the existing top-of-file import from `./NodeProcessingService.js`):

```js
import { exifToMeta } from "./NodeProcessingService.js";

describe("exifToMeta", () => {
  it("maps exifr fields to raw persisted values", () => {
    expect(
      exifToMeta({
        FNumber: 2.8,
        ExposureTime: 0.004,
        ISO: 400,
        FocalLength: 50,
        LensModel: "RF24-70mm F2.8 L IS USM",
      })
    ).toEqual({
      aperture: 2.8,
      shutter: 0.004,
      iso: 400,
      focalLength: 50,
      lens: "RF24-70mm F2.8 L IS USM",
    });
  });

  it("returns nulls and an empty-string lens sentinel when EXIF is absent", () => {
    expect(exifToMeta(undefined)).toEqual({
      aperture: null,
      shutter: null,
      iso: null,
      focalLength: null,
      lens: "",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/processing/NodeProcessingService.test.js -t exifToMeta`
Expected: FAIL — `exifToMeta is not a function` / import has no such export.

- [ ] **Step 3: Add the `exifToMeta` helper**

In `server/processing/NodeProcessingService.js`, near `formatCamera` (around line 131), add and export:

```js
/** Map a parsed exifr result to the raw EXIF fields we persist and later
 * format in the UI. Numeric fields are null when absent; `lens` is "" (not
 * null) so a stored value marks "EXIF was attempted" — mirroring how `width`
 * marks dimensions attempted — which keeps /api/meta from re-extracting forever
 * for files that genuinely have no lens tag. */
export function exifToMeta(exif) {
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    aperture: num(exif?.FNumber),
    shutter: num(exif?.ExposureTime),
    iso: num(exif?.ISO),
    focalLength: num(exif?.FocalLength),
    lens: typeof exif?.LensModel === "string" ? exif.LensModel : "",
  };
}
```

- [ ] **Step 4: Wire it into `metadata()`**

In `server/processing/NodeProcessingService.js`, in the image branch of `metadata()` (around lines 307–316), replace the `exifr.parse` block with:

```js
        try {
          const exif = await exifr.parse(path, {
            pick: [
              "DateTimeOriginal",
              "CreateDate",
              "Make",
              "Model",
              "FNumber",
              "ExposureTime",
              "ISO",
              "FocalLength",
              "LensModel",
            ],
          });
          const createDate = exif?.DateTimeOriginal || exif?.CreateDate;
          if (createDate) meta.createDate = createDate;
          meta.camera = formatCamera(exif?.Make, exif?.Model);
          Object.assign(meta, exifToMeta(exif));
        } catch {
          /* no EXIF */
        }
```

- [ ] **Step 5: Extend the `MediaMetadata` typedef**

In `server/processing/ProcessingService.js`, in the `MediaMetadata` typedef (around lines 28–37), add after the `camera` line:

```js
 * @property {number=} aperture     EXIF FNumber (ƒ-stop), image files only.
 * @property {number=} shutter      EXIF ExposureTime (seconds), image files only.
 * @property {number=} iso          EXIF ISO, image files only.
 * @property {number=} focalLength  EXIF FocalLength (mm), image files only.
 * @property {string=} lens         EXIF LensModel ("" = none found / attempted).
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run server/processing/NodeProcessingService.test.js -t exifToMeta`
Expected: PASS (both cases).

- [ ] **Step 7: Commit**

```bash
npx prettier --write server/processing/NodeProcessingService.js server/processing/NodeProcessingService.test.js
git add server/processing/NodeProcessingService.js server/processing/ProcessingService.js server/processing/NodeProcessingService.test.js
git commit -m "feat(processing): extract lens/aperture/shutter/ISO/focal EXIF (#27)"
```

---

### Task 2: EXIF columns on the `photos` table

**Files:**
- Modify: `server/db/schema.js` (add `ensureColumn` calls in `applySchema`)
- Test: `server/db/schema.test.js` (new file)

**Interfaces:**
- Produces: `photos` table columns `aperture REAL`, `shutter REAL`, `iso INTEGER`, `focal_length REAL`, `lens TEXT` (all nullable). Consumed by Task 3's `/api/meta`.

- [ ] **Step 1: Write the failing test**

Create `server/db/schema.test.js`:

```js
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { applySchema } from "./schema.js";

describe("applySchema — EXIF columns", () => {
  it("adds the EXIF columns and is idempotent", () => {
    const db = new Database(":memory:");
    applySchema(db);
    applySchema(db); // second run must not throw (idempotent ADD COLUMN)
    const cols = db
      .prepare("PRAGMA table_info(photos)")
      .all()
      .map((c) => c.name);
    for (const c of ["aperture", "shutter", "iso", "focal_length", "lens"]) {
      expect(cols).toContain(c);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/db/schema.test.js`
Expected: FAIL — `expect(cols).toContain("aperture")` fails (column missing).

- [ ] **Step 3: Add the columns**

In `server/db/schema.js`, inside `applySchema` after the existing `duration` `ensureColumn` (around line 89):

```js
  // Loupe details panel EXIF (issue #27). Nullable — populated lazily by
  // /api/meta on first detailed view; `lens` doubles as the "EXIF attempted"
  // sentinel (see NodeProcessingService.exifToMeta / api.js /api/meta trigger).
  ensureColumn(db, "photos", "aperture", "REAL");
  ensureColumn(db, "photos", "shutter", "REAL");
  ensureColumn(db, "photos", "iso", "INTEGER");
  ensureColumn(db, "photos", "focal_length", "REAL");
  ensureColumn(db, "photos", "lens", "TEXT");
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/db/schema.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write server/db/schema.js server/db/schema.test.js
git add server/db/schema.js server/db/schema.test.js
git commit -m "feat(db): add EXIF columns to photos (#27)"
```

---

### Task 3: `/api/meta` persists and returns EXIF

**Files:**
- Modify: `server/api.js` (the `GET /api/meta` handler, around lines 503–562)
- Test: `server/api.test.js` (add a describe block)

**Interfaces:**
- Consumes: `photos` EXIF columns (Task 2); `metadata()` EXIF fields (Task 1).
- Produces: `GET /api/meta?ids=…` response objects now include `camera, aperture, shutter, iso, focalLength, lens, size, folder` in addition to the existing `id, takenAt, width, height, duration`. The extraction trigger also fires when `lens === null`.

- [ ] **Step 1: Write the failing test**

Add to `server/api.test.js` (uses the file's existing `startServer`, `getDb`, and `_resetDbForTest`; insert rows directly so no EXIF fixture is needed):

```js
describe("GET /api/meta — EXIF fields", () => {
  it("returns persisted EXIF for an already-extracted photo", async () => {
    _resetDbForTest();
    const db = getDb();
    db.prepare(
      `INSERT INTO folders (id, abs_path, last_scanned_at) VALUES (1, '/p', 0)`
    ).run();
    // width + camera + lens all non-null → the handler must NOT re-extract.
    db.prepare(
      `INSERT INTO photos
         (id, folder_id, filename, size, mtime, kind, width, height, camera,
          aperture, shutter, iso, focal_length, lens)
       VALUES (7, 1, 'a.jpg', 2400000, 1, 'image', 3024, 4032, 'Canon EOS R6',
          2.8, 0.004, 400, 50, 'RF24-70mm F2.8')`
    ).run();

    const { base, close } = await startServer();
    try {
      const res = await fetch(`${base}/api/meta?ids=7`);
      const [m] = await res.json();
      expect(m).toMatchObject({
        id: 7,
        camera: "Canon EOS R6",
        aperture: 2.8,
        shutter: 0.004,
        iso: 400,
        focalLength: 50,
        lens: "RF24-70mm F2.8",
        size: 2400000,
        folder: "/p",
      });
    } finally {
      await close();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/api.test.js -t "EXIF fields"`
Expected: FAIL — response lacks `aperture`/`lens`/`folder` (undefined), `toMatchObject` fails.

- [ ] **Step 3: Widen the extraction trigger**

In `server/api.js`, in `GET /api/meta`, change the "need extraction" test (around line 517) to also fire when EXIF was never attempted:

```js
      if (photo.width === null || photo.camera === null || photo.lens === null)
        need.push(photo);
```

- [ ] **Step 4: Persist the new columns on extraction**

In the same handler, replace the `update` prepared statement and its `run(...)` (around lines 522–545) with:

```js
      const update = db.prepare(
        `UPDATE photos SET taken_at = ?, width = ?, height = ?, camera = ?,
           duration = ?, aperture = ?, shutter = ?, iso = ?, focal_length = ?,
           lens = ? WHERE id = ?`
      );
      metas.forEach((m, i) => {
        const photo = need[i];
        const takenAtMs = m.createDate ? new Date(m.createDate).getTime() : null;
        const duration = m.duration ?? null;
        const lens = m.lens ?? ""; // "" marks EXIF attempted (see exifToMeta)
        update.run(
          takenAtMs,
          m.width ?? 0,
          m.height ?? 0,
          m.camera ?? "",
          duration,
          m.aperture ?? null,
          m.shutter ?? null,
          m.iso ?? null,
          m.focalLength ?? null,
          lens,
          photo.id
        );
        photosById.set(photo.id, {
          ...photo,
          taken_at: takenAtMs,
          width: m.width ?? 0,
          height: m.height ?? 0,
          camera: m.camera ?? "",
          duration,
          aperture: m.aperture ?? null,
          shutter: m.shutter ?? null,
          iso: m.iso ?? null,
          focal_length: m.focalLength ?? null,
          lens,
        });
      });
```

- [ ] **Step 5: Return the new fields**

In the same handler, replace the response `.map(...)` (around lines 553–560) with:

```js
      .map((p) => ({
        id: p.id,
        takenAt: p.taken_at ? new Date(p.taken_at).toISOString() : null,
        width: p.width ?? null,
        height: p.height ?? null,
        duration: p.duration ?? null,
        camera: p.camera ?? null,
        aperture: p.aperture ?? null,
        shutter: p.shutter ?? null,
        iso: p.iso ?? null,
        focalLength: p.focal_length ?? null,
        lens: p.lens ?? null,
        size: p.size ?? null,
        folder: p.folder_abs_path ?? null,
      }));
```

(`getPhotoById` returns `photos.*` plus `folder_abs_path`, so `p` already carries every column and the folder path.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run server/api.test.js -t "EXIF fields"`
Expected: PASS.
Run: `npx vitest run server/api.test.js`
Expected: PASS (no regression — the grid's existing meta test still reads `width/height/takenAt/duration`, which remain).

- [ ] **Step 7: Commit**

```bash
npx prettier --write server/api.js server/api.test.js
git add server/api.js server/api.test.js
git commit -m "feat(api): /api/meta persists and returns EXIF + folder/size (#27)"
```

---

### Task 4: Pure frontend helpers — EXIF formatting + filmstrip windowing

**Files:**
- Create: `ui/src/lib/exifFormat.js`
- Create: `ui/src/lib/exifFormat.test.js`
- Create: `ui/src/lib/filmstrip.js`
- Create: `ui/src/lib/filmstrip.test.js`

**Interfaces:**
- Produces: `formatAperture(f)`, `formatShutter(s)`, `formatIso(iso)`, `formatFocal(mm)`, `formatSize(bytes)`, `formatDimensions(w, h)` — each returns a display string, or `""` for a missing/invalid value (caller renders `—`).
- Produces: `filmstripWindow(index, length, radius): { start, end }` — the `[start, end)` slice to render.

- [ ] **Step 1: Write the failing tests**

Create `ui/src/lib/exifFormat.test.js`:

```js
import { describe, it, expect } from "vitest";
import {
  formatAperture,
  formatShutter,
  formatIso,
  formatFocal,
  formatSize,
  formatDimensions,
} from "./exifFormat.js";

describe("exifFormat", () => {
  it("apertures: integer stays whole, fraction to one decimal", () => {
    expect(formatAperture(2.8)).toBe("ƒ/2.8");
    expect(formatAperture(8)).toBe("ƒ/8");
    expect(formatAperture(null)).toBe("");
    expect(formatAperture(0)).toBe("");
  });
  it("shutter: sub-second as 1/N, ≥1s as seconds", () => {
    expect(formatShutter(0.004)).toBe("1/250 s");
    expect(formatShutter(0.5)).toBe("1/2 s");
    expect(formatShutter(2)).toBe("2 s");
    expect(formatShutter(1.5)).toBe("1.5 s");
    expect(formatShutter(null)).toBe("");
  });
  it("iso / focal / size / dimensions", () => {
    expect(formatIso(400)).toBe("ISO 400");
    expect(formatIso(0)).toBe("");
    expect(formatFocal(50)).toBe("50 mm");
    expect(formatFocal(null)).toBe("");
    expect(formatSize(2400000)).toBe("2.4 MB");
    expect(formatSize(50000)).toBe("50 KB");
    expect(formatSize(0)).toBe("");
    expect(formatDimensions(3024, 4032)).toBe("3024 × 4032");
    expect(formatDimensions(0, 0)).toBe("");
  });
});
```

Create `ui/src/lib/filmstrip.test.js`:

```js
import { describe, it, expect } from "vitest";
import { filmstripWindow } from "./filmstrip.js";

describe("filmstripWindow", () => {
  it("centers a window of radius around the index", () => {
    expect(filmstripWindow(50, 200, 10)).toEqual({ start: 40, end: 61 });
  });
  it("clamps at the start", () => {
    expect(filmstripWindow(2, 200, 10)).toEqual({ start: 0, end: 13 });
  });
  it("clamps at the end", () => {
    expect(filmstripWindow(198, 200, 10)).toEqual({ start: 188, end: 200 });
  });
  it("handles an empty feed", () => {
    expect(filmstripWindow(0, 0, 10)).toEqual({ start: 0, end: 0 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run ui/src/lib/exifFormat.test.js ui/src/lib/filmstrip.test.js`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the helpers**

Create `ui/src/lib/exifFormat.js`:

```js
/** Human-readable EXIF/file formatting for the Loupe details panel. Each helper
 * returns "" for a missing or invalid value so the panel can render an em dash
 * (—) uniformly. Pure — unit-tested in exifFormat.test.js. */

export function formatAperture(f) {
  if (typeof f !== "number" || !(f > 0)) return "";
  return `ƒ/${f % 1 === 0 ? f : f.toFixed(1)}`;
}

export function formatShutter(s) {
  if (typeof s !== "number" || !(s > 0)) return "";
  if (s < 1) return `1/${Math.round(1 / s)} s`;
  return `${s % 1 === 0 ? s : s.toFixed(1)} s`;
}

export function formatIso(iso) {
  return typeof iso === "number" && iso > 0 ? `ISO ${iso}` : "";
}

export function formatFocal(mm) {
  return typeof mm === "number" && mm > 0 ? `${Math.round(mm)} mm` : "";
}

export function formatSize(bytes) {
  if (typeof bytes !== "number" || !(bytes > 0)) return "";
  const mb = bytes / 1e6;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1e3)} KB`;
}

export function formatDimensions(w, h) {
  return w > 0 && h > 0 ? `${w} × ${h}` : "";
}
```

Create `ui/src/lib/filmstrip.js`:

```js
/** The [start, end) slice of `items` the filmstrip should render: a window of
 * `radius` entries on each side of `index`, clamped to [0, length]. Windowing
 * keeps a large feed (10k+ photos) from mounting thousands of <img>s. Pure —
 * unit-tested in filmstrip.test.js. */
export function filmstripWindow(index, length, radius) {
  if (length <= 0) return { start: 0, end: 0 };
  const i = Math.max(0, Math.min(length - 1, index));
  return {
    start: Math.max(0, i - radius),
    end: Math.min(length, i + radius + 1),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run ui/src/lib/exifFormat.test.js ui/src/lib/filmstrip.test.js`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
npx prettier --write ui/src/lib/exifFormat.js ui/src/lib/exifFormat.test.js ui/src/lib/filmstrip.js ui/src/lib/filmstrip.test.js
git add ui/src/lib/exifFormat.js ui/src/lib/exifFormat.test.js ui/src/lib/filmstrip.js ui/src/lib/filmstrip.test.js
git commit -m "feat(ui): pure EXIF-format + filmstrip-window helpers (#27, #28)"
```

---

### Task 5: `LoupeDetails.svelte` — the right metadata panel

**Files:**
- Create: `ui/src/lib/LoupeDetails.svelte`

**Interfaces:**
- Consumes: `formatAperture/Shutter/Iso/Focal/Size/Dimensions` (Task 4); `Stars.svelte`.
- Props: `item` (current photo, may be null), `meta` (fetched detail meta or null), `inSelection: boolean`, `selectedCount: number`.
- Presentational only; no fetching. Verified live in Task 7.

- [ ] **Step 1: Create the component**

Create `ui/src/lib/LoupeDetails.svelte`:

```svelte
<script>
  import Stars from "./Stars.svelte";
  import {
    formatAperture,
    formatShutter,
    formatIso,
    formatFocal,
    formatSize,
    formatDimensions,
  } from "./exifFormat.js";

  export let item = null; // current photo (from items[index])
  export let meta = null; // full detail meta from /api/meta (or null while loading)
  export let inSelection = false;
  export let selectedCount = 0;

  const DASH = "—";
  const or = (s) => (s ? s : DASH);

  // Prefer freshly-fetched meta, fall back to the feed item's own fields.
  $: takenAt = meta?.takenAt ?? item?.takenAt ?? null;
  $: dims = formatDimensions(
    meta?.width ?? item?.width ?? 0,
    meta?.height ?? item?.height ?? 0
  );
  $: folder = meta?.folder ?? null;
  $: isVideo = item?.kind === "video";

  function fmtDate(iso) {
    if (!iso) return DASH;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? DASH : d.toLocaleString();
  }
  function fmtDuration(sec) {
    if (typeof sec !== "number" || sec <= 0) return DASH;
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }
</script>

<aside class="details">
  {#if item}
    <section>
      <h4>File</h4>
      <div class="v name" title={item.name}>{item.name}</div>
      {#if folder}<div class="v sub" title={folder}>{folder}</div>{/if}
      <dl>
        <dt>Size</dt><dd>{or(formatSize(meta?.size ?? item?.size))}</dd>
        <dt>Kind</dt><dd>{item.kind}</dd>
        {#if isVideo}
          <dt>Length</dt><dd>{fmtDuration(meta?.duration ?? item?.duration)}</dd>
        {/if}
      </dl>
    </section>

    <section>
      <h4>Image</h4>
      <dl>
        <dt>Dimensions</dt><dd>{or(dims)}</dd>
        <dt>Taken</dt><dd>{fmtDate(takenAt)}</dd>
      </dl>
    </section>

    {#if !isVideo}
      <section>
        <h4>Camera</h4>
        <dl>
          <dt>Camera</dt><dd>{or(meta?.camera)}</dd>
          <dt>Lens</dt><dd>{or(meta?.lens)}</dd>
          <dt>Aperture</dt><dd>{or(formatAperture(meta?.aperture))}</dd>
          <dt>Shutter</dt><dd>{or(formatShutter(meta?.shutter))}</dd>
          <dt>ISO</dt><dd>{or(formatIso(meta?.iso))}</dd>
          <dt>Focal</dt><dd>{or(formatFocal(meta?.focalLength))}</dd>
        </dl>
      </section>
    {/if}

    <section class="rating-row">
      <h4>Rating</h4>
      <Stars rating={item.rating ?? 0} full />
    </section>

    <section class="select-row">
      <span class="select-state" class:on={inSelection}>
        {inSelection ? "✓ Selected" : "Press X to select"}
      </span>
      {#if selectedCount > 0}
        <span class="select-total">{selectedCount} selected</span>
      {/if}
    </section>
  {/if}
</aside>

<style>
  .details {
    width: 260px;
    flex: 0 0 260px;
    overflow-y: auto;
    background: #111;
    border-left: 1px solid #222;
    color: #ddd;
    font-size: 0.82rem;
    padding: 0.75rem 0.9rem;
  }
  section {
    margin-bottom: 1rem;
  }
  h4 {
    margin: 0 0 0.35rem;
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #888;
  }
  .name {
    color: #fff;
    word-break: break-all;
  }
  .sub {
    color: #888;
    font-size: 0.75rem;
    word-break: break-all;
    margin-top: 2px;
  }
  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px 10px;
    margin: 0.35rem 0 0;
  }
  dt {
    color: #888;
  }
  dd {
    margin: 0;
    color: #eee;
    text-align: right;
    word-break: break-word;
  }
  .rating-row :global(.stars) {
    font-size: 1rem;
  }
  .select-state {
    font-size: 0.75rem;
    color: #777;
    border: 1px solid #333;
    border-radius: 6px;
    padding: 3px 8px;
  }
  .select-state.on {
    color: #1a1400;
    background: #ffd24c;
    border-color: #ffd24c;
    font-weight: 600;
  }
  .select-total {
    display: block;
    margin-top: 4px;
    font-size: 0.75rem;
    color: #ffd24c;
  }
</style>
```

- [ ] **Step 2: Verify it builds**

Run: `npm run build`
Expected: builds without errors (component compiles; unused-CSS/a11y warnings are acceptable).

- [ ] **Step 3: Commit**

```bash
git add ui/src/lib/LoupeDetails.svelte
git commit -m "feat(loupe): details panel component (#27)"
```

---

### Task 6: `LoupeFilmstrip.svelte` — the bottom neighbor strip

**Files:**
- Create: `ui/src/lib/LoupeFilmstrip.svelte`

**Interfaces:**
- Consumes: `filmstripWindow` (Task 4); `thumbUrl` from `./api.js`.
- Props: `items` (array; may contain collapsed placeholders whose `id` is a string), `index` (current), `selectedIds` (Set of selected numeric ids).
- Emits: `select` with `{ index }` when a thumb is clicked.
- Verified live in Task 7.

- [ ] **Step 1: Create the component**

Create `ui/src/lib/LoupeFilmstrip.svelte`:

```svelte
<script>
  import { createEventDispatcher, tick } from "svelte";
  import { thumbUrl } from "./api.js";
  import { filmstripWindow } from "./filmstrip.js";

  const dispatch = createEventDispatcher();

  export let items = [];
  export let index = 0;
  export let selectedIds = new Set();

  const RADIUS = 40; // ±40 rendered around the current index
  const THUMB = 64; // px

  const isReal = (it) => it && typeof it.id === "number";

  $: win = filmstripWindow(index, items.length, RADIUS);
  // [{ i, item }] for the current window, so click handlers know the real index.
  $: windowItems = Array.from({ length: win.end - win.start }, (_, k) => {
    const i = win.start + k;
    return { i, item: items[i] };
  });

  let stripEl;
  let currentEl;
  // Keep the current thumb centered horizontally whenever the index changes.
  $: index, scrollCurrentIntoView();
  async function scrollCurrentIntoView() {
    await tick();
    currentEl?.scrollIntoView({ inline: "center", block: "nearest" });
  }
</script>

<div class="filmstrip" bind:this={stripEl}>
  {#each windowItems as { i, item } (isReal(item) ? item.id : `ph-${i}`)}
    {#if isReal(item)}
      <button
        class="cell"
        class:current={i === index}
        style="width:{THUMB}px;height:{THUMB}px;"
        title={item.name}
        on:click={() => dispatch("select", { index: i })}
        bind:this={currentEl}
        use:centerIfCurrent={i === index}
      >
        <img src={thumbUrl(item.id, THUMB, item.mtimeMs)} alt={item.name} />
        {#if item.kind === "video"}<span class="badge">▶</span>{/if}
        {#if selectedIds.has(item.id)}<span class="sel">✓</span>{/if}
      </button>
    {:else}
      <div class="gap" style="width:{THUMB / 3}px;height:{THUMB}px;" />
    {/if}
  {/each}
</div>

<script context="module">
  // A tiny action that records the node when it is the current cell, so the
  // reactive scroll-into-view can target it without a querySelector.
  export function centerIfCurrent() {
    return {};
  }
</script>

<style>
  .filmstrip {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 84px;
    padding: 6px 10px;
    overflow-x: auto;
    overflow-y: hidden;
    background: #0d0d0d;
    border-top: 1px solid #222;
  }
  .cell {
    position: relative;
    flex: 0 0 auto;
    padding: 0;
    border: 2px solid transparent;
    border-radius: 4px;
    background: #000;
    cursor: pointer;
    overflow: hidden;
  }
  .cell.current {
    border-color: #4c9dff;
  }
  .cell img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .badge,
  .sel {
    position: absolute;
    font-size: 0.6rem;
    line-height: 1;
    padding: 1px 3px;
    border-radius: 3px;
    background: rgba(0, 0, 0, 0.65);
    color: #fff;
  }
  .badge {
    bottom: 2px;
    left: 2px;
  }
  .sel {
    top: 2px;
    right: 2px;
    background: #ffd24c;
    color: #1a1400;
    font-weight: 700;
  }
  .gap {
    flex: 0 0 auto;
  }
</style>
```

Note on `bind:this={currentEl}`: inside an `{#each}`, Svelte 4 assigns the binding for whichever iteration is rendered last, which is unreliable for "the current one." Replace the `bind:this` + `use:centerIfCurrent` on the button with a direct `class:current` lookup driven by the reactive scroll: change `scrollCurrentIntoView` to query the strip, and drop `currentEl`/`centerIfCurrent`/the module script:

```svelte
  async function scrollCurrentIntoView() {
    await tick();
    stripEl?.querySelector(".cell.current")?.scrollIntoView({
      inline: "center",
      block: "nearest",
    });
  }
```

Remove `bind:this={currentEl}`, `use:centerIfCurrent={i === index}`, the `let currentEl;` line, and the entire `<script context="module">` block. Keep `bind:this={stripEl}`.

- [ ] **Step 2: Verify it builds**

Run: `npm run build`
Expected: builds without errors.

- [ ] **Step 3: Commit**

```bash
git add ui/src/lib/LoupeFilmstrip.svelte
git commit -m "feat(loupe): windowed neighbor filmstrip component (#28)"
```

---

### Task 7: Integrate into the Loupe + App (toggles, persistence, shortcuts)

**Files:**
- Modify: `ui/src/lib/Loupe.svelte` (shell: fetch detail meta, render panel + strip, drop the old `.hud`)
- Modify: `ui/src/App.svelte` (`showLoupeDetails`/`showLoupeFilmstrip` state + persistence, pass props, `I`/`F` keydown, wire filmstrip `select`)
- Modify: `ui/src/lib/ShortcutsOverlay.svelte` (document `I`/`F`)
- Modify: `package.json` (version bump), `CHANGELOG.md`

**Interfaces:**
- Consumes: `LoupeDetails` (Task 5), `LoupeFilmstrip` (Task 6), `fetchMeta` from `./api.js` (existing — already returns the extended object as of Task 3).
- Props added to `Loupe`: `showDetails: boolean`, `showFilmstrip: boolean`, `selectedIds: Set`.

- [ ] **Step 1: Rebuild `Loupe.svelte` as a shell**

Replace the contents of `ui/src/lib/Loupe.svelte` with (keeps the existing stage + ±3 image prefetch; adds a lazy detail-meta cache; renders the panel/strip; removes the bottom `.hud`, whose content now lives in `LoupeDetails`):

```svelte
<script>
  import { createEventDispatcher } from "svelte";
  import { imageUrl, videoUrl, fetchMeta } from "./api.js";
  import LoupeDetails from "./LoupeDetails.svelte";
  import LoupeFilmstrip from "./LoupeFilmstrip.svelte";

  const dispatch = createEventDispatcher();

  function onContextMenu(e) {
    e.preventDefault();
    dispatch("contextmenu", { x: e.clientX, y: e.clientY });
  }

  export let items;
  export let index; // current position in items (two-way bound)
  export let inSelection = false;
  export let selectedCount = 0;
  export let selectedIds = new Set();
  export let showDetails = true;
  export let showFilmstrip = true;

  const isRealPhoto = (it) => it && typeof it.id === "number";
  $: item = isRealPhoto(items[index]) ? items[index] : null;

  // Lazy, Loupe-scoped full metadata (incl. EXIF): fetch the current photo and
  // its immediate neighbours; cache by id. /api/meta persists on first read, so
  // re-views are instant. Keeps EXIF cost off the grid's lighter enrichMeta.
  const detailMeta = new Map(); // id -> meta object from /api/meta
  let currentMeta = null;
  $: if (item) loadMeta(item.id);

  async function loadMeta(id) {
    currentMeta = detailMeta.get(id) ?? null;
    const wanted = [];
    for (let d = 0; d <= 1; d++) {
      for (const j of d === 0 ? [id] : [id - 1, id + 1].map((k) => k)) {
        // resolve neighbour ids from index, not id arithmetic
      }
    }
    const ids = [];
    for (let d = -1; d <= 1; d++) {
      const it = items[index + d];
      if (isRealPhoto(it) && !detailMeta.has(it.id)) ids.push(it.id);
    }
    if (!ids.length) return;
    try {
      const metas = await fetchMeta(ids);
      for (const m of metas) detailMeta.set(m.id, m);
      if (item && item.id === id) currentMeta = detailMeta.get(id) ?? currentMeta;
    } catch {
      /* metadata is an enhancement; panel falls back to item fields */
    }
  }

  // Image prefetch: keep ±3 neighbours warm (unchanged from before).
  const warm = new Map();
  $: if (item) prefetch(index);
  function prefetch(i) {
    const wanted = new Set();
    for (let d = -3; d <= 3; d++) {
      const it = items[i + d];
      if (!isRealPhoto(it)) continue;
      if (it.kind === "video") continue;
      wanted.add(it.id);
      if (!warm.has(it.id)) {
        const img = new Image();
        img.src = imageUrl(it.id, it.mtimeMs);
        warm.set(it.id, img);
      }
    }
    for (const id of warm.keys()) if (!wanted.has(id)) warm.delete(id);
  }
</script>

<div class="loupe" role="dialog" aria-modal="true">
  <div class="body">
    <div class="stage" on:contextmenu={onContextMenu}>
      {#if item}
        {#key item.id}
          {#if item.kind === "video"}
            <video
              src={videoUrl(item.id, item.mtimeMs)}
              controls
              autoplay
              muted
              playsinline
              preload="metadata"
            >
              <track kind="captions" />
            </video>
          {:else}
            <img src={imageUrl(item.id, item.mtimeMs)} alt={item.name} />
          {/if}
        {/key}
      {/if}
    </div>
    {#if showDetails}
      <LoupeDetails {item} meta={currentMeta} {inSelection} {selectedCount} />
    {/if}
  </div>
  {#if showFilmstrip}
    <LoupeFilmstrip
      {items}
      {index}
      {selectedIds}
      on:select={(e) => (index = e.detail.index)}
    />
  {/if}
</div>

<style>
  .loupe {
    position: fixed;
    inset: 0;
    background: #0a0a0a;
    display: flex;
    flex-direction: column;
    z-index: 100;
  }
  .body {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .stage {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
  }
  .stage img,
  .stage video {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    box-shadow: 0 4px 30px rgba(0, 0, 0, 0.6);
  }
</style>
```

Then simplify `loadMeta` — delete the dead first `for` loop (the scaffolding comment block) so the function is just the second loop:

```js
  async function loadMeta(id) {
    currentMeta = detailMeta.get(id) ?? null;
    const ids = [];
    for (let d = -1; d <= 1; d++) {
      const it = items[index + d];
      if (isRealPhoto(it) && !detailMeta.has(it.id)) ids.push(it.id);
    }
    if (!ids.length) return;
    try {
      const metas = await fetchMeta(ids);
      for (const m of metas) detailMeta.set(m.id, m);
      if (item && item.id === id) currentMeta = detailMeta.get(id) ?? currentMeta;
    } catch {
      /* metadata is an enhancement; panel falls back to item fields */
    }
  }
```

- [ ] **Step 2: Add toggle state + persistence in `App.svelte`**

In `ui/src/App.svelte`, near the other `LS_*`/localStorage state (around lines 112–129), add:

```js
  const LS_LOUPE_DETAILS = "autogallery.loupeDetails";
  const LS_LOUPE_FILMSTRIP = "autogallery.loupeFilmstrip";
  let showLoupeDetails =
    localStorage.getItem(LS_LOUPE_DETAILS) !== "false"; // default on
  let showLoupeFilmstrip =
    localStorage.getItem(LS_LOUPE_FILMSTRIP) !== "false"; // default on
  $: localStorage.setItem(LS_LOUPE_DETAILS, String(showLoupeDetails));
  $: localStorage.setItem(LS_LOUPE_FILMSTRIP, String(showLoupeFilmstrip));
```

- [ ] **Step 3: Pass props to `<Loupe>`**

In `ui/src/App.svelte`, update the `<Loupe .../>` invocation (around line 3026) to:

```svelte
  <Loupe
    items={resolvedPhotos}
    bind:index={selected}
    inSelection={typeof resolvedPhotos[selected]?.id === "number" &&
      selectedIds.has(resolvedPhotos[selected].id)}
    selectedCount={selectedCount}
    {selectedIds}
    showDetails={showLoupeDetails}
    showFilmstrip={showLoupeFilmstrip}
    on:contextmenu={(e) => openContextMenu(e.detail.x, e.detail.y, selected)}
  />
```

- [ ] **Step 4: Add the `I`/`F` toggles in `onKeydown`**

In `ui/src/App.svelte`, in `onKeydown`, after the input-guard and before the rating-digit block (around line 2288, right after the loupe navigation handling), add:

```js
    // Loupe-only view toggles: I = details panel, F = filmstrip. Guarded on
    // loupeOpen so they never clash with grid usage; localStorage persists via
    // the reactive setters above.
    if (loupeOpen && (key === "i" || key === "f")) {
      e.preventDefault();
      if (key === "i") showLoupeDetails = !showLoupeDetails;
      else showLoupeFilmstrip = !showLoupeFilmstrip;
      return;
    }
```

(Place this after the existing `if (loupeOpen) { ... arrow nav ... }` block and before the `/^[0-5]$/` rating block, so digits/rating still work and the toggles only fire in the Loupe.)

- [ ] **Step 5: Document the shortcuts**

In `ui/src/lib/ShortcutsOverlay.svelte`, add two entries to the Loupe shortcuts group (match the file's existing row format — inspect the surrounding rows and copy their markup):

```
I  — toggle details panel
F  — toggle filmstrip
```

- [ ] **Step 6: Bump version + changelog**

Run: `npm version 2.8.1-alpha --no-git-tag-version`

Add to the top of `CHANGELOG.md` (after the header, above `## 2.8.0-alpha`):

```markdown
## 2.8.1-alpha

- **Loupe details panel & filmstrip** — the detail view now shows a right-hand
  panel with filename, dimensions, dates, camera and full EXIF (lens, aperture,
  shutter, ISO, focal length) and rating, plus a filmstrip of neighbouring
  photos along the bottom to jump between shots without leaving the view. Toggle
  each with `I` (details) and `F` (filmstrip); your choices are remembered
  (#27, #28).
```

- [ ] **Step 7: Build, run the whole suite**

Run: `npm run build`
Expected: builds cleanly.
Run: `npm test`
Expected: all tests pass (new unit tests from Tasks 1–4 included).

- [ ] **Step 8: Live verification (per project convention — no Svelte harness)**

Restart the dev server so the API serves the new `/api/meta` (server code isn't hot-reloaded): kill the running `npm run dev`, rerun it. Then in the browser:

1. Open a photo in the Loupe. Confirm the **right panel** shows filename, folder, size, dimensions, taken date, camera, lens, ƒ, shutter, ISO, focal, and rating stars. Fields with no data show `—`.
2. Confirm the **filmstrip** shows neighbours, the current one is outlined and centered, and clicking a thumb navigates (panel + stage update).
3. Arrow-key through photos: filmstrip re-centers, panel updates, EXIF appears (first view may lag a beat while `/api/meta` extracts, then is instant on return).
4. Press `I` — details panel hides/shows. Press `F` — filmstrip hides/shows. Reload the page: the last on/off state persists.
5. Open a **video**: camera-EXIF rows are hidden; length shows; the strip shows its ▶ badge.

- [ ] **Step 9: Commit**

```bash
npx prettier --write ui/src/lib/exifFormat.js CHANGELOG.md
git add ui/src/lib/Loupe.svelte ui/src/App.svelte ui/src/lib/ShortcutsOverlay.svelte package.json CHANGELOG.md
git commit -m "feat(loupe): details panel + filmstrip, I/F toggles, persisted (#27, #28)"
```

---

## Self-Review

**Spec coverage:**
- Component split (shell + LoupeDetails + LoupeFilmstrip) → Tasks 5, 6, 7. ✓
- Backend EXIF extraction (exifr pick + mapping) → Task 1. ✓
- Schema columns → Task 2. ✓
- `/api/meta` persist + return + trigger → Task 3. ✓
- Lazy Loupe-scoped meta fetch (±1 prefetch, id-keyed cache) → Task 7 Step 1. ✓
- Filmstrip windowing (±40), click-to-jump, auto-center, placeholder gap, video/selected badges → Tasks 4, 6. ✓
- Keyboard toggles `I`/`F` + localStorage persistence + shortcuts overlay → Task 7 Steps 2–5. ✓
- Panel absorbs the HUD; bottom becomes the filmstrip → Task 7 Step 1 (old `.hud` removed; content in LoupeDetails). ✓
- Error handling: missing EXIF → `—` (LoupeDetails `or()`); placeholder at index → `isRealPhoto` guard; meta fetch failure → try/catch fallback. ✓
- Testing: pure helpers unit-tested (Tasks 1, 4), `/api/meta` shaping (Task 3), schema (Task 2); UI live-verified (Task 7 Step 8). ✓
- Versioning/CHANGELOG in the feature commit → Task 7 Step 6. ✓

**Placeholder scan:** No TBD/TODO. Task 6 and Task 7 Step 1 each flag one piece of scaffolding to delete (the unreliable `bind:this` in an `{#each}`, and the dead first loop in `loadMeta`) with the exact replacement given — these are explicit corrections, not placeholders.

**Type consistency:** `exifToMeta` returns `{aperture, shutter, iso, focalLength, lens}` (camelCase) — consumed by Task 3 as `m.aperture/m.shutter/m.iso/m.focalLength/m.lens` and stored in columns `aperture/shutter/iso/focal_length/lens`. `/api/meta` response uses camelCase `focalLength` (from column `focal_length`) — consumed by `LoupeDetails` as `meta.focalLength`. `filmstripWindow(index, length, radius) → {start, end}` — consumed in Task 6. `fetchMeta(ids)` returns the array unchanged (no signature change; extended fields ride along). `select` event detail `{ index }` — emitted in Task 6, consumed in Task 7 Step 1 (`e.detail.index`). Consistent. ✓
