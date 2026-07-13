# Library Dropdown Offline Jump Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking an offline (unmounted) folder in the "Library ▾" dropdown browses its cached content read-only, instead of doing nothing.

**Architecture:** `selectFromLibrary` reuses the existing `jumpToPath` function (already used by the tree sidebar) for the offline case; the mounted case is unchanged.

**Tech Stack:** Svelte.

## Global Constraints

- No automated test for this task — client-only Svelte change reusing an already-tested server-side code path (`jumpToPath`/`startPath` seeking, covered by `server/db/feed.test.js`). Manual verification only, per this project's established convention.

---

### Task 1: Wire offline Library entries to `jumpToPath`

**Files:**

- Modify: `ui/src/App.svelte`

**Interfaces:**

- Consumes: `jumpToPath(path)` (existing function, `App.svelte:267`).
- Produces: no new exports — this is the finished feature.

- [ ] **Step 1: Update `selectFromLibrary`**

In `ui/src/App.svelte`, find `selectFromLibrary` (search for
`function selectFromLibrary`) and change it from:

```js
function selectFromLibrary(entry) {
  if (!entry.mounted) return;
  dir = entry.path;
  libraryOpen = false;
  doScan();
}
```

to:

```js
function selectFromLibrary(entry) {
  libraryOpen = false;
  if (!entry.mounted) {
    // Offline folders can still be browsed read-only from the SQLite
    // cache (the app's offline-mirror invariant) — reuse the same
    // jumpToPath the tree sidebar already uses for any folder, rather
    // than requiring a live rescan this folder's volume can't provide.
    jumpToPath([{ dimension: "folder", value: entry.path }]);
    return;
  }
  dir = entry.path;
  doScan();
}
```

- [ ] **Step 2: Remove the `disabled` attribute on offline entries**

Find the library entry button (search for `class="library-entry"`) and
change:

```svelte
              <button
                class="library-entry"
                class:offline={!entry.mounted}
                disabled={!entry.mounted}
                on:click={() => selectFromLibrary(entry)}
                title={entry.path}
              >
```

to:

```svelte
              <button
                class="library-entry"
                class:offline={!entry.mounted}
                on:click={() => selectFromLibrary(entry)}
                title={entry.path}
              >
```

(the `class:offline` styling and the "offline" badge span right after it
stay exactly as they are — still the visual signal that this folder's
content is being browsed from cache, not live)

- [ ] **Step 3: Run the full test suite and build**

Run: `npx vitest run`
Expected: All tests pass (this task touches only Svelte component code, no
pure-function logic covered by existing tests).

Run: `npm run build`
Expected: Builds successfully with no compile errors.

- [ ] **Step 4: Commit**

```bash
git add ui/src/App.svelte
git commit -m "feat: browse an offline folder's cached content from the Library dropdown (GH #8)"
```

---

### Task 2: Manual validation

**Files:** none (verification only).

- [ ] **Step 1: Start the dev server**

Run: `npm run dev`

- [ ] **Step 2: Verify offline browsing**

Using a real, already-indexed folder whose volume can be unmounted (or a
folder path that no longer exists — the existing `mounted` check already
handles both the same way), confirm its Library dropdown entry shows the
"offline" badge and is clickable (not grayed out), click it, and confirm
the feed jumps to that folder's photos with cached thumbnails/metadata and
no scan/error — matching what the tree sidebar already does for the same
folder.

- [ ] **Step 3: Verify the mounted case is unchanged**

Click a currently-mounted folder's entry, confirm it still does a live
scan (status shows "scanning…" then the photo count) exactly as before.

- [ ] **Step 4: Check for console errors**

Confirm no unexpected console errors during the above.

- [ ] **Step 5: Stop the dev server**

No commit for this task — it's verification only.
