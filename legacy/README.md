# Legacy apps

This folder archives two prior generations of **autoPhotoOrganizer**. The code is kept for reference only: it is not maintained, and its dependencies are outdated.

> ⚠️ **Do not run this code.** It contains known insecure patterns flagged by security review: a path-traversal vulnerability in `2016-express-web/server.js` (`/images/:id` serves unvalidated paths) and an insecure Electron configuration in `2024-electron-standalone/main.js` (`nodeIntegration: true`, no context isolation). It exists only as reference for porting the album-clustering algorithm to v2.

## `2016-express-web/`

The original prototype: an Express server (`server.js`) serving a d3 v3 browser timeline (`static/`). It reads EXIF dates from a photo folder (paths are hardcoded) and visualizes the photo dates on a timeline. `dates.csv` is sample extracted date data.

## `2024-electron-standalone/`

An Electron 11 desktop app (plus a leftover nw.js configuration in `package_nw.json` from an earlier nw.js incarnation).

The important file is **`autoAlbums.js`**: it implements time-gap clustering of photos into albums. It computes the mean and standard deviation of inter-photo time intervals and splits albums where the gap exceeds a threshold derived from them, supports custom separation overrides, and falls back to parsing dates from filenames when EXIF data is missing.

This algorithm will be ported into the v2 app.
