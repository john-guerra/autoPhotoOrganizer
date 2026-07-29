import { describe, it, expect } from "vitest";
import {
  VIEWS,
  GRID,
  ALBUMS,
  FACE_MAP,
  CAPABILITIES,
  NAVIGATIONS,
  DATA_SOURCES,
  DEFAULT_VIEW_ID,
  getView,
  supports,
  nextViewId,
  viewKeys,
  claimsKey,
  restorableViewId,
  offerableViews,
} from "./registry.js";

/**
 * The registry conformance gate (#155).
 *
 * This tier checks what every view DECLARES; `e2e/views.spec.js` checks that
 * the declaration is true of the running app. The split is deliberate and
 * follows vitest.config.js: this project is `environment: "node"` with no
 * jsdom, because component interaction is Playwright's job. A "mount every
 * view" test here would need a DOM the tier does not have, and a mounted
 * component that merely renders proves nothing about whether a rating
 * keystroke reaches SQLite — which is the thing that actually broke before.
 *
 * The failure this file exists to catch is the cheap one: a fourth view added
 * with `capabilities: { open: true }` and no word about selection or rating.
 * That reads as "supported" at every call site (`undefined` is falsy only if
 * you remember to check) and is exactly the silent-swallow §3 forbids.
 */
describe("view registry conformance", () => {
  it("registers the grid as the default view", () => {
    expect(DEFAULT_VIEW_ID).toBe(GRID.id);
    expect(VIEWS[0]).toBe(GRID);
  });

  it("gives every view a unique id", () => {
    const ids = VIEWS.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const view of VIEWS) {
    describe(`${view.id}`, () => {
      it("declares a label, an icon, a description and a component", () => {
        expect(view.label).toBeTruthy();
        expect(view.icon).toBeTruthy();
        // The switcher button's tooltip. On the descriptor so a new view
        // arrives with its own explanation rather than a parallel string
        // table in the toolbar — and so it cannot ship without one.
        expect(view.description?.length).toBeGreaterThan(20);
        // A registry entry pointing at nothing is a blank main area with no
        // error anywhere — the failure mode the fallback in getView() cannot
        // help with, because the id resolves fine.
        expect(view.component).toBeTruthy();
      });

      it("declares who owns the viewport and where its data comes from", () => {
        expect(NAVIGATIONS).toContain(view.navigation);
        expect(DATA_SOURCES).toContain(view.dataSource);
      });

      // THE gate. Not "capabilities is an object" — every key, explicitly
      // boolean, so an omitted one fails here instead of being read as
      // "unsupported" by one call site and "supported" by the next.
      it.each(CAPABILITIES)("declares %s explicitly, as a boolean", (cap) => {
        expect(typeof view.capabilities[cap]).toBe("boolean");
      });

      it("declares no capability the registry does not know about", () => {
        expect(Object.keys(view.capabilities).sort()).toEqual(
          [...CAPABILITIES].sort()
        );
      });
    });
  }

  it("keeps the grid fully capable — it is the app's home view", () => {
    // The extraction's contract: the grid does everything it did inside
    // App.svelte. A regression here means rating or selection quietly left.
    for (const cap of CAPABILITIES) expect(supports(GRID.id, cap)).toBe(true);
  });

  it("declares albums as opening photos but neither selecting nor rating", () => {
    expect(supports(ALBUMS.id, "open")).toBe(true);
    expect(supports(ALBUMS.id, "select")).toBe(false);
    expect(supports(ALBUMS.id, "rate")).toBe(false);
  });

  it("pulls whole-library data through a working set, never the feed", () => {
    // A view that needs more than the feed window declares it, so App can do
    // the bounded fetch. The alternative — widening `items` — is the seventh
    // copy of the feed-window guard (#35/#36/#39).
    expect(ALBUMS.dataSource).toBe("working-set");
    expect(GRID.dataSource).toBe("feed");
  });
});

describe("resolving a view", () => {
  it("finds a registered view by id", () => {
    expect(getView("albums")).toBe(ALBUMS);
  });

  it("falls back to the grid for an unknown id rather than throwing", () => {
    // The id is persisted. A build that drops a view must not leave a
    // returning user on a blank main area with no way back.
    expect(getView("treemap-that-shipped-then-left")).toBe(GRID);
    expect(getView(undefined)).toBe(GRID);
  });

  it("gives an unknown view the grid's full capability, deliberately", () => {
    // Falling back to GRID means an unknown id claims full capability. That is
    // the safe direction (the user keeps rating and selecting); pinning it
    // here so a future change to getView's fallback is a deliberate one.
    expect(supports("nope", "rate")).toBe(true);
  });
});

describe("what a fresh load restores", () => {
  it("restores a feed view", () => {
    expect(restorableViewId("grid")).toBe("grid");
  });

  it("does NOT restore a working-set view — its data didn't survive", () => {
    // Restoring the id alone drops you into the album review with no albums
    // in it: an empty shell that reads as the app having lost your work. Only
    // App can fetch that data, and doing it during boot would hold up first
    // paint for a view you may not even want.
    expect(restorableViewId("albums")).toBe(DEFAULT_VIEW_ID);
  });

  it("falls back to the default for an id no build registers any more", () => {
    expect(restorableViewId("treemap-that-shipped-then-left")).toBe(
      DEFAULT_VIEW_ID
    );
    expect(restorableViewId(undefined)).toBe(DEFAULT_VIEW_ID);
  });

  it("restores something that is always safe to open with no fetch", () => {
    // The property that actually matters, stated as a property rather than as
    // three examples: whatever comes back must be a registered view whose data
    // App already has.
    for (const id of [...VIEWS.map((v) => v.id), "nope", undefined]) {
      expect(getView(restorableViewId(id)).dataSource).toBe("feed");
    }
  });
});

describe("which views the switcher offers (#223)", () => {
  it("always offers the grid and albums", () => {
    const ids = offerableViews({ peopleCount: 0 }).map((v) => v.id);
    expect(ids).toContain("grid");
    expect(ids).toContain("albums");
  });

  it("does NOT offer People until there are people", () => {
    // The toolbar folds by WIDTH: a third always-on button pushed Group-by
    // into the overflow popover at 1280px (CI was green with two buttons and
    // red with three). PersonFilter learned the same lesson and renders
    // nothing until someone has been found. A People button with nobody in it
    // buys nothing and costs the same width either way.
    expect(offerableViews({ peopleCount: 0 }).map((v) => v.id)).not.toContain(
      "people"
    );
    expect(offerableViews({ peopleCount: 3 }).map((v) => v.id)).toContain(
      "people"
    );
  });

  it("still CYCLES every view, offered or not", () => {
    // Hiding a button is about toolbar width, not about taking a view away —
    // V must still reach People so its empty state can explain how to fill it.
    expect(nextViewId("albums")).toBe("people");
    expect(VIEWS.map((v) => v.id)).toContain("people");
  });

  it("treats a view with no predicate as always offered", () => {
    for (const v of VIEWS.filter((x) => !x.offerable)) {
      expect(offerableViews({ peopleCount: 0 })).toContain(v);
    }
  });
});

describe("cycling views", () => {
  it("advances through the registry in order", () => {
    expect(nextViewId("grid")).toBe("albums");
  });

  it("wraps at the end", () => {
    expect(nextViewId(VIEWS.at(-1).id)).toBe(VIEWS[0].id);
  });

  it("treats an unknown id as the default, and advances from there", () => {
    // findIndex returns -1 for an unknown id; `-1 + 1 === 0` would land back
    // on the DEFAULT rather than advancing past it, so the user would press
    // the switcher and see nothing change. Same trap nextRendererId documents.
    expect(nextViewId("nope")).toBe(nextViewId(DEFAULT_VIEW_ID));
    expect(nextViewId("nope")).not.toBe(DEFAULT_VIEW_ID);
  });
});

describe("view-local keys (#232)", () => {
  it("defaults to no declared keys", () => {
    // A view that declares nothing behaves exactly as before: App's capability
    // check is the only gate.
    expect(viewKeys(GRID.id)).toEqual([]);
    expect(claimsKey(GRID.id, "Escape")).toBe(false);
  });

  it("every declared row has both keys[] and a label", () => {
    // ShortcutsOverlay renders these rows directly and its own `groups` use
    // the same {keys, label} shape, so a row missing either half is a blank
    // line in the help menu — the "a shortcut nobody can find does not exist"
    // rule, enforced rather than trusted.
    for (const v of VIEWS) {
      for (const row of v.keys ?? []) {
        expect(Array.isArray(row.keys)).toBe(true);
        expect(row.keys.length).toBeGreaterThan(0);
        expect(typeof row.label).toBe("string");
        expect(row.label.length).toBeGreaterThan(0);
      }
    }
  });

  it("claimsKey matches case-insensitively, the way KeyboardEvent.key arrives", () => {
    // `X` and `x` are the same keystroke with and without shift; a declaration
    // that only matched one would refuse half the presses.
    const fake = {
      ...GRID,
      id: "fake",
      keys: [{ keys: ["X"], label: "test" }],
    };
    VIEWS.push(fake);
    try {
      expect(claimsKey("fake", "x")).toBe(true);
      expect(claimsKey("fake", "X")).toBe(true);
      expect(claimsKey("fake", "y")).toBe(false);
    } finally {
      VIEWS.pop();
    }
  });

  it("answers for an unknown view without throwing", () => {
    // getView falls back to GRID, so this must be false rather than a crash.
    expect(claimsKey("no-such-view", "Escape")).toBe(false);
    expect(viewKeys("no-such-view")).toEqual([]);
  });
});

describe("FACE_MAP (#232)", () => {
  it("declares all three capabilities explicitly", () => {
    for (const c of CAPABILITIES) {
      expect(typeof FACE_MAP.capabilities[c]).toBe("boolean");
    }
  });

  it("opens photos, because a 160px crop is not enough to judge a merge", () => {
    // Declaring false while wiring photo-opening would be a lie nothing
    // currently catches — capabilities.open is read by nothing yet, so it
    // would break the moment something reads it.
    expect(FACE_MAP.capabilities.open).toBe(true);
  });

  it("does NOT join App's photo selection or rating", () => {
    // PeopleView's exact reason: `selected` indexes a feed window this view
    // does not render, so a `3` here would rate a photo you cannot see. This
    // view's selection is of people and is private to it.
    expect(FACE_MAP.capabilities.select).toBe(false);
    expect(FACE_MAP.capabilities.rate).toBe(false);
  });

  it("declares the keys it handles, so App does not refuse them", () => {
    // Without this, Escape would be answered with "Selecting photos isn't
    // available in Face Map" while the view has people selected.
    expect(claimsKey(FACE_MAP.id, "Escape")).toBe(true);
    expect(claimsKey(FACE_MAP.id, "0")).toBe(true);
    expect(viewKeys(FACE_MAP.id).length).toBeGreaterThan(0);
  });

  it("is the first view to own its own viewport", () => {
    expect(FACE_MAP.navigation).toBe("zoom");
    expect(FACE_MAP.dataSource).toBe("working-set");
  });

  it("EARNS its toolbar slot rather than taking one unconditionally", () => {
    // The toolbar folds by width and this is the fourth view; #223 hit that at
    // 1280px, CI-only, with 151/151 green locally. A map of three people is
    // useless anyway.
    expect(FACE_MAP.offerable({ peopleCount: 3 })).toBe(false);
    expect(FACE_MAP.offerable({ peopleCount: 99 })).toBe(false);
    expect(FACE_MAP.offerable({ peopleCount: 5000 })).toBe(true);
  });
});

describe("declared keys match real KeyboardEvent.key values", () => {
  /** Tokens the overlay renders as connective text, never matched as keys. */
  const JOINERS = new Set(["+", "–", "arrow", "drag", "⌘ / Ctrl"]);

  it("spells named keys the way the browser reports them", () => {
    // "Esc" reads fine in a help menu and NEVER matches: KeyboardEvent.key is
    // "Escape". A declaration that cannot match is worse than none, because
    // App then answers the key with a confidently wrong message.
    const WRONG = { esc: "Escape", del: "Delete", ins: "Insert", spc: " " };
    for (const v of VIEWS) {
      for (const row of v.keys ?? []) {
        for (const k of row.keys) {
          if (JOINERS.has(k)) continue;
          expect(
            WRONG[k.toLowerCase()],
            `${v.id} declares "${k}" — KeyboardEvent.key reports "${WRONG[k.toLowerCase()]}"`
          ).toBeUndefined();
        }
      }
    }
  });
});
