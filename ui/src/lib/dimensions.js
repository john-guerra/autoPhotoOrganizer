/**
 * Grouping dimensions and feed-sort attributes, shared between App.svelte
 * (which validates persisted groupBy/sort and owns the state) and
 * OrganizeControls.svelte (which renders the pickers). Kept in one module so
 * the two can't drift — a sort key added here shows up in the dropdown and
 * passes App's persisted-value validation without a second edit.
 */

/** Every grouping level the multi-select offers, in menu order. */
export const ALL_DIMENSIONS = ["folder", "year", "month", "day", "camera", "kind"];

/** Feed-sort attributes, in dropdown order. */
export const SORT_ATTRS = [
  "date_taken",
  "date_created",
  "date_modified",
  "rating",
  "size",
  "name",
];

/** Human labels for each sort attribute. */
export const SORT_LABELS = {
  date_taken: "Taken",
  date_created: "Created",
  date_modified: "Modified",
  rating: "Rating",
  size: "Size",
  name: "Name",
};
