// Exists for the EDITOR, not for the build. Keep it next to vite.config.js.
//
// The Svelte VS Code extension (svelte-language-server) resolves a config by
// walking up from the .svelte file and taking the first vite.config it finds —
// ui/vite.config.js. It then asks @sveltejs/load-config to pull the Svelte
// options out of it by looking for a Vite plugin named "vite-plugin-svelte:config".
// That sub-plugin only exists in @sveltejs/vite-plugin-svelte v5+ (Svelte 5).
// This repo is pinned to Svelte 4 / vite-plugin-svelte v3, whose plugins are named
// "vite-plugin-svelte" and "vite-plugin-svelte-inspector" — so the lookup fails and
// every .svelte file reports:
//
//   Error in vite.config
//   Error: No Svelte configuration found in vite config. Is @sveltejs/vite-plugin-svelte configured?
//
// ...while `npm run build` and `npm test` stay green, because they never go through
// that extraction path. load-config's documented fallback is a svelte.config.* in the
// SAME directory as the vite config, which is why this file lives in ui/ and not at
// the repo root (the root is never consulted — the walk-up stops at ui/).
//
// Delete this once the Svelte 5 / vite-plugin-svelte v5 migration lands.
//
// No preprocessors: no component uses lang="ts" or a CSS dialect, so there is nothing
// to declare. If one ever does, add `preprocess` here AND to ui/vite.config.js.
export default {};
