<script>
  /**
   * THE JUSTIFIED GRID — the app's home view, and the view registry's first
   * client (#155).
   *
   * Lifted out of App.svelte with its markup and its CSS unchanged, including
   * the `#feed-grid` id every e2e spec selects on. That was the acceptance bar:
   * a spec needing an edit would have meant the extraction changed behaviour.
   *
   * WHAT THIS COMPONENT IS NOT ALLOWED TO DO. It never touches `items`, never
   * fetches, and never runs a feed-window transaction. App owns the data; this
   * draws it and reports pointer events back. Six hand-copied copies of the
   * `fetchingBefore`/`fetchingAfter`/`feedEpoch` guard caused #35, #36 and #39,
   * and a seventh living inside a view would be the same bug with a new name.
   * See `docs/UI-CONTRACTS.md` §3 for the full boundary.
   *
   * ON THE SIZE OF THIS PROP LIST. It is large, and that is a measurement
   * rather than a smell: it is exactly how entangled the grid already was with
   * App's state, previously spread across 250 lines of inline markup where
   * nothing counted it. Narrowing it (pushing the label corpus down into a pure
   * module, bundling geometry into one object) is worth doing — but as its own
   * change, where a reviewer can see it. Doing it here would have mixed a
   * behaviour-preserving extraction with a redesign and made both unreviewable.
   */
  import { scale } from "svelte/transition";
  import Thumb from "../Thumb.svelte";
  import FolderIcon from "../FolderIcon.svelte";
  import GroupStateIcon from "../GroupStateIcon.svelte";
  import GroupLabelActions from "../GroupLabelActions.svelte";
  import { getRenderer, DEFAULT_RENDERER_ID } from "../groupRenderers.js";
  import { pathKey } from "../feed.js";
  import { entryDomId, resolvePhoto } from "../displayEntries.js";

  let {
    // --- Layout, computed by App from `items` + the measured width -----------
    /** The justified layout result: `{ headers }` plus the geometry below. */
    layoutResult,
    /** Per-entry rects, index-aligned with the display entries. Null until the
     *  first measure — the markup guards on it. */
    boxes,
    gridHeight = 0,
    /** The windowed slice App decided to render: `[{ i, entry }]`. */
    visibleItems = [],

    // --- Two-way: App measures and scrolls through these ---------------------
    /** App needs the node for scroll math and reveal offsets. */
    gridEl = $bindable(null),
    /** The measured content width — the input to the layout App computes. */
    gridWidth = $bindable(0),
    /** The in-place folder rename draft. */
    renameDraft = $bindable(""),

    // --- Group fold state (App owns it; it persists) -------------------------
    collapsedKeys,
    snapshotGroupKeys,
    aggregateKeys,
    aggregateSnapshotKeys,
    headerCounts = {},
    renamingKey = null,
    /** The group whose Remove is armed and waiting for a second click. */
    removeArmedKey = null,

    // --- The label corpus. Passed in because it is derived from `library`,
    //     which App owns and the tree sidebar shares. Named at the call sites
    //     below so Svelte re-runs the each-block when the corpus arrives —
    //     see the note on `headerParts` in App.svelte.
    tokenStats,
    libraryRoots,

    // --- Feed context the group renderers need to fetch their own samples ----
    displayFilter,
    sort,
    groupBy,

    // --- Selection and focus (App owns both; this only displays them) -------
    /** The focused index into the display entries. */
    selected = 0,
    selectedIds,
    groupIdCacheVersion = 0,
    groupSelSig = "",

    // --- Stacks and thumbnail state -----------------------------------------
    stacks = [],
    thumbStatus,
    thumbSize,
    snapshotThumbSize,
    gridGap = 0,

    // --- Geometry constants, shared with the layout so they cannot drift ----
    PAD,
    GROUP_INDENT,
    HEADER_HEIGHT,
    Z_HEADER_BASE,
    /** 0 unless a fold is actually landing — the feed is virtualized, so an
     *  unguarded intro replays every time a band scrolls back into view. */
    foldMs = 0,

    // --- Pure reads that live in App because their inputs do -----------------
    rendererIdFor,
    groupToggleTitle,
    isFolderDim,
    headerParts,
    groupSelectState,
    stackMarginPx,

    // --- Callbacks. The view reports; App decides. ---------------------------
    onheadermenu,
    ongrouptoggle,
    onstartrename,
    oncommitrename,
    oncancelrename,
    ontoggleselectgroup,
    onkeeponlygroup,
    onjumpfromgroup,
    onremovegroup,
    onopenphoto,
    ontileclick,
    ontoggleselect,
    ontilecontextmenu,
    onthumbattempt,
    onthumbsettled,
  } = $props();

  /** Svelte action: fade the clipped edge only when something IS hidden behind
   * it. The header shows the END of the path (see .section-label), so what
   * overflows is on the left — and CSS can't measure that, hence the class.
   * `_parts` is here so the call site names it and the action re-measures when
   * the label changes. */
  function tailClip(el, _parts) {
    const mark = () =>
      el.parentElement?.classList.toggle(
        "clipped",
        el.scrollWidth > el.parentElement.clientWidth
      );
    mark();
    return { update: mark };
  }
