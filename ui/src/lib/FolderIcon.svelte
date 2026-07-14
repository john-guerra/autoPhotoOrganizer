<script>
  // "This group is a FOLDER on disk" — so it can be revealed, rescanned, renamed
  // and removed, and the right-click menu will offer all of it. Shown wherever a
  // group is rendered (feed header, tree row, fisheye), because a group's
  // dimension is otherwise invisible: a folder and a camera name look identical.
  //
  // `virtual` is not a cosmetic variant. A virtual ancestor (e.g. "Cards", which
  // holds only sub-folders and no photos of its own) is a real directory, but it
  // has NO row in the `folders` table — the index only knows folders that contain
  // photos. So it cannot be renamed or removed, and its select/keep-only act over
  // the subtree instead. Drawing it with the SAME icon would promise actions that
  // silently do nothing, so it gets an outline: same shape, hollow.
  export let virtual = false;
  /** rendered size in px — matches the surrounding text's cap height */
  export let size = 12;
</script>

<svg
  class="folder-icon"
  class:virtual
  width={size}
  height={size}
  viewBox="0 0 16 16"
  aria-hidden="true"
  focusable="false"
>
  <!-- A folder: tab on the left, body beneath. Filled when the folder is a real
       group; stroked-only when it is a virtual ancestor. -->
  <path
    d="M1.5 3.2a1 1 0 0 1 1-1h3.1a1 1 0 0 1 .7.3l1 1h6.2a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"
  />
</svg>

<style>
  .folder-icon {
    flex-shrink: 0;
    /* Sits with the text, not above it. */
    vertical-align: -1px;
  }
  .folder-icon path {
    fill: #7a8b9a;
    stroke: none;
  }
  /* Virtual ancestor: the same folder, hollow — it has no photos of its own, and
     nothing in the index to rename or remove. */
  .folder-icon.virtual path {
    fill: none;
    stroke: #6a7683;
    stroke-width: 1.3;
  }
</style>
