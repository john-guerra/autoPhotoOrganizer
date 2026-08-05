<script>
  import { faceCropUrl } from "../faceCropUrl.js";
  /**
   * PEOPLE — browsing and naming the people the face pass found (#223).
   *
   * It used to be a scrolling list of text inputs inside gear → Machine
   * learning. That was wrong twice over: a settings panel is for settings, and
   * naming people from a list of "Unnamed · 34 faces" placeholders is guessing.
   * You need to SEE the face. This draws the crop (`/api/ml/faces/:id/crop`,
   * new in #223 — the box had been stored since #166 with nothing able to turn
   * it into pixels) and puts naming, merging and "show me their photos" on the
   * tile itself.
   *
   * A registry view (`views/registry.js`), so it obeys the same boundary the
   * grid does: it never touches `items`, never runs a feed transaction, and
   * gets its whole-library data through App's bounded `working-set` fetch.
   * Clicking a person asks App to apply the EXISTING `personId` filter — the
   * one that already ships through all three facet layers — rather than
   * inventing a second way to narrow the feed.
   *
   * Capabilities: this view declares `open/select/rate: false`. It shows you
   * PEOPLE, not photos; there is no photo here to rate, and `selected` indexes
   * a feed window this view isn't rendering. Declaring it is what lets App
   * answer those keystrokes instead of silently acting on something off-screen.
   */
  let {
    /** `[{ id, name, coverFaceId, faces, photos }]`, largest first. */
    people = [],
    /** True while App's working-set fetch is in flight. */
    loading = false,
    /** How many people exist in total, vs. the page we were handed. */
    total = 0,
    truncated = false,
    /** Ask App for a bigger page. */
    onmore,
    /** The person the feed is currently filtered to, if any. */
    activePersonId = null,
    /** Ask App to narrow the feed to this person (null clears). */
    onpick,
    /** `(id, name) => Promise` */
    onrename,
    /** `(intoId, fromId) => Promise` */
    onmerge,
    /** Anything the user should be told. */
    onnotice,
  } = $props();

  /** Which tile's name is being edited. Only one at a time — an inline editor
   *  per tile that is always live turns a keyboard-first app into a minefield
   *  of text fields that swallow every digit. */
  let editing = $state(null);
  let draft = $state("");
  /** The person a merge is being chosen FOR (the target). */
  let merging = $state(null);
  let busy = $state(false);

  const n = (v) => (v ?? 0).toLocaleString();

  /** Initials for a person with no crop — a named person whose cover face was
   *  detached, or a photo that has since left the library. Better than a
   *  broken <img>, and it still identifies them. */
  function initials(p) {
    const name = (p.name ?? "").trim();
    if (!name) return "?";
    return name
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("");
  }

  function startEdit(p) {
    editing = p.id;
    draft = p.name ?? "";
  }

  async function commitEdit(p) {
    const name = draft.trim();
    editing = null;
    if (name === (p.name ?? "")) return;
    busy = true;
    try {
      await onrename?.(p.id, name);
    } finally {
      busy = false;
    }
  }

  async function doMerge(intoId, fromId) {
    merging = null;
    if (!fromId || fromId === intoId) return;
    busy = true;
    try {
      await onmerge?.(intoId, fromId);
    } finally {
      busy = false;
    }
  }

  /** Enter/Space on a tile is the same as clicking it — the tile is the
   *  primary action (show me this person's photos), so it must be reachable
   *  without a mouse. */
  function onTileKey(e, p) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onpick?.(activePersonId === p.id ? null : p.id);
    }
  }
</script>

