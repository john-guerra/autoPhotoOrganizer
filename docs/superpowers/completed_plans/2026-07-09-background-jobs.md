# Background jobs + cancelable panel + move-materialize — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn scan/export/materialize into cancelable background jobs with live progress in a bottom status-bar panel, and add a MOVE option to materialize (default move, copy opt-in) with recover-safe guardrails.

**Architecture:** An in-memory `JobRegistry` (Map + EventEmitter) owns job state; the three op handlers spawn a job and return `202 {jobId}`; an SSE endpoint streams job snapshots to a Svelte store that feeds a `JobsPanel`. The shared copy loop grows `{signal, onProgress, move}`; move is copy→verify→unlink with an undo manifest and an index repoint.

**Tech Stack:** Node ESM, Express, better-sqlite3, Svelte 4, vitest. No new deps.

## Global Constraints

- **ESM** everywhere; **no TypeScript** (JSDoc types).
- **Svelte 4** idioms only (`export let`, `$:`, `createEventDispatcher`) — no runes.
- Tests are **vitest**, colocated `*.test.js` next to sources under `server/`.
- All file-serving/path handling routes through `server/lib/safeResolve.js`.
- **Never touch real/test photo folders in tests** — use scratchpad temp dirs and a temp `AUTOGALLERY_HOME`.
- Server has **no hot reload** — restart `npm run dev` after server edits before live checks.
- Move is the ONLY code path allowed to remove a source file, reachable only via explicit materialize-with-move.

---

### Task 1: Job registry

**Files:**

- Create: `server/jobs/registry.js`
- Test: `server/jobs/registry.test.js`

**Interfaces:**

- Produces: a singleton `registry` with `create(type,{label,total}) -> job`, `update(id,patch)`, `finish(id,result)`, `fail(id,error)`, `cancel(id)`, `dismiss(id)`, `list()`, and `on(event,cb)` (extends EventEmitter). `job` fields: `id,type,label,status,done,total,phase,result,error,controller`. `list()` returns each job WITHOUT `controller`.

- [ ] **Step 1: Write failing tests** covering: `create` returns status `running`, monotonic id, fresh `AbortController`, emits `"change"`; `update` merges done/total/phase + emits; `finish`/`fail` set terminal status + result/error + emit; `cancel` calls `controller.abort()` and sets status `canceled`; `dismiss` removes a terminal job and refuses a running one; `list()` omits `controller` and is a snapshot (mutating it doesn't affect internal state).
- [ ] **Step 2: Run** `npx vitest run server/jobs/registry.test.js` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `registry.js`:

```js
import { EventEmitter } from "node:events";

/** @typedef {"scan"|"export"|"materialize"|"undo-move"} JobType */

class JobRegistry extends EventEmitter {
  #jobs = new Map();
  #seq = 0;

  create(type, { label, total = 0 } = {}) {
    const id = `job-${++this.#seq}`;
    const job = {
      id,
      type,
      label: label ?? type,
      status: "running",
      done: 0,
      total,
      phase: "",
      result: null,
      error: null,
      controller: new AbortController(),
    };
    this.#jobs.set(id, job);
    this.#emit();
    return job;
  }
  update(id, patch) {
    const j = this.#jobs.get(id);
    if (!j) return;
    Object.assign(j, patch);
    this.#emit();
  }
  finish(id, result) {
    const j = this.#jobs.get(id);
    if (!j) return;
    j.status = "done";
    j.result = result ?? null;
    this.#emit();
  }
  fail(id, error) {
    const j = this.#jobs.get(id);
    if (!j) return;
    j.status = j.controller.signal.aborted ? "canceled" : "failed";
    j.error = String(error?.message ?? error);
    this.#emit();
  }
  cancel(id) {
    const j = this.#jobs.get(id);
    if (!j || j.status !== "running") return false;
    j.controller.abort();
    return true;
  }
  dismiss(id) {
    const j = this.#jobs.get(id);
    if (!j || j.status === "running") return false;
    this.#jobs.delete(id);
    this.#emit();
    return true;
  }
  get(id) {
    return this.#jobs.get(id);
  }
  list() {
    return [...this.#jobs.values()].map(({ controller, ...rest }) => ({
      ...rest,
    }));
  }
  #emit() {
    this.emit("change", this.list());
  }
}

