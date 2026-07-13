# Design docs

Three kinds of document live here, and they age differently.

| Folder             | What it is                                | Lifespan                          |
| ------------------ | ----------------------------------------- | --------------------------------- |
| `specs/`           | The design and the **why** behind it      | Outlives the code. Keep.          |
| `completed_plans/` | Step-by-step build instructions, executed | **Spent** once merged. Reference. |

A **spec** answers "why is it built this way" — the question the code cannot
answer about itself. Several are cited directly from source (`bursts.js`,
`displayEntries.js`, `pickCover.js`, `treeState.js`, `vitest.config.js`), so
they are live documentation, not history: don't move or rename them without
fixing the citations.

A **plan** answers "what do I type next". Once its feature ships, the code is a
better answer than the plan, and a stale plan actively misleads — it describes an
intended end state, not the one that survived review. They are kept in
`completed_plans/` as a record of how a feature was built (useful when
archaeology is needed), never as instructions to follow.

## Specs the code points at

These are load-bearing. A source file names them; breaking the path breaks the
comment that sends the next reader here.

- **`2026-07-06-photo-triage-design.md`** — the foundational one. `CLAUDE.md`
  says start here, and it still describes the architecture the app has.
- `2026-07-06-burst-detection-design.md` → `ui/src/lib/bursts.js`
- `2026-07-06-burst-stacks-grid-integration-design.md` → `ui/src/lib/displayEntries.js`
- `2026-07-06-burst-stack-visual-and-manual-cover-design.md` → `ui/src/lib/pickCover.js`
- `2026-07-06-tree-sidebar-design.md` → `ui/src/lib/treeState.js` ("Two sources of truth")
- `2026-07-06-electron-packaging-design.md` → `README.md`
- `2026-07-12-group-photo-renderers.md` → `vitest.config.js`

## Specs since overtaken

Still worth reading for the reasoning, but the UI they describe is **not** the UI
that shipped. Check the code before trusting a detail:

- `2026-07-08-toolbar-redesign-design.md` — superseded by
  `2026-07-11-status-bar-toolbar-reorg-design.md`.
- `2026-07-08-fisheye-sidebar-design.md` — superseded by
  `2026-07-09-fisheye-snapshot-view-design.md`.
- `2026-07-07-library-dropdown-offline-jump-design.md` — the folders dropdown and
  the "Folder focus" / "Keep only" pair it describes were merged into one ＋ panel
  and a single scope chip by
  `2026-07-13-folder-controls-and-selective-add-design.md`.

Everything else in `specs/` describes a feature that shipped roughly as designed.