<div class="people-view" data-testid="people-view">
  <header class="bar">
    <h2>People</h2>
    <span class="count">
      {#if loading}
        Loading…
      {:else if truncated}
        <!-- SAY what is not shown. A real library has tens of thousands of
             persons, most of them a stranger in the background of one photo,
             so this list is capped and largest-first — but a view that
             silently pretends the library has 200 people in it is lying. -->
        {n(people.length)} of {n(total)} people · biggest first
      {:else}
        {n(people.length)}
        {people.length === 1 ? "person" : "people"}
      {/if}
    </span>
    {#if activePersonId}
      <!-- The filter this view applied is App's, and it OUTLIVES this view —
           so the way to undo it has to be here, visible, rather than something
           the user has to go find in the toolbar. -->
      <button class="clear" onclick={() => onpick?.(null)}>
        ✕ Show everyone again
      </button>
    {/if}
  </header>

  {#if !loading && !people.length}
    <div class="empty">
      <p class="empty-title">Nobody has been grouped yet.</p>
      <p class="empty-hint">
        Open <strong>gear → Machine learning</strong>, find faces, then group
        them into people. They will appear here to name.
      </p>
    </div>
  {:else}
    <ul class="grid" data-testid="people-grid">
      {#each people as p (p.id)}
        <li class="person" class:active={activePersonId === p.id}>
          <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
          <div
            class="face"
            role="button"
            tabindex="0"
            aria-pressed={activePersonId === p.id}
            aria-label={`Show photos of ${p.name || "this person"} (${p.photos} photos)`}
            title={`Show ${p.name || "this person"}'s photos`}
            onclick={() => onpick?.(activePersonId === p.id ? null : p.id)}
            onkeydown={(e) => onTileKey(e, p)}
          >
            {#if p.coverFaceId}
              <!-- `loading="lazy"`: a library with 300 people is 300 crops,
                   each a full decode server-side on first request. -->
              <img
                src={faceCropUrl(p.coverFaceId)}
                alt=""
                loading="lazy"
                onerror={(e) => (e.currentTarget.style.display = "none")}
              />
            {:else}
              <span class="initials" aria-hidden="true">{initials(p)}</span>
            {/if}
          </div>

          {#if editing === p.id}
            <!-- svelte-ignore a11y_autofocus -->
            <input
              class="name-edit"
              bind:value={draft}
              autofocus
              aria-label="Name this person"
              onkeydown={(e) => {
                if (e.key === "Enter") commitEdit(p);
                else if (e.key === "Escape") editing = null;
              }}
              onblur={() => commitEdit(p)}
            />
          {:else}
            <button
              class="name"
              class:unnamed={!p.name}
              disabled={busy}
              onclick={() => startEdit(p)}
              title="Click to name this person"
            >
              {p.name || "Add a name"}
            </button>
          {/if}

          <span class="meta">
            {n(p.faces)} face{p.faces === 1 ? "" : "s"} · {n(p.photos)} photo{p.photos ===
            1
              ? ""
              : "s"}
          </span>

          {#if merging === p.id}
            <!-- Merging is the correction #167 requires and it must be
                 durable: the server marks every moved face as a human's
                 decision so the next grouping pass keeps it. -->
            <select
              class="merge"
              aria-label={`Merge someone into ${p.name || "this person"}`}
              onchange={(e) => doMerge(p.id, Number(e.currentTarget.value))}
              onblur={() => (merging = null)}
            >
              <option value="">Merge who into this person?</option>
              {#each people.filter((o) => o.id !== p.id) as o (o.id)}
                <option value={o.id}>
                  {o.name || `Unnamed · ${o.faces} faces`}
                </option>
              {/each}
            </select>
          {:else}
            <button
              class="merge-open"
              disabled={busy || people.length < 2}
              onclick={() => (merging = p.id)}
            >
              Merge…
            </button>
          {/if}
        </li>
      {/each}
    </ul>
    {#if truncated}
      <div class="more">
        <button onclick={() => onmore?.()} disabled={loading}>
          {loading
            ? "Loading…"
            : `Show more (${n(total - people.length)} to go)`}
        </button>
        <p class="more-hint">
          Most of the rest are people seen in a single photo — a passer-by in
          the background. They are still here, just last.
        </p>
      </div>
    {/if}
  {/if}
</div>

<style>
  .people-view {
    padding: 12px;
  }
  .bar {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    position: sticky;
    top: 0;
    background: #141414;
    padding: 6px 0 10px;
    z-index: 2;
  }
  .bar h2 {
    margin: 0;
    font-size: 1rem;
  }
  .count {
    color: #888;
    font-size: 0.85rem;
  }
  .clear {
    margin-left: auto;
    background: #2e8b57;
    border: none;
    color: #06121f;
    font: inherit;
    font-weight: 600;
    padding: 3px 10px;
    border-radius: 4px;
    cursor: pointer;
  }
  .grid {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 14px;
  }
  .person {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 8px;
    border: 1px solid transparent;
    border-radius: 6px;
  }
  .person.active {
    border-color: #2e8b57;
    background: #14251c;
  }
  .face {
    width: 120px;
    height: 120px;
    border-radius: 50%;
    overflow: hidden;
    background: #232323;
    display: grid;
    place-items: center;
    cursor: pointer;
    border: 2px solid #333;
  }
  .face:hover,
  .face:focus-visible {
    border-color: #4c9aff;
    outline: none;
  }
  .person.active .face {
    border-color: #2e8b57;
  }
  .face img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .initials {
    font-size: 2rem;
    font-weight: 600;
    color: #777;
  }
  .name,
  .name-edit {
    font: inherit;
    font-weight: 600;
    max-width: 100%;
    text-align: center;
  }
  .name {
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .name:hover {
    background: #2a2a2a;
  }
  .name.unnamed {
    color: #8a8a8a;
    font-weight: 400;
  }
  .name-edit {
    color: #fff;
    background: #0d0d0d;
    border: 1px solid #4c9aff;
    border-radius: 4px;
    padding: 2px 6px;
    width: 130px;
  }
  .name-edit:focus {
    outline: none;
  }
  .meta {
    color: #888;
    font-size: 0.78rem;
    font-variant-numeric: tabular-nums;
  }
  .merge-open,
  .merge {
    font: inherit;
    font-size: 0.78rem;
    background: none;
    border: 1px solid #333;
    color: #9a9a9a;
    border-radius: 4px;
    padding: 1px 6px;
    cursor: pointer;
    max-width: 130px;
  }
  .merge-open:hover {
    background: #2a2a2a;
    color: #e8e8e8;
  }
  .merge-open:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .more {
    text-align: center;
    padding: 1.5rem 1rem 0.5rem;
  }
  .more button {
    font: inherit;
    background: #1c1c1c;
    color: inherit;
    border: 1px solid #333;
    border-radius: 4px;
    padding: 5px 14px;
    cursor: pointer;
  }
  .more button:hover:not(:disabled) {
    background: #2a2a2a;
  }
  .more button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .more-hint {
    color: #777;
    font-size: 0.78rem;
    margin: 0.5rem auto 0;
    max-width: 34rem;
    line-height: 1.5;
  }
  .empty {
    text-align: center;
    color: #888;
    padding: 3rem 1rem;
  }
  .empty-title {
    font-size: 1rem;
    color: #ccc;
    margin: 0 0 0.4rem;
  }
  .empty-hint {
    margin: 0;
    font-size: 0.85rem;
    line-height: 1.5;
  }
</style>