export const registry = new JobRegistry();
```

- [ ] **Step 4: Run tests** — expect PASS.
- [ ] **Step 5: Commit** `feat(jobs): in-memory job registry with cancel/dismiss + change events`.

---

### Task 2: Jobs endpoints + SSE

**Files:**

- Modify: `server/api.js` (add routes inside `registerApi`, import `registry`)
- Test: `server/api.test.js`

**Interfaces:**

- Consumes: `registry` (Task 1).
- Produces: `GET /api/jobs -> {jobs}`; `GET /api/jobs/events` (SSE); `POST /api/jobs/:id/cancel`; `POST /api/jobs/:id/dismiss`.

- [ ] **Step 1: Write failing tests**: `GET /api/jobs` returns `{jobs: []}` initially; after `registry.create(...)` it lists the job without `controller`; `POST /api/jobs/:id/cancel` on unknown → 404, on running → 200; `POST /api/jobs/:id/dismiss` on running → 409, on terminal → 200. (SSE stream tested indirectly; skip a raw EventSource test.)
- [ ] **Step 2: Run** the new tests — expect FAIL.
- [ ] **Step 3: Implement** in `registerApi`:

```js
app.get("/api/jobs", (_req, res) => res.json({ jobs: registry.list() }));

app.get("/api/jobs/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (jobs) => res.write(`data: ${JSON.stringify(jobs)}\n\n`);
  send(registry.list());
  const onChange = (jobs) => send(jobs);
  registry.on("change", onChange);
  req.on("close", () => registry.off("change", onChange));
});

app.post("/api/jobs/:id/cancel", (req, res) => {
  const j = registry.get(req.params.id);
  if (!j) return res.status(404).json({ error: "no such job" });
  if (j.status !== "running")
    return res.status(409).json({ error: "not running" });
  registry.cancel(req.params.id);
  res.json({ ok: true });
});

app.post("/api/jobs/:id/dismiss", (req, res) => {
  const j = registry.get(req.params.id);
  if (!j) return res.status(404).json({ error: "no such job" });
  if (j.status === "running")
    return res.status(409).json({ error: "still running" });
  registry.dismiss(req.params.id);
  res.json({ ok: true });
});
```

- [ ] **Step 4: Run tests** — expect PASS.
- [ ] **Step 5: Commit** `feat(jobs): jobs list/SSE/cancel/dismiss endpoints`.

---

### Task 3: Cancelable + move-capable copy loop

**Files:**

- Modify: `server/api.js` (`copyIdsIntoFolder`, ~line 106; helpers `nextAvailablePath`)
- Test: `server/copy.test.js` (new)

**Interfaces:**

- Produces: `copyIdsIntoFolder(db, targetDir, ids, { signal, onProgress, move }) -> { copied, moved, skipped, manifest }` where `manifest: Array<{id, from, to}>`. Throws an `AbortError` (`error.name === "AbortError"`) when `signal.aborted`.

- [ ] **Step 1: Write failing tests** (all in scratchpad temp dirs + temp `AUTOGALLERY_HOME`; seed a temp DB with a couple photo rows pointing at temp source files):
  - copy mode: source files still exist after; `copied` counts; `moved===0`; `manifest` maps id→dst.
  - move mode (same volume): sources gone; dests exist; `moved` counts.
  - collision: dest name already present → new file gets ` (2)` suffix; existing file untouched (both modes).
  - EXDEV fallback: monkeypatch/force `renameSync` to throw `{code:"EXDEV"}` → file still lands at dest AND source removed; assert dest exists BEFORE unlink by checking final state (source gone, dest present, sizes equal).
  - abort: set `signal` already aborted → throws `AbortError`, zero processed; abort after N via an `onProgress` that aborts → exactly N processed persist, manifest length N.
  - missing source: `skipped` counts, no throw.
- [ ] **Step 2: Run** `npx vitest run server/copy.test.js` — expect FAIL.
- [ ] **Step 3: Implement.** New signature + move branch:

```js
import { renameSync, fsyncSync, openSync, closeSync } from "node:fs";

function moveFile(src, dst) {
  try {
    renameSync(src, dst);
    return;
  } catch (e) {
    if (e.code !== "EXDEV") throw e;
  }
  copyFileSync(src, dst); // cross-volume
  const fd = openSync(dst, "r");
  fsyncSync(fd);
  closeSync(fd);
  if (statSync(dst).size !== statSync(src).size)
    throw new Error(`move verify failed: ${src}`);
  unlinkSync(src); // remove source only after verified
}