</script>

<div
  class="grid"
  id="feed-grid"
  bind:this={gridEl}
  bind:clientWidth={gridWidth}
  style={boxes ? `height:${gridHeight}px;` : ""}
  role="listbox"
  tabindex="-1"
>
  {#if boxes}
    <!-- Headers render unconditionally for the whole loaded window, unlike
         photos — there are only dozens/hundreds of them (vs. tens of
         thousands of photos), so they don't need windowing, and a header
         whose triggering index falls outside the virtualized photo range
         must still survive (it may be sticky-stuck mid-section while the
         viewer has scrolled well past its origin index). -->
    {#each layoutResult.headers as header (header.dimension + header.value + header.index)}
      <div
        class="section-wrapper"
        class:nested={header.depth > 0}
        data-group-key={header.path ? pathKey(header.path) : undefined}
        style="--depth:{header.depth}; --ind:{GROUP_INDENT}px; top:{header.y}px; height:{header.endY -
          header.y}px;"
      >
        <!-- Right-click opens the group menu; the header's own buttons
             already carry every action for keyboard/pointer, so this is a
             supplementary affordance (same as the tree row). -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="section-header"
          style="top:{header.depth * HEADER_HEIGHT}px; z-index:{Z_HEADER_BASE -
            header.depth};"
          oncontextmenu={(e) => onheadermenu?.(e, header)}
        >
          <button
            class="section-toggle-icon"
            class:not-grid={rendererIdFor(
              header.path,
              collapsedKeys,
              snapshotGroupKeys,
              aggregateKeys,
              aggregateSnapshotKeys
            ) !== DEFAULT_RENDERER_ID}
            title={groupToggleTitle(
              rendererIdFor(
                header.path,
                collapsedKeys,
                snapshotGroupKeys,
                aggregateKeys,
                aggregateSnapshotKeys
              ),
              (header.groupPaths?.length ?? 0) > 1
            )}
            aria-label={(header.groupPaths?.length ?? 0) > 1
              ? "Cycle this folder's whole subtree: full grid → aggregate snapshot → aggregate collapsed (Shift-click to fold each group beneath it instead)"
              : "Cycle this group: full grid → snapshot strip → collapsed"}
            onclick={(e) => ongrouptoggle?.(header.path, e, header.groupPaths)}
          >
            <GroupStateIcon
              state={getRenderer(
                rendererIdFor(
                  header.path,
                  collapsedKeys,
                  snapshotGroupKeys,
                  aggregateKeys,
                  aggregateSnapshotKeys
                )
              ).icon}
            />
          </button>
          <!-- OUTSIDE .section-label, which is `direction: rtl` so it can
               clip the HEAD of a long path — that flips the visual order
               of its inline children, and an icon placed inside it lands
               to the RIGHT of the name. Says "this group is a real folder"
               (so reveal / rescan / rename / remove all apply); hollow
               means a virtual ancestor, which has no row in the index and
               therefore cannot be renamed or removed. -->
          {#if isFolderDim(header)}
            <FolderIcon virtual={header.isVirtual} />
          {/if}
          {#if header.path && renamingKey === pathKey(header.path)}
            <!-- svelte-ignore a11y_autofocus -->
            <input
              class="section-rename"
              bind:value={renameDraft}
              onclick={(e) => e.stopPropagation()}
              onkeydown={(e) => {
                if (e.key === "Enter") oncommitrename?.(header.path);
                else if (e.key === "Escape") oncancelrename?.();
              }}
              onblur={() => oncommitrename?.(header.path)}
              autofocus
            />
          {:else}
            <button
              class="section-label"
              title={`${header.value ?? header.label}${
                header.path?.at(-1)?.dimension === "folder" && !header.isVirtual
                  ? " — double-click to rename this folder on disk"
                  : ""
              }`}
              ondblclick={() =>
                !header.isVirtual && onstartrename?.(header.path)}
            >
              <span
                class="section-label-text"
                use:tailClip={headerParts(header, tokenStats, libraryRoots)}
                >{#each headerParts(header, tokenStats, libraryRoots) as part}<span
                    class="part-{part.kind}">{part.text}</span
                  >{/each}</span
              >
            </button>
          {/if}
          <!-- A virtual ancestor has no `folders` row, so no query can
               count it — its number comes from the trie's roll-up, the
               same one the sidebar shows. -->
          {#if header.count ?? headerCounts[pathKey(header.path)]}
            <span class="section-count">
              {(
                header.count ?? headerCounts[pathKey(header.path)]
              ).toLocaleString()} items
            </span>
          {/if}
          {#if header.path}
            <GroupLabelActions
              selectState={groupSelectState(
                header.path,
                header.groupPaths,
                selectedIds,
                groupIdCacheVersion,
                groupSelSig
              )}
              canRemove={true}
              removeArmed={removeArmedKey === pathKey(header.path)}
              ontoggleselect={(e) =>
                ontoggleselectgroup?.(header.path, header.groupPaths, e)}
              onkeeponly={() =>
                onkeeponlygroup?.(header.path, header.groupPaths)}
              onjumpprev={() => onjumpfromgroup?.(header.path, "prev")}
              onjumpnext={() => onjumpfromgroup?.(header.path, "next")}
              onremove={() => onremovegroup?.(header.path, header.groupPaths)}
            />
          {/if}
        </div>
      </div>
    {/each}
    {#each visibleItems as { i, entry } (entryDomId(entry))}
      {#if entry.kind === "placeholder"}
        <!-- The group's own section header (above) owns the label, icon,
             count and actions. This band is ONLY the renderer's photo
             widget, drawn inside the layout's content rect — which is why
             it inherits the group's nesting indent. A renderer with no
             component (e.g. "collapsed") reserves no band at all: the
             header alone represents the group. See
             docs/superpowers/specs/2026-07-12-group-photo-renderers.md -->
        {@const renderer = getRenderer(
          rendererIdFor(
            entry.item.path,
            collapsedKeys,
            snapshotGroupKeys,
            aggregateKeys,
            aggregateSnapshotKeys
          )
        )}
        {#if renderer.component && boxes[i].height > 0}
          {@const Renderer = renderer.component}
          <!-- + PAD on BOTH axes, exactly as Thumb does (`box.x + pad`).
               Absolutely-positioned children ignore the grid's CSS
               padding, so every box has to add the frame inset itself —
               and the band wasn't. That put every snapshot strip 12px
               left of, and 12px above, where the same group's photos sit
               in full view, so a group visibly JUMPED as you toggled it. -->
          <!-- The strip UNFURLS in place: it opens from the exact spot,
               and at the exact photo size, that the group's first row of
               photos occupied, while the photos below it glide up. `foldMs`
               is 0 unless a fold is actually landing — the feed is
               virtualized, so without that guard every scroll past a
               snapshot group would re-mount the band and replay the
               animation (and prefers-reduced-motion zeroes it too).

               |global is load-bearing: a bare `in:` is LOCAL, and a local
               transition is suppressed when an ancestor block is created in
               the same update — which is exactly what a feed refresh does,
               so the animation silently never ran at all. -->
          <div
            class="group-band"
            data-group-key={pathKey(entry.item.path)}
            in:scale|global={{
              duration: foldMs,
              start: 0.92,
              opacity: 0,
            }}
            style="top:{boxes[i].y + PAD}px; left:{boxes[i].x +
              PAD}px; width:{boxes[i].width}px; height:{boxes[i].height}px;"
          >
            <Renderer
              groupPath={entry.item.path}
              count={entry.item.count}
              filter={displayFilter}
              {sort}
              {groupBy}
              thumbPx={boxes[i].height}
              gapPx={gridGap}
              size={snapshotThumbSize}
              onselect={(d) => onopenphoto?.(d.id, entry.item.path)}
            />
          </div>
        {/if}
      {:else}
        <Thumb
          item={resolvePhoto(entry)}
          box={boxes[i]}
          pad={PAD}
          size={thumbSize}
          warm={thumbStatus.get(resolvePhoto(entry).id) === "ok"}
          selected={i === selected}
          inSelection={selectedIds.has(resolvePhoto(entry).id)}
          showSize={sort.by === "size"}
          stackCount={entry.kind === "stack" ? entry.stack.count : undefined}
          stackPeekItems={entry.kind === "stack" ? entry.peekItems : []}
          stackMarginPx={stackMarginPx(entry)}
          inExpandedStack={entry.kind === "photo" && entry.stackId !== null}
          isCurrentCover={entry.kind === "photo" &&
            entry.stackId !== null &&
            stacks.find((s) => s.id === entry.stackId)?.coverId ===
              entry.item.id}
          onclick={(e) => ontileclick?.(e, entry, i)}
          ontoggleselect={() => ontoggleselect?.(resolvePhoto(entry)?.id)}
          oncontextmenu={(e) => ontilecontextmenu?.(e, entry, i)}
          onattempt={onthumbattempt}
          onsettled={onthumbsettled}
        />
      {/if}
    {/each}
  {/if}
</div>

<style>
  .grid {
    /* Justified layout: children are absolutely positioned by computed boxes;
       height is set inline from the layout result. */
    position: relative;
    width: 100%;
    /* Its own stacking context. Without this the grid is `position:relative;
       z-index:auto`, which is NOT one — so the headers (z 15), the dendrogram
       trunk (16) and the thumbnails (10) all resolved against .topbar's z 20 in
       the shared root context. That capped the header scale at 20 (folder
       nesting can go deeper than that) and, separately, meant a thumbnail was
       only ever one z-index bump away from painting over the toolbar. Isolating
       frees the internal scale and closes that hazard; the topbar and the loupe
       both live OUTSIDE .grid, so nothing that must sit above it is affected. */
    isolation: isolate;
  }
  .grid:focus {
    outline: none;
  }
  /* Nesting is drawn as a dendrogram: each level is indented, a dotted trunk runs
     down the sub-group's spine, and a dotted elbow joins each child header to it
     — so a sub-group visibly belongs to the group above instead of floating as
     just another header. `--depth` is set on the wrapper; custom properties
     inherit, so the header reads it from there. */
  /* The renderer's band: just a positioned rect. The group's label/icon/actions
     live in its section header above — a renderer never draws chrome. */
  .group-band {
    position: absolute;
    box-sizing: border-box;
    overflow: hidden;
    /* The strip unrolls from its left edge — which, since the band now starts at
       exactly the same x as the group's first photo in full view, means it appears
       to grow out of that photo rather than swelling out of thin air. */
    transform-origin: 0 50%;
  }

  /* NOTE the transition that ISN'T here: `.thumb-wrap` already carries a
     permanent top/left/width/height transition of its own (Thumb.svelte), so the
     photos below a folding group have always glided to their new places. The
     piece that was missing is the strip itself — see the `in:scale` on the band,
     and `folding` in the script, which is what keeps a virtualized re-mount from
     replaying that unfurl every time you scroll past. */

  .section-wrapper {
    /* --ind is set inline from GROUP_INDENT (the same constant the LAYOUT uses to
       inset a nested group's photos) so the dendrogram and the photos can never
       drift apart. The fallback only matters if the attr is ever dropped. */
    --ind: 18px;
    --trunk: calc(15px + (var(--depth, 0) - 1) * var(--ind));
    position: absolute;
    left: 0;
    width: 100%;
    pointer-events: none;
  }
  /* Vertical trunk spanning this sub-group's whole extent — consecutive siblings
     stack their segments into one continuous line. */
  .section-wrapper.nested::before {
    content: "";
    position: absolute;
    left: var(--trunk);
    top: 0;
    bottom: 0;
    /* Must beat EVERY section header: they are sticky with an OPAQUE background,
       so at 'auto' the trunk was painted over wherever a header sat and the
       elbows looked like floating stubs. Headers run Z_HEADER_BASE - depth, so
       one above the base clears all of them at any nesting depth. It runs up the
       header's left padding gutter, which the per-depth padding reserves. */
    z-index: 1001;
    border-left: 1px dotted #6a6a6a;
    pointer-events: none;
  }
  .section-header {
    position: sticky;
    z-index: 15;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px 4px calc(8px + var(--depth, 0) * var(--ind));
    background: #141414;
    pointer-events: auto;
  }
  /* The elbow from the trunk into this header. */
  .section-wrapper.nested > .section-header::before {
    content: "";
    position: absolute;
    left: var(--trunk);
    width: calc(var(--ind) - 4px);
    top: 50%;
    z-index: 1001;
    border-top: 1px dotted #6a6a6a;
    pointer-events: none;
  }
  /* Same tri-state icon (and same colour language) as the tree sidebar's
     feed-visibility control, so one group state always reads the same way:
     grid = full, strip = snapshot, bar = collapsed (amber once it's not full). */
  .section-toggle-icon {
    background: none;
    border: none;
    color: #8a8a8a;
    font: inherit;
    cursor: pointer;
    padding: 2px 4px;
    border-radius: 4px;
    display: inline-flex;
    align-items: center;
  }
  .section-toggle-icon:hover {
    color: #e8e8e8;
  }
  /* Amber whenever the group isn't showing its photos in full. One modifier —
     NEVER interpolate a renderer id into the class list: "grid" collides with
     the photo-grid container's own .grid rule. */
  .section-toggle-icon.not-grid {
    color: #ffd24c;
  }
  .section-toggle-icon:hover {
    background: #2a2a2a;
  }
  .section-label {
    background: none;
    border: none;
    color: inherit;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 4px;
    text-align: left;
    /* A long group name used to WRAP, growing the sticky header band and letting
       it cover the rows beneath it. Keep it to one line; the full value is on the
       button's title attribute (see the markup).

       Clip the HEAD, not the tail — same rule as the tree rows. A folder path
       ends with the folder's own name, so a normal ellipsis drops exactly the
       part that identifies the group: two sibling folders under one long parent
       both render as ".../2025_11Nov_08 Canon 1/2…" and become indistinguishable.
       direction:rtl on the clipper flips which end overflows; the inner span
       stays ltr, so the text itself is unchanged. */
    direction: rtl;
    white-space: nowrap;
    overflow: hidden;
    min-width: 0;
    max-width: 78ch;
  }
  /* Only fade the left edge when there IS something clipped behind it. */
  .section-label.clipped {
    -webkit-mask-image: linear-gradient(to right, transparent 0, #000 16px);
    mask-image: linear-gradient(to right, transparent 0, #000 16px);
  }
  .section-label-text {
    display: inline-block;
    direction: ltr;
    white-space: nowrap;
  }
  .section-header {
    min-width: 0;
  }
  /* Layering: the folder's own name is what identifies the section, so it gets
     the emphasis; the path above it is context and recedes. Nothing the eye needs
     is deleted — it just stops competing for attention. */
  .section-label .part-keep {
    color: inherit;
  }
  .section-label .part-dim,
  .section-label .part-ellipsis {
    color: #8a8a8a;
    font-weight: 400;
  }
  .section-label:hover {
    background: #2a2a2a;
  }
  .section-rename {
    font: inherit;
    font-weight: 600;
    color: #fff;
    background: #0d0d0d;
    border: 1px solid #4c9aff;
    border-radius: 4px;
    padding: 2px 6px;
    min-width: 12ch;
  }
  .section-rename:focus {
    outline: none;
  }
  .section-count {
    color: #888;
    font-size: 0.85em;
    font-weight: 400;
    /* Matches the collapsed-section placeholder's own count (.placeholder-count)
       so a section reads the same expanded or collapsed. */
  }
  /* The group actions (jump / Keep only / Remove) live in GroupLabelActions
     (issue #88); its select icon is always visible, but its action buttons
     (.gla-buttons) reveal only on hover of the header row. The reveal target
     crosses the component boundary, so it's a :global rule. There is now ONE
     header per group (see the group-renderers contract), so this is one rule —
     it used to be repeated for the snapshot head and the collapsed pill. */
  .section-header:hover :global(.gla-buttons),
  .section-header:focus-within :global(.gla-buttons) {
    opacity: 1;
  }
</style>
