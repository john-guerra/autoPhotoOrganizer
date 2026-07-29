# Third-party notices

AutoGallery is MIT-licensed (see `LICENSE`). It redistributes the third-party
software listed here, whose licences require their notices be retained in
redistributions — and a packaged Electron build **is** a redistribution.

This file exists because a permissive licence is not the same as no
obligations. MIT asks only that its notice travel with the code; Apache-2.0
§4 additionally asks that the copyright notice, the licence text, and any
NOTICE file travel too. The first Apache-2.0 dependency arrived with the face
map (#232), so this file arrived with it.

Full licence texts ship inside each package's directory under
`node_modules/`, which electron-builder includes in the packaged app.

---

## umap-js — Apache License 2.0

Copyright 2019 Google LLC. All Rights Reserved.

Licensed under the Apache License, Version 2.0 (the "License"); you may not
use this file except in compliance with the License. You may obtain a copy of
the License at <http://www.apache.org/licenses/LICENSE-2.0>.

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
License for the specific language governing permissions and limitations under
the License.

Full text: `node_modules/umap-js/LICENSE`.

> **Note, because it is genuinely confusing:** `umap-js`'s `package.json`
> declares `"license": "MIT"`, but the shipped `LICENSE` file is the Apache
> License 2.0 and every source file carries the Apache-2.0 header above. The
> `LICENSE` file and the per-file headers control; the manifest field is
> upstream's error. Recorded here so a future audit that reads only the
> manifest does not "correct" this entry away.

### Its dependencies

`ml-levenberg-marquardt`, `ml-matrix`, `ml-array-rescale`, `ml-array-max`,
`ml-array-min` and `is-any-array` — all **MIT**, from the mljs project. Their
licence texts ship in their own package directories.

---

## Everything else

Every other production dependency is MIT, ISC, BSD-2-Clause or BSD-3-Clause,
none of which requires an entry beyond the licence text already shipping in
its package directory.

Regenerate the picture with:

```bash
npx license-checker --production --summary
```

**When adding a dependency, check its licence — not only its `package.json`
field.** Anything more restrictive than the list above (Apache-2.0, MPL,
LGPL, GPL) either belongs in this file or does not belong in the tree.
LGPL-3.0 is the reason `@saehrimnir/druidjs` was evaluated and rejected for
#232 despite being the better-featured library; see
`docs/experiments/2026-07-28-face-projection/README.md`.
