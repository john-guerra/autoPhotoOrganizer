<script>
  /**
   * The whole toolbar: two deliberate rows of labelled, bordered groups.
   *
   * It was ~150 lines of markup inside App.svelte, which is the file this project
   * keeps shipping layout bugs from. Pulling it out means the toolbar's structure
   * — which row, which group, what shrinks first — is readable in one screen,
   * instead of being buried in the middle of a 4,000-line component. App keeps the
   * state and the handlers; this owns nothing but the arrangement.
   *
   * The arrangement is the point. Every group answers exactly ONE question, and
   * says so on the tin — a toolbar of undifferentiated icons makes the user work
   * out for themselves which control is the reason they can only see 300 of their
   * 114,000 photos:
   *
   *   ROW 1 — what you HAVE, and what you're HIDING
   *     Library  the ＋ menu: add a folder, or manage the ones you have
   *     Filter   everything that takes photos away — search, stars, orientation,
   *              kind, and the timeline, which is a filter like the rest and the
   *              only one that can use the leftover width, so it gets all of it
   *
   *   ROW 2 — what to do with what's left
   *     Group    tree/fisheye + the grouping pills. Grouping is NOT a filter: it
   *              hides nothing, it decides how the survivors are carved up — the
   *              same question the sidebar switch answers, so they sit together,
   *              directly above the sidebar they drive.
   *     View     how you want to LOOK at what's left: full view / snapshot /
   *              collapsed, Locate, Auto Albums, thumbnail size, burst, and — at
   *              its far right, the last question you ask — sort
   *
   * The timeline arrives through a slot: it needs a dozen props (histogram,
   * sampled counts, view/focus markers) and every one is App's state. Threading
   * them through here would make this component about plumbing instead of layout.
   */
  import SourceControls from "./SourceControls.svelte";
  import FilterControls from "./FilterControls.svelte";
  import GroupByControl from "./GroupByControl.svelte";
  import SidebarModeToggle from "./SidebarModeToggle.svelte";
  import ViewControls from "./ViewControls.svelte";
  import GridControls from "./GridControls.svelte";
  import SortControl from "./SortControl.svelte";
  import ToolGroup from "./ToolGroup.svelte";
  import ToolbarRow from "./ToolbarRow.svelte";

  let {
    appVersion = "",

    // Library (the ＋ menu + the add-folder popover).
    scanning = false,
    hasNativePicker = false,
    alreadyIndexed = false,
    subdirs = [],
    subdirsLoading = false,
    subdirsError = "",
    subdirSelection = new Set(),
    addFolderOpen = $bindable(false),
    dir = $bindable(""),
    recursiveScan = $bindable(true),
    focusAfterAdd = $bindable(false),
    subdirsOpen = $bindable(false),

    // Filter.
    filter,
    filterMode = "display",

    // Group.
    groupBy = ["folder"],
    sidebarMode = $bindable("tree"),

    // View.
    cyclingAll = false,
    globalViewMode = "full",
    albumMode = $bindable(false),
    detectingAlbums = false,

    // Size / Sort.
    zoom = $bindable(2),
    zoomMax = 4,
    burstEnabled = $bindable(true),
    burstGapMs = $bindable(3000),
    sort,

    // Callbacks (App owns the handlers).
    onchoosefolder,
    onsubmit,
    onmanagelibrary,
    onreviewmissing,
    missingCount = 0,
    onloadsubdirs,
    ontoggledir,
    onselectalldirs,
    onselectnodirs,
    onfiltermodechange,
    onfilterchange,
    ongroupbychange,
    oncycleall,
    onrevealcurrent,
    ondetectalbums,
    onsortchange,
    onhelp,

    // Slots forwarded from App.
    timeline,
    manageLibrary,
  } = $props();
</script>

<header class="topbar">
  <!-- ROW 1. Filter is the only thing here that may fold: the ＋ menu is the one
       door into the library, and a door you have to open a dropdown to find is a
       door you can't find. -->
  <ToolbarRow variant="primary" order={["filter"]}>
    <h1>
      AutoGallery
      <span class="app-version" title="App version">v{appVersion}</span>
    </h1>

    <SourceControls
      {scanning}
      {hasNativePicker}
      {alreadyIndexed}
      {subdirs}
      {subdirsLoading}
      {subdirsError}
      {subdirSelection}
      bind:addFolderOpen
      bind:dir
      bind:recursiveScan
      bind:focusAfterAdd
      bind:subdirsOpen
      {onchoosefolder}
      {onsubmit}
      {onmanagelibrary}
      {onreviewmissing}
      {missingCount}
      {onloadsubdirs}
      {ontoggledir}
      {onselectalldirs}
      {onselectnodirs}
    />

    <FilterControls
      {filter}
      {filterMode}
      {onfiltermodechange}
      {onfilterchange}
      {timeline}
    />

    <button
      class="help-btn"
      title="Keyboard shortcuts (?)"
      aria-label="Keyboard shortcuts"
      onclick={() => onhelp?.()}
    >
      ?
    </button>
  </ToolbarRow>

  <!-- ROW 2. Group folds first: its pills grow with every dimension you add, so
       it is both the widest and the one you touch least often once you've chosen
       how to carve the library up. -->
  <ToolbarRow variant="secondary" order={["group", "view"]} watch={groupBy}>
    <ToolGroup id="group" label="Group">
      <!-- The switch used to be padded out to the sidebar's exact width so it sat
           directly above the column it drives. Inside a labelled, bordered group
           that alignment stopped paying for itself: it just left ~200px of empty
           box, and the border already says what the group is. -->
      <SidebarModeToggle bind:sidebarMode />
      <GroupByControl {groupBy} {ongroupbychange} />
    </ToolGroup>

    <!-- ONE group, not three. View, Size and Sort are all the same question asked
         three ways — how do I want to LOOK at what's left? — and giving each its
         own border and label just drew two more boxes without adding a thought.
         Sort keeps its place at the far right of the group, where the last
         question you ask belongs. -->
    <ToolGroup id="view" label="View" flavor="view">
      <ViewControls
        {cyclingAll}
        {globalViewMode}
        bind:albumMode
        {detectingAlbums}
        {oncycleall}
        {onrevealcurrent}
        {ondetectalbums}
      />
      <GridControls bind:zoom {zoomMax} bind:burstEnabled bind:burstGapMs />
      <div class="spacer"></div>
      <SortControl {sort} {onsortchange} />
    </ToolGroup>
  </ToolbarRow>

  {@render manageLibrary?.()}
</header>

<style>
  .topbar {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding: 0.35rem 1rem 0.45rem;
    border-bottom: 1px solid #2a2a2a;
    background: #141414;
    position: relative;
    z-index: 20;
    flex-shrink: 0;
  }
  h1 {
    margin: 0;
    font-size: 1.1rem;
    font-weight: 600;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .app-version {
    font-size: 0.7rem;
    color: #6a6a6a;
    font-weight: 400;
    margin-left: 4px;
  }
  /* Pushes Sort to the far right of the View group, where the last question you
     ask belongs. */
  .spacer {
    flex: 1;
  }
  .help-btn {
    flex-shrink: 0;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: #1a1a1a;
    border: 1px solid #2a2a2a;
    color: #9a9a9a;
    font: inherit;
    cursor: pointer;
  }
  .help-btn:hover {
    background: #2a2a2a;
    color: #e8e8e8;
  }
</style>
