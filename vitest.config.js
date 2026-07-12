import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  // The Svelte plugin is here only so a PURE module may *import* a component:
  // ui/src/lib/groupRenderers.js — the single registry of group photo renderers —
  // references each renderer's Svelte component directly, so the registry stays
  // ONE source of truth (see
  // docs/superpowers/specs/2026-07-12-group-photo-renderers.md). Without the
  // plugin, vitest can't parse that .svelte import and the registry's own tests
  // fail to load. The convention below is unchanged: we still don't write
  // component tests.
  plugins: [svelte({ hot: false })],
  test: {
    environment: "node",
    // Server tests live next to sources; UI tests cover pure modules only
    // (layout functions, registries etc.) — components are exercised in the
    // browser.
    include: ["server/**/*.test.js", "ui/src/**/*.test.js"],
  },
});
