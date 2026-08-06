# Design docs

Three kinds of document live here, and they age differently.

| Folder             | What it is                                | Lifespan                          |
| ------------------ | ----------------------------------------- | --------------------------------- |
| `specs/`           | The design and the **why** behind it      | Outlives the code. Keep.          |
| `plans/`           | Step-by-step build instructions, **live** | Until the feature ships.          |
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

## `plans/` vs `completed_plans/` — and how to tell which a plan is

A plan lives in `plans/` while its feature is being built and **moves to
`completed_plans/` in the PR that ships it**. That move is the only thing
separating instructions you should follow from history you should not, so it is
worth doing in the same commit rather than "later".

**Do not use the checkboxes to decide.** Every plan in this repo reads `0`
ticked, including ones whose feature shipped weeks earlier — nobody maintains
them, so `- [ ]` means "written down", not "outstanding" (#323). The reliable
test is one command:

```bash
gh issue view <the issue the plan names> --json state -q .state
```

Open issue → the plan is live. Closed, or the feature is visibly in the app →
the plan is spent, and moving it is a one-line PR anybody can make.

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
