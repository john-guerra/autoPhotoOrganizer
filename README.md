# AutoGallery

Fast, local-first photo triage. Plug in an SD card, get an instant grid, cull with
the keyboard, and organize the best shots into dated album folders — without the
slowness of Lightroom or a dead app like Picasa.

Two principles drive the design:

1. **Folders on disk are the source of truth** — never an owning catalog.
2. **The index is a rebuildable, persistent cache on your internal disk**, so you
   can browse previews, metadata, and ratings even with the external drive
   unmounted (offline). Only export/moves/resizes need the drive mounted.

## Status

**v2 is in progress — this is the scaffold only.** Nothing user-facing works yet:
there is an Express health endpoint and a Svelte placeholder page that proves the
dev loop. The photo scanning, culling, clustering, and export features described in
the design doc are not built.

The two previous generations of the app are archived under
[`legacy/`](./legacy/) for reference — **do not run them** (they contain known
insecure patterns). They exist to port the album-clustering algorithm into v2.

## Quick start

Requires Node.js >= 22.

```bash
npm install
npm run dev
```

This starts the Express API on <http://localhost:4321> and the Vite UI on
<http://localhost:5173>. Open the UI; it should report the API health as `ok`.

Other commands:

```bash
npm test     # run the test suite (vitest)
npm run build  # build the UI to dist/ (served by Express in production)
npm run format # prettier
```

## Design

See [`docs/superpowers/specs/2026-07-06-photo-triage-design.md`](./docs/superpowers/specs/2026-07-06-photo-triage-design.md)
for the full design: architecture, performance strategy, MVP scope, and the
Phase 2 (faces / CLIP search / ML pick prediction) plan.
