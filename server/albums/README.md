# albums/

Pure, framework-free module (no Express, no Svelte, no DOM) where the
time-gap album-clustering algorithm is ported from
`legacy/2024-electron-standalone/autoAlbums.js`: mean + standard deviation of
inter-photo intervals, custom separation overrides, and filename-date fallback.
Kept dependency-free so it is trivially unit-testable and reusable across
adapters.