function copyIdsIntoFolder(
  db,
  targetDir,
  ids,
  { signal, onProgress, move = false } = {}
) {
  mkdirSync(targetDir, { recursive: true });
  let copied = 0,
    moved = 0,
    skipped = 0;
  const manifest = [];
  const total = ids.length;
  ids.forEach((id, i) => {
    if (signal?.aborted) {
      const e = new Error("canceled");
      e.name = "AbortError";
      throw e;
    }
    const photo = getPhotoById(db, Number(id));
    if (!photo || !existsSync(photo.path)) {
      skipped++;
    } else {
      const dst = nextAvailablePath(targetDir, basename(photo.path));
      if (move) {
        moveFile(photo.path, dst);
        moved++;
      } else {
        copyFileSync(photo.path, dst);
        copied++;
      }
      manifest.push({ id: Number(id), from: photo.path, to: dst });
    }
    if (i % 50 === 0 || i === total - 1)
      onProgress?.(i + 1, total, move ? "moving" : "copying");
  });
  return { copied, moved, skipped, manifest };
}
```

(Index repoint on move is added in Task 4 — leave a `// TODO(task4): repoint index` marker right after `manifest.push`.)

- [ ] **Step 4: Run tests** — expect PASS.
- [ ] **Step 5: Commit** `feat(export): cancelable copy loop with move (copy-verify-unlink) + manifest`.

---

### Task 4: Repoint the index after a move

**Files:**

- Modify: `server/api.js` (call into a new helper), `server/db/photos.js` (helper)
- Test: `server/db/photos.test.js` (add cases) or `server/copy.test.js`

**Interfaces:**

- Consumes: the moved-file `{id, to}` from Task 3.
- Produces: `repointPhoto(db, id, newAbsPath)` in `server/db/photos.js` — ensures a `folders` row for `dirname(newAbsPath)` on the same volume, sets the photo's `folder_id` + `filename`, so `getPhotoById(db,id).path === newAbsPath` afterward and the photo is not "missing".

- [ ] **Step 1: Write failing test**: after `repointPhoto(db, id, newPath)`, `getPhotoById(db,id).path === newPath`; a `folders` row exists for the new dir; the old folder row is untouched.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** `repointPhoto` (reuse the folder-upsert used by `upsertScan`; look up the existing volume for the path via `volumeRootForPath`/`upsertVolume`). Wire it into `copyIdsIntoFolder`'s move branch (replace the Task-3 TODO): call `repointPhoto(db, Number(id), dst)` right after a successful `moveFile`.
- [ ] **Step 4: Run tests** (copy + photos) — expect PASS.
- [ ] **Step 5: Commit** `feat(move): repoint photo index rows to the moved location`.

---

### Task 5: Export as a job

**Files:**

- Modify: `server/api.js` (`POST /api/export`)
- Test: `server/api.test.js`

**Interfaces:**

- Consumes: `registry`, `copyIdsIntoFolder`.
- Produces: `POST /api/export` now returns `202 {jobId}`; job `result` = `{target, copied, skipped}`.

- [ ] **Step 1: Update/add test**: valid body → 202 `{jobId}`; poll `registry.get(jobId)` until terminal (or expose a tiny test helper `await waitJob`) → status `done`, result has `copied`. Keep the 400 validation tests.
- [ ] **Step 2: Run** — expect FAIL (still returns 200 result).
- [ ] **Step 3: Implement** — after validation + `resolveExportTarget`, spawn:

```js
const job = registry.create("export", {
  label: `Export ${photoIds.length} photos`,
  total: photoIds.length,
});
res.status(202).json({ jobId: job.id });
(async () => {
  try {
    const { copied, skipped, moved } = copyIdsIntoFolder(
      db,
      resolved.target,
      photoIds,
      {
        signal: job.controller.signal,
        onProgress: (done, total, phase) =>
          registry.update(job.id, { done, total, phase }),
      }
    );
    registry.finish(job.id, {
      target: resolved.target,
      copied: copied + moved,
      skipped,
    });
  } catch (e) {
    registry.fail(job.id, e);
  }
})();
```

- [ ] **Step 4: Run tests** — expect PASS.
- [ ] **Step 5: Commit** `feat(export): run export as a cancelable background job`.

---

### Task 6: Materialize as a job, with move flag

**Files:**

- Modify: `server/api.js` (`POST /api/albums/materialize`)
- Test: `server/api.test.js`

**Interfaces:**

- Consumes: `registry`, `copyIdsIntoFolder`.
- Produces: `POST /api/albums/materialize` body gains `move?: boolean` (default **true**); returns `202 {jobId}`; job `result` = `{destParent, albums:[{name,target,copied,moved,skipped}], move, manifest}` (manifest = concatenated per-album manifests, for undo).

