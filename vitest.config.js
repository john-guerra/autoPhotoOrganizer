import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  // The Svelte plugin is here only so a PURE module may *import* a component:
  // ui/src/lib/groupRenderers.js — the single registry of group photo renderers —
  // references each renderer's Svelte component directly, so the registry stays
  // ONE source of truth (see
  // docs/superpowers/specs/2026-07-12-group-photo-renderers.md). Without the
  // plugin, vitest can't parse that .svelte import and the registry's own tests
  // fail to load. (Component *interaction* is tested in e2e/ under Playwright,
  // not here — see the tiers below.)
  plugins: [svelte({ hot: false })],
  test: {
    environment: "node",
    // TIER 1 — fast unit tests: server logic + DOM-free UI modules (layout, feed,
    // registries). Milliseconds; run constantly. NB groupRenderers.js is
    // DOM-free but not import-free — it references its renderers' components, so
    // it needs the Svelte plugin above. That's the price of the registry being
    // one source of truth.
    //
    // TIER 2 — UI interaction tests live in e2e/ and run under Playwright
    // (`npm run test:e2e`). They are NOT in this project.
    //
    // The old premise here — "components are exercised in the browser" — meant
    // exercised BY HAND. Nothing automated ever clicked anything, and every
    // regression in the 2.9.x batch (a hover that ballooned a header, a renderer
    // id colliding with a CSS class, a collapse that threw) was a click-level bug
    // this tier structurally cannot catch. Both tiers are required now; see
    // issue #101.
    include: ["server/**/*.test.js", "ui/src/**/*.test.js"],
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
    server: {
      deps: {
        // `@john-guerra/d3-zoomable-axis` imports `reactive-widget-helper`,
        // which ships NO `exports` map — only the legacy `main`/`module`
        // fields, where `main` is a minified bundle with no ESM default
        // export. Vitest externalizes bare dependencies by default, so Node
        // resolves it directly, picks `main`, and the import throws
        // "does not provide an export named 'default'". Vite's own resolution
        // prefers `module` and works, which is why the app builds and runs
        // fine — only this tier saw it.
        //
        // It surfaced when views/registry.js started importing AlbumsView (the
        // registry references its components directly, exactly as
        // groupRenderers.js does, so there is one source of truth rather than
        // a second string→component table to drift). Inlining hands the
        // package to Vite instead of Node.
        //
        // The real fix belongs upstream in reactive-widget-helper: an
        // `exports` map with an `import` condition pointing at
        // `dist/ReactiveWidget.es.js`. Drop this once that ships.
        inline: [/@john-guerra\/d3-zoomable-axis/],
      },
    },
  },
});
