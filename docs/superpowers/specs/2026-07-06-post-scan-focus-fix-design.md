# Post-scan focus fix — Design

Status: Approved, ready for implementation plan
Date: 2026-07-06

## Context & problem

GitHub issue #1 (`v0.2` milestone): after a successful scan, browser focus
stays in the `.dir` path input (`ui/src/App.svelte`). That input's own
`on:keydown` treats Enter as "re-scan" (App.svelte:304), and the global
`onKeydown` handler explicitly ignores keystrokes while an `<input>` is
focused (App.svelte:225-226). So pressing Enter right after a scan
re-triggers the scan instead of opening the loupe on the first photo — the
user has to manually click into the grid first.

## Fix

In `doScan`'s success path (`ui/src/App.svelte:56-76`), after `items` and
`selected` are set, move DOM focus to the selected `Thumb` button:

```js
await tick();
gridEl?.querySelector(`[data-id="${items[selected]?.id}"]`)?.focus();
```

This reuses the exact idiom already used in `closeLoupe` (App.svelte:139)
and the keyboard-nav Home/End fix (App.svelte:283-286) — focus the actual
selected `Thumb` button (visible via its existing `.selected` outline), not
the grid container generically, so keyboard focus is consistently
represented the same way everywhere in the app.

`await tick()` is required because on the very first scan ever, the grid
`<div>` (and therefore `gridEl`) doesn't exist in the DOM at the instant
`items` is assigned — `{#if items.length}` only mounts it after Svelte's
next update flush.

**On scan failure:** nothing is touched (the existing `catch` block doesn't
call this code), so focus correctly stays in the input for the user to
fix the path and retry — no new logic needed for this case.

## Out of scope

- No change to rescan behavior beyond what the fix already implies (a
  rescan re-focuses the new selected item the same way a first scan does).
- No change to `closeLoupe`, keyboard nav, or any other focus path — this
  only touches `doScan`'s success branch.

## Testing

`App.svelte` has no component test harness (consistent with the rest of
the codebase — vitest here covers pure modules only). Verification is a
regression run of the existing suite plus John's manual check at
`localhost:5173`: scan a folder, press Enter immediately without clicking
anything, confirm the loupe opens on the first photo instead of re-scanning.