- [ ] **Step 1: Update tests**: valid body → 202 `{jobId}`; job completes `done` with per-album results; `move` defaults true; passing `move:false` copies (sources remain).
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** — keep the existing per-album validation; then:

```js
const move = req.body?.move !== false; // default MOVE
const total = albums.reduce((n, a) => n + a.photoIds.length, 0);
const job = registry.create("materialize", {
  label: `Materialize ${albums.length} albums (${move ? "move" : "copy"})`,
  total,
});
res.status(202).json({ jobId: job.id });
(async () => {
  try {
    const results = [];
    const manifest = [];
    let done = 0;
    for (const album of albums) {
      if (job.controller.signal.aborted)
        throw Object.assign(new Error("canceled"), { name: "AbortError" });
      const resolved = resolveExportTarget(db, destParent, album.name);
      if (resolved.error) throw new Error(resolved.error);
      const r = copyIdsIntoFolder(db, resolved.target, album.photoIds, {
        signal: job.controller.signal,
        move,
        onProgress: (d, _t, phase) =>
          registry.update(job.id, {
            done: done + d,
            phase: `${album.name}: ${phase}`,
          }),
      });
      done += album.photoIds.length;
      results.push({
        name: album.name,
        target: resolved.target,
        copied: r.copied,
        moved: r.moved,
        skipped: r.skipped,
      });
      manifest.push(...r.manifest);
    }
    registry.finish(job.id, { destParent, albums: results, move, manifest });
  } catch (e) {
    registry.fail(job.id, e);
  }
})();
```

- [ ] **Step 4: Run tests** — expect PASS.
- [ ] **Step 5: Commit** `feat(materialize): background job + move-default option`.

---

### Task 7: Recursive scan as a job

**Files:**

- Modify: `server/api.js` (`POST /api/scan`, recursive branch)
- Test: `server/api.test.js`

**Interfaces:**

- Produces: recursive scan returns `202 {jobId}`; job `result` = `{root, count, folders, elapsedMs}`; per-subfolder progress; abortable between subfolders. Non-recursive (single-folder) scan stays synchronous (fast; returns items for immediate render) — do NOT change it.

- [ ] **Step 1: Add test**: `POST /api/scan {dir, recursive:true}` → 202 `{jobId}`; job completes `done` with `folders`/`count`. Single-folder scan test unchanged (still 200 + items).
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** — in the `if (recursive)` branch, list dirs first, create the job with `total = dirs.length`, respond 202, then loop async checking `signal.aborted` between subdirs and `registry.update(...,{done, phase:"scanning "+basename(subdir)})`; `finish` with counts.
- [ ] **Step 4: Run tests** — expect PASS.
- [ ] **Step 5: Commit** `feat(scan): recursive scan as a cancelable background job`.

---

### Task 8: Undo-move endpoint

**Files:**

- Modify: `server/api.js`
- Test: `server/api.test.js` / `server/copy.test.js`

**Interfaces:**

- Consumes: a completed move job's `result.manifest`.
- Produces: `POST /api/albums/undo-move {manifest}` → `202 {jobId}` (type `undo-move`); moves each `to` back to `from` (copy→verify→unlink), repoints the index back; job `result` = `{restored, skipped}`.

- [ ] **Step 1: Write failing test**: after a move (manifest captured), `undo-move` restores every `from`, removes each `to`, and `getPhotoById` paths are back to the originals.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** — validate `manifest` is an array of `{from,to}`; spawn an `undo-move` job that iterates `moveFile(to, from)` + `repointPhoto(db, id, from)`, honoring `signal`.
- [ ] **Step 4: Run tests** — expect PASS.
- [ ] **Step 5: Commit** `feat(materialize): undo-move restores relocated originals`.

---

### Task 9: Frontend jobs store

**Files:**

- Create: `ui/src/lib/jobs.js`
- Modify: `ui/src/lib/api.js` (add `startScan/startExport/startMaterialize/undoMove` POST helpers returning `{jobId}`)
- Test: `ui/src/lib/jobs.test.js` (store reducer logic only; mock EventSource)

**Interfaces:**

- Produces: a `jobs` readable store (array); `startExport(...)`, `startMaterialize({destParent,albums,move})`, `startScan(dir,{recursive})`, `cancelJob(id)`, `dismissJob(id)`, `undoMove(job)`, and `waitForJob(id): Promise<job>` (resolves when that id leaves `running`).

