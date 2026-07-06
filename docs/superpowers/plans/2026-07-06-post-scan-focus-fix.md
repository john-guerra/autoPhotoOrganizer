# Post-Scan Focus Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a successful scan, move DOM focus to the selected `Thumb` so Enter opens the loupe instead of re-triggering a scan (GitHub issue #1).

**Architecture:** One-line addition to `doScan`'s success path in `ui/src/App.svelte`, reusing the exact `await tick()` + `querySelector(...).focus()` idiom already used by `closeLoupe` and the keyboard-nav Home/End fix.

**Tech Stack:** Svelte 4 (no runes), vitest, plain JS + JSDoc (no TypeScript).

## Global Constraints

- ESM everywhere (`"type": "module"`); no TypeScript — plain JS + JSDoc types.
- Tests: vitest, colocated as `*.test.js` next to the source file.
- Do **not** run automated browser/Playwright verification — John verifies visually himself at `localhost:5173`. Run unit tests, then stop and report tersely (working agreement in `docs/ROADMAP.md`).
- Commit after the task; do not batch with unrelated changes.
- Full spec: `docs/superpowers/specs/2026-07-06-post-scan-focus-fix-design.md`.

---

### Task 1: Focus the selected Thumb after a successful scan

**Files:**
- Modify: `ui/src/App.svelte:56-76` (the `doScan` function)

**Interfaces:**
- Uses existing: `tick` (already imported at the top of the file, used by `closeLoupe`), `gridEl`, `items`, `selected` — no new state or exports.

- [ ] **Step 1: Add the focus call to `doScan`'s success path**

In `ui/src/App.svelte`, the current `doScan` function reads:

```js
  async function doScan() {
    if (!dir.trim()) return;
    error = "";
    scanning = true;
    status = "scanning…";
    try {
      const res = await apiScan(dir.trim());
      items = res.items;
      selected = 0;
      loupeOpen = false;
      localStorage.setItem(LS_KEY, res.root);
      status = `${res.count} photos · scanned in ${res.elapsedMs} ms`;
      enrichMeta(++scanEpoch);
    } catch (e) {
      error = e.message;
      status = "";
      items = [];
    } finally {
      scanning = false;
    }
  }
```

Change the `try` block to:

```js
    try {
      const res = await apiScan(dir.trim());
      items = res.items;
      selected = 0;
      loupeOpen = false;
      localStorage.setItem(LS_KEY, res.root);
      status = `${res.count} photos · scanned in ${res.elapsedMs} ms`;
      enrichMeta(++scanEpoch);
      await tick();
      gridEl?.querySelector(`[data-id="${items[selected]?.id}"]`)?.focus();
    } catch (e) {
```

(Only the two new lines — `await tick();` and the `gridEl?.querySelector(...)` line — are added, right after `enrichMeta(++scanEpoch);` and before the `catch`. Nothing else in the function changes.)

- [ ] **Step 2: Run the full test suite to check for regressions**

Run: `npm test`
Expected: PASS — all 32 existing tests remain green. This task adds no new automated test (App.svelte has no component test harness, consistent with the rest of the codebase — vitest here covers pure modules only).

- [ ] **Step 3: Commit**

```bash
git add ui/src/App.svelte
git commit -m "$(cat <<'EOF'
fix: focus the selected thumb after a successful scan

Enter in the path input used to re-trigger a scan instead of opening
the loupe, because focus stayed in the input after Scan completed and
the global keydown handler ignores keystrokes while an input is
focused. Moves focus to the selected Thumb button, reusing the same
await-tick-then-focus idiom already used by closeLoupe and the
keyboard-nav Home/End fix. Fixes GitHub issue #1.
EOF
)"
```

- [ ] **Step 4: Stop for manual verification**

Per the working agreement in `docs/ROADMAP.md`, do **not** run automated browser/Playwright verification. Report tersely that unit tests pass, and ask John to verify at `localhost:5173`: scan a folder, press Enter immediately without clicking anything else, and confirm the loupe opens on the first photo instead of re-scanning. Also worth a spot-check: scan an *invalid* path and confirm focus stays in the input (unchanged behavior — the `catch` block isn't touched by this fix).

---

## Self-Review Notes

- **Spec coverage:** the fix (Step 1) ✓; failure-path unchanged, confirmed by inspection (`catch` block untouched) ✓; out-of-scope items (closeLoupe, keyboard nav, rescan-specific logic) untouched by this plan ✓.
- **No placeholders:** the step contains complete, runnable code.
- **Type/name consistency:** reuses `gridEl`, `items`, `selected`, `tick` exactly as they're already named and used elsewhere in `App.svelte` (`closeLoupe`, `onKeydown`) — no new names introduced.
