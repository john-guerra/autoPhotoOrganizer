/**
 * Grouping dimensions and feed-sort attributes, shared between App.svelte
 * (which validates persisted groupBy/sort and owns the state) and
 * OrganizeControls.svelte (which renders the pickers). Kept in one module so
 * the two can't drift — a sort key added here shows up in the dropdown and
 * passes App's persisted-value validation without a second edit.
 */

/** Every grouping level the multi-select offers, in menu order. */
export const ALL_DIMENSIONS = [
  "folder",
  "folderName",
  "year",
  "month",
  "day",
  "camera",
  "kind",
  "country",
  "region",
  "city",
];

/** Human labels for each grouping dimension, shown on the GroupByControl
 *  pills instead of the raw key (`folderName` -> "Folder name"). `city` still
 *  reads "Nearest town" — that label predates #175: the ORIGINAL geocoder
 *  really did return an unrelated small town for a city coordinate (Paris ->
 *  "Gif-sur-Yvette"), so the label said what it actually was. #175 replaced
 *  the geocoder and fixed that — "Nearest town" is now overly hedged, not
 *  wrong — but renaming it is a separate UI-text call the label's owner
 *  hasn't signed off on yet, so it stays as-is here; see #173. `region` is
 *  GeoNames admin1 — "State" in the US, "departamento" in Colombia, and so on
 *  (see server/lib/place.js's placeFor doc comment for why one label covers
 *  all of them). Every ALL_DIMENSIONS key must have an entry here (see
 *  dimensions.test.js). */
export const DIMENSION_LABELS = {
  folder: "Folder",
  folderName: "Folder name",
  year: "Year",
  month: "Month",
  day: "Day",
  camera: "Camera",
  kind: "Kind",
  country: "Country",
  region: "Region",
  city: "Nearest town",
};

/** Feed-sort attributes, in dropdown order. */
export const SORT_ATTRS = [
  "date_taken",
  "date_created",
  "date_modified",
  "rating",
  "size",
  "name",
];

/** The date-typed sort attributes (the ones the timeline can plot against).
 *  Sorting by one of these makes it the timeline's date; a non-date sort keeps
 *  the last date attr. Mirrors DATE_SORTS in server/db/sort.js. */
export const DATE_SORT_ATTRS = ["date_taken", "date_created", "date_modified"];

/** Human labels for each sort attribute. */
export const SORT_LABELS = {
  date_taken: "Taken",
  date_created: "Created",
  date_modified: "Modified",
  rating: "Rating",
  size: "Size",
  name: "Name",
};