- [ ] **Step 1: Write failing test** for the pure reducer: given a sequence of SSE snapshots, the store holds the latest array; `waitForJob(id)` resolves once the matching job's status !== "running". (Inject a fake EventSource.)
- [ ] **Step 2: Run** `npx vitest run ui/src/lib/jobs.test.js` — expect FAIL.
- [ ] **Step 3: Implement** the store: `writable([])`, one `EventSource("/api/jobs/events")` whose `onmessage` sets the array; `waitForJob` subscribes and resolves/unsubs on terminal. Add the `api.js` POST helpers (fetch → json `{jobId}`; cancel/dismiss/undo POST).
- [ ] **Step 4: Run tests** — expect PASS.
- [ ] **Step 5: Commit** `feat(ui): jobs store over SSE with waitForJob`.

---

### Task 10: JobsPanel component + mount

**Files:**

- Create: `ui/src/lib/JobsPanel.svelte`
- Modify: `ui/src/App.svelte` (mount in the bottom status bar)

**Interfaces:**

- Consumes: `jobs` store, `cancelJob/dismissJob/undoMove`.

- [ ] **Step 1: Implement** `JobsPanel.svelte` (Svelte 4): subscribe `$jobs`; render nothing when empty; else a bottom bar row per job — label, `<progress value={job.done} max={job.total || undefined}>`, `phase`; **Cancel** button (`on:click={() => cancelJob(job.id)}`) while `status==="running"`; on `done` show a summary (materialize: `moved/copied/skipped`; export: `copied/skipped`; scan: `folders/count`) + dismiss × + **Undo** for `type==="materialize" && result?.move`; on `canceled/failed` show ✗ + `error` + dismiss ×.
- [ ] **Step 2: Mount** `<JobsPanel />` in App.svelte's status/footer area.
- [ ] **Step 3: Build check** `npm run build` — expect success.
- [ ] **Step 4: Commit** `feat(ui): cancelable background-jobs status panel`.

---

### Task 11: Rewire callers

**Files:**

- Modify: `ui/src/App.svelte` (export + recursive-scan callers), `ui/src/lib/AlbumsView.svelte` (materialize + Move/Copy toggle)

**Interfaces:**

- Consumes: `startExport/startScan/startMaterialize` + `waitForJob`.

- [ ] **Step 1: Export caller** — replace the awaited `exportSelection(...)` with `const {jobId} = await startExport(...); await waitForJob(jobId)` then the existing post-export UI (result now comes from the job; the panel shows progress). Remove the now-redundant inline result toast if the panel covers it.
- [ ] **Step 2: Recursive-scan caller** — same pattern for recursive scans; single-folder scan path unchanged.
- [ ] **Step 3: Materialize + toggle** — in `AlbumsView.svelte`, add a **Move / Copy** control (Svelte 4 radio/segmented), state `let move = true;` (default MOVE), with a one-line caution when Move is selected ("moves originals out of the source folders — undoable from the jobs panel"). Call `startMaterialize({destParent, albums, move})` + `waitForJob`.
- [ ] **Step 4: Build check** `npm run build` — expect success.
- [ ] **Step 5: Commit** `feat(ui): route export/scan/materialize through background jobs (materialize move-default)`.

---

### Task 12: Live verification

- [ ] **Step 1:** Restart `npm run dev`; run `npm test` (all green).
- [ ] **Step 2:** Copy a small test folder into the **scratchpad** (never the real read-only test folders); scan it.
- [ ] **Step 3:** Via claude-in-chrome: run AlbumsView **materialize (Move)** into a scratchpad dest; watch the panel progress; **Cancel** mid-run once and confirm partial state is consistent (sources for processed files moved, rest intact); run again to completion; **Undo** and confirm originals restored + feed reflects it.
- [ ] **Step 4:** Repeat once with **Copy** and confirm sources remain.
- [ ] **Step 5:** Confirm the feed shows moved photos at their new location (not "missing"/offline) after a move.
- [ ] **Step 6: Commit** any fixes; open a PR from `feat/background-jobs`.

---

## Self-review notes

- Spec coverage: registry (T1), SSE/endpoints (T2), cancel+move copy loop (T3), index repoint (T4), export/materialize/scan jobs (T5–T7), undo (T8), store+panel+rewire (T9–T11), live verify (T12). All spec sections mapped.
- `copyIdsIntoFolder` signature is defined once (T3) and consumed with the same shape in T5/T6/T8.
- Non-recursive scan intentionally stays synchronous (fast, returns items) — called out in T7 so a reviewer doesn't "fix" it.
