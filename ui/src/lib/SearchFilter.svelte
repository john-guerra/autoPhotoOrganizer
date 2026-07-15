<script>
  /**
   * Free-text search over the file name and the folder path it lives in.
   *
   * It is a FILTER FACET, not a separate mode: it narrows the same working set as
   * the stars, the kinds and the timeline, so search + "3 stars and up" + "videos"
   * compose, the counts agree, and Select mode adds the matches to the selection
   * instead of hiding everything else. That is also why it doesn't search EXIF —
   * name and folder are the only text the index holds for EVERY photo (camera and
   * lens come from EXIF, which most of the library has never had read).
   *
   * Typing is debounced: every keystroke would otherwise re-query the feed, the
   * counts and the tree for a 114k library.
   */
  import { untrack } from "svelte";

  let { filter, onchange } = $props();

  const DEBOUNCE_MS = 200;

  let value = $state(untrack(() => filter?.text ?? ""));
  let timer = null;
  let inputEl;

  // Follow the spec when it is changed from OUTSIDE (Clear filters, a reset) —
  // but never fight the user mid-keystroke.
  $effect(() => {
    const text = filter?.text ?? "";
    if (text !== value && document.activeElement !== inputEl) {
      value = text;
    }
  });

  function emit(text) {
    onchange?.({ ...filter, text });
  }

  function onInput() {
    clearTimeout(timer);
    timer = setTimeout(() => emit(value), DEBOUNCE_MS);
  }

  function onKeydown(e) {
    // Enter searches NOW (no wait), Escape clears — both are what a search box
    // is expected to do, and Escape must not bubble out and close the loupe.
    if (e.key === "Enter") {
      clearTimeout(timer);
      emit(value);
    } else if (e.key === "Escape") {
      e.stopPropagation();
      clear();
    }
  }

  function clear() {
    clearTimeout(timer);
    value = "";
    emit("");
  }

  $effect(() => () => clearTimeout(timer));
</script>

<div class="search" class:active={value !== ""}>
  <svg class="icon" viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" />
    <line
      x1="10.5"
      y1="10.5"
      x2="14"
      y2="14"
      stroke="currentColor"
      stroke-linecap="round"
    />
  </svg>
  <input
    class="search-input"
    type="search"
    placeholder="Search name or folder…"
    title="Search photos by file name or the folder they're in (Enter to search now, Esc to clear)"
    aria-label="Search by file name or folder"
    bind:value
    bind:this={inputEl}
    oninput={onInput}
    onkeydown={onKeydown}
    spellcheck="false"
  />
  {#if value}
    <button
      class="clear"
      title="Clear the search"
      aria-label="Clear the search"
      onclick={clear}>×</button
    >
  {/if}
</div>

<style>
  .search {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0 6px;
    height: 26px;
    border: 1px solid #3a3a3a;
    border-radius: 13px;
    background: #1b1b1b;
    color: #8a8f98;
  }
  .search.active {
    border-color: #4c9aff;
    color: #4c9aff;
  }
  .icon {
    width: 12px;
    height: 12px;
    flex: none;
  }
  /* 150px preferred, but it may shrink: after the timeline, the search box is the
     next thing in the toolbar that loses width without losing meaning (you can
     still read the tail of what you typed). The group-by pills never shrink. */
  .search-input {
    width: 150px;
    min-width: 70px;
    flex-shrink: 1;
    border: 0;
    outline: none;
    background: transparent;
    color: #e6e6e6;
    font-size: 12px;
  }
  /* The type=search cancel button is inconsistent across platforms and doesn't
     match the rest of the toolbar — we draw our own. */
  .search-input::-webkit-search-cancel-button {
    display: none;
  }
  .clear {
    border: 0;
    background: transparent;
    color: #8a8f98;
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
    padding: 0 2px;
  }
  .clear:hover {
    color: #e6e6e6;
  }
</style>
