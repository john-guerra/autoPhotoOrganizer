<script>
  /**
   * Image understanding (#161) — the ONLY user-facing surface of the embedding
   * feature, and therefore the only place its costs are ever stated.
   *
   * Three things this panel refuses to do, each of which is a line in
   * CLAUDE.md's usability contract rather than a nicety:
   *
   *  - It never turns anything on for you. Embedding is opt-in and off by
   *    default because enabling it downloads ~90 MB of model, so the size and
   *    the licence are on screen BEFORE the toggle, not after it.
   *  - It never collapses "not computed yet" into "failed". They are different
   *    answers — one resolves by waiting, the other never will — and merging
   *    them is exactly how backupCoverage misled a user before 2.17.14.
   *  - It never claims an accelerator that is not running. The provider string
   *    is whatever `describeProvider()` reports, rendered verbatim.
   *
   * Runes, matching ManageLibrary.svelte (its host): a component is all-runes
   * or all-legacy, never half.
   */
  import {
    fetchMlSettings,
    saveMlSettings,
    fetchMlStats,
    purgeMlModel,
    startEmbed,
    cancelJob,
  } from "./api.js";
  import { jobs } from "./jobs.js";

  /** @type {{enabled:boolean, modelId:string, threads:number, maxThreads:number, models:Array<object>}|null} */
  let settings = $state(null);
  /** @type {{model:string, provider:string, counts:{total:number,embedded:number,failed:number}, storage:Array<object>}|null} */
  let stats = $state(null);
  let loadFailed = $state(false);
  let busy = $state(false);
  /** One feedback channel for the whole panel — every failure lands here with
   *  the server's own words, never a generic "Error". */
  let message = $state("");
  let messageKind = $state("info");

  // The running sweep, straight from the jobs SSE store — no polling, and no
  // second source of truth about whether one is in flight.
  const runningJob = $derived(
    $jobs.find((j) => j.type === "embed" && j.status === "running") ?? null
  );
  // Plain `let`, deliberately NOT $state: it is bookkeeping for the effect
  // below, and making it reactive would make the effect depend on its own
  // write.
  let lastJobId = null;
  /** Set by Stop; cleared automatically once that job actually stops. */
  let stoppingId = $state(null);
  const stopping = $derived(
    stoppingId !== null && runningJob?.id === stoppingId
  );

  const activeModel = $derived(
    settings?.models?.find((m) => m.id === settings.modelId) ?? null
  );
  const counts = $derived(stats?.counts ?? null);
  /** Neither embedded nor failed: nobody has tried yet. Computed here and
   *  nowhere else — /api/ml/stats is the only source for any of these. */
  const pending = $derived(
    counts ? Math.max(0, counts.total - counts.embedded - counts.failed) : 0
  );

  function say(text, kind = "info") {
    message = text;
    messageKind = kind;
  }

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  function labelFor(modelId) {
    return settings?.models?.find((m) => m.id === modelId)?.label ?? modelId;
  }

  async function load() {
    loadFailed = false;
    try {
      const [s, st] = await Promise.all([fetchMlSettings(), fetchMlStats()]);
      settings = s;
      stats = st;
    } catch (e) {
      // A panel that renders nothing and says nothing is the failure mode this
      // whole section exists to avoid.
      loadFailed = true;
      say(
        `Couldn't read the image-understanding settings: ${e.message}`,
        "err"
      );
    }
  }
  load();

  async function refreshStats() {
    try {
      stats = await fetchMlStats();
    } catch (e) {
      say(`Couldn't refresh the embedding counts: ${e.message}`, "err");
    }
  }

  // A sweep that just ended leaves the counts on screen stale. The dependency
  // is the job's id (a primitive), never a DOM node — see CLAUDE.md's first
  // reactivity trap.
  $effect(() => {
    const id = runningJob?.id ?? null;
    const ended = lastJobId !== null && id === null;
    lastJobId = id;
    if (ended) refreshStats();
  });

  /** @param {{enabled?:boolean, modelId?:string, threads?:number}} patch */
  async function save(patch) {
    busy = true;
    try {
      settings = { ...settings, ...(await saveMlSettings(patch)) };
      return true;
    } catch (e) {
      // The server distinguishes "you gave us something invalid" (400) from
      // "we couldn't save it" (500) and words each specifically — pass that
      // through instead of flattening it.
      say(`Couldn't save: ${e.message}`, "err");
      // Put the controls back to what is actually stored, so the UI never
      // shows a setting the server rejected.
      await load();
      return false;
    } finally {
      busy = false;
    }
  }

  async function toggleEnabled(event) {
    const next = event.currentTarget.checked;
    if (!(await save({ enabled: next }))) return;
    say(
      next
        ? `Image understanding is on. The first run downloads ${labelFor(settings.modelId)} (about ${activeModel?.approxDownloadMB ?? "?"} MB, once) — press “Embed now” to start it, or it starts with your next scan.`
        : "Image understanding is off. Nothing new will be embedded; the vectors already computed are kept."
    );
  }

  async function changeModel(event) {
    const nextId = event.currentTarget.value;
    const previous = labelFor(settings.modelId);
    if (nextId === settings.modelId) return;
    if (!(await save({ modelId: nextId }))) return;
    await refreshStats();
    say(
      `Switched to ${labelFor(nextId)}. Every photo needs a fresh backfill — vectors from two models are not comparable — but ${previous}'s vectors are kept, so switching back needs no re-embedding.`
    );
  }

  async function changeThreads(event) {
    await save({ threads: Number(event.currentTarget.value) });
  }

  async function embedNow() {
    // The endpoint force-starts a sweep even while the feature is switched
    // off (that click IS the consent, by design — see the route's comment).
    // But a user who never turned this on has never agreed to the download,
    // so say what it costs before spending it.
    if (
      !settings.enabled &&
      !confirm(
        `Image understanding is off. Embedding now downloads ${labelFor(settings.modelId)} (about ${activeModel?.approxDownloadMB ?? "?"} MB, once) and then reads every photo on this computer. Start it?`
      )
    ) {
      return;
    }
    busy = true;
    try {
      const r = await startEmbed();
      if (r.started) {
        say("Embedding started — watch it in the jobs panel.");
      } else if (r.alreadyRunning) {
        // The single-flight latch is not keyed by model, so this is exactly
        // what a user who just switched models gets. Unrendered, the button
        // would be dead.
        say(
          "A sweep is already running, so nothing new was started. Stop it below if you want the new settings to take effect now — otherwise it finishes on the old ones.",
          "warn"
        );
      } else {
        say("Nothing to embed right now.");
      }
    } catch (e) {
      say(`Couldn't start embedding: ${e.message}`, "err");
    } finally {
      busy = false;
    }
  }

  async function stopSweep() {
    const job = runningJob;
    if (!job) return;
    stoppingId = job.id;
    try {
      await cancelJob(job.id);
      say(
        "Stopping — the sweep checks between batches, so up to 16 more photos may still finish. Nothing is lost: it resumes where it left off."
      );
    } catch (e) {
      stoppingId = null;
      say(
        `Couldn't stop the sweep: ${e.message} — it is still running.`,
        "err"
      );
    }
  }

  async function purge(row) {
    if (
      !confirm(
        `Delete all ${row.rows.toLocaleString()} stored vectors for ${labelFor(row.model)}? Searching by them stops working until they are computed again. Your photos are not touched.`
      )
    ) {
      return;
    }
    busy = true;
    try {
      const r = await purgeMlModel(row.model);
      say(
        `Deleted ${r.rows.toLocaleString()} vector(s) for ${labelFor(row.model)}.`
      );
      await refreshStats();
    } catch (e) {
      say(`Couldn't purge ${labelFor(row.model)}: ${e.message}`, "err");
    } finally {
      busy = false;
    }
  }
</script>

<section class="ml" data-testid="ml-settings">
  <h3>Image understanding</h3>

  {#if message}
    <p
      class="message"
      class:err={messageKind === "err"}
      data-testid="ml-message"
    >
      {message}
    </p>
  {/if}

  {#if loadFailed}
    <div class="ml-actions">
      <button onclick={load}>Try again</button>
    </div>
  {:else if !settings || !stats}
    <p class="empty">Loading…</p>
  {:else}
    <p class="hint">
      Reads each photo once with a small vision model so AutoGallery can find
      photos by what is in them. Everything runs on this computer — no photo is
      ever uploaded.
    </p>

    <label class="toggle">
      <input
        type="checkbox"
        data-testid="ml-enable"
        checked={settings.enabled}
        disabled={busy}
        onchange={toggleEnabled}
      />
      <span>Embed photos in the background</span>
    </label>
    <p class="hint consent">
      Off until you turn it on, because turning it on downloads
      <strong>{activeModel?.label ?? settings.modelId}</strong>
      — about
      <strong>{activeModel?.approxDownloadMB ?? "?"} MB</strong>, once, from
      Hugging Face. Licence: {activeModel?.licence ?? "see the model's page"}.
    </p>

    <label class="field">
      <span class="field-label">Model</span>
      <select
        data-testid="ml-model"
        value={settings.modelId}
        disabled={busy}
        onchange={changeModel}
      >
        {#each settings.models as m (m.id)}
          <option value={m.id}
            >{m.label} — {m.dim} dims, ~{m.approxDownloadMB} MB</option
          >
        {/each}
      </select>
    </label>
    {#if activeModel?.note}
      <p class="hint">{activeModel.note}</p>
    {/if}
    <p class="hint warn-note">
      Switching model starts a fresh backfill: vectors from two models are not
      comparable, so every photo has to be read again. The other model's vectors
      are kept — switching back costs nothing.
    </p>

    <label class="field">
      <span class="field-label">CPU share</span>
      <input
        type="range"
        min="1"
        max={settings.maxThreads}
        value={settings.threads}
        disabled={busy}
        onchange={changeThreads}
      />
      <span class="field-value"
        >{settings.threads} of {settings.maxThreads} cores</span
      >
    </label>
    <p class="hint">
      Fewer cores keeps scrolling and thumbnails responsive while embedding runs
      in the background; more cores finish sooner but make the app feel slower
      meanwhile.
    </p>

    <ul class="counts" data-testid="ml-counts">
      <li>
        <strong>{counts.embedded.toLocaleString()}</strong> embedded
        <span class="of">of {counts.total.toLocaleString()} photos</span>
      </li>
      <li>
        <strong>{pending.toLocaleString()}</strong> not computed yet
        <span class="of">— waiting for a sweep</span>
      </li>
      <li class:bad={counts.failed > 0}>
        <strong>{counts.failed.toLocaleString()}</strong> failed
        <span class="of">— tried, and could not be read</span>
      </li>
    </ul>

    <p class="provider">
      Running on <code data-testid="ml-provider">{stats.provider}</code>
    </p>

    <div class="ml-actions">
      <button
        data-testid="ml-embed-now"
        disabled={busy || !!runningJob}
        onclick={embedNow}
      >
        {runningJob ? "Embedding…" : "Embed now"}
      </button>
      {#if runningJob}
        <button disabled={stopping} onclick={stopSweep}>
          {stopping ? "Stopping…" : "Stop"}
        </button>
      {/if}
      <button disabled={busy} onclick={refreshStats}>Refresh counts</button>
    </div>

    {#if runningJob}
      <p class="hint">
        {runningJob.phase || "Embedding"}
        {#if runningJob.total > 0}
          — {runningJob.done.toLocaleString()} of {runningJob.total.toLocaleString()}
        {/if}
        {#if stopping}
          · stopping after the current batch (up to 16 more photos)
        {/if}
      </p>
    {/if}

    <h4>Stored vectors</h4>
    {#if stats.storage.length === 0}
      <p class="empty">Nothing stored yet.</p>
    {:else}
      <ul class="storage-list">
        {#each stats.storage as row (row.model)}
          <li data-testid="ml-storage-row">
            <span class="storage-name" title={row.model}
              >{labelFor(row.model)}</span
            >
            <span class="storage-size"
              >{row.rows.toLocaleString()} stored · {formatBytes(
                row.bytes
              )}</span
            >
            <button disabled={busy} onclick={() => purge(row)}>Purge</button>
          </li>
        {/each}
      </ul>
      <p class="hint">
        Counts every vector on disk, including ones for photos no longer in the
        library — so it can be higher than the “embedded” number above, which
        only counts photos still here.
      </p>
    {/if}
  {/if}
</section>

<style>
  h3 {
    margin: 0.75rem 0 0.4rem;
    font-size: 0.95rem;
    color: #ccc;
  }
  h4 {
    margin: 0.75rem 0 0.3rem;
    font-size: 0.85rem;
    color: #bbb;
  }
  .message {
    background: #2a2a2a;
    border-radius: 4px;
    padding: 0.4rem 0.6rem;
    font-size: 0.85rem;
    line-height: 1.4;
  }
  .message.err {
    background: #2a1414;
    color: #ff8a80;
  }
  .empty {
    color: #888;
    font-size: 0.85rem;
  }
  .hint {
    color: #888;
    font-size: 0.8rem;
    line-height: 1.4;
    margin: 0.35rem 0 0;
  }
  .consent {
    color: #a9a9a9;
  }
  .warn-note {
    color: #c9b48a;
  }
  .toggle {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.6rem;
    font-size: 0.9rem;
    cursor: pointer;
  }
  .field {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.7rem;
    font-size: 0.85rem;
  }
  .field-label {
    min-width: 5.5rem;
    color: #ccc;
  }
  .field select {
    flex: 1;
    background: #101010;
    color: inherit;
    border: 1px solid #333;
    border-radius: 4px;
    padding: 0.25rem 0.4rem;
    font-size: 0.85rem;
  }
  .field input[type="range"] {
    flex: 1;
  }
  .field-value {
    color: #aaa;
    white-space: nowrap;
  }
  .counts {
    list-style: none;
    margin: 0.7rem 0 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem 1.2rem;
    font-size: 0.85rem;
  }
  .counts li strong {
    font-size: 1rem;
  }
  .counts li.bad strong {
    color: #ff8a80;
  }
  .counts .of {
    color: #888;
    font-size: 0.78rem;
  }
  .provider {
    margin: 0.5rem 0 0;
    font-size: 0.8rem;
    color: #888;
  }
  .provider code {
    background: #1e1e1e;
    padding: 0 4px;
    border-radius: 3px;
    color: #ccc;
  }
  .ml-actions {
    display: flex;
    gap: 0.5rem;
    margin: 0.6rem 0 0;
  }
  .ml-actions button,
  .storage-list button {
    background: #333;
    color: inherit;
    border: none;
    border-radius: 4px;
    padding: 0.3rem 0.6rem;
    cursor: pointer;
    font-size: 0.8rem;
  }
  .ml-actions button:hover:not(:disabled),
  .storage-list button:hover:not(:disabled) {
    background: #444;
  }
  .ml-actions button:disabled,
  .storage-list button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .storage-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .storage-list li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3rem 0;
    border-bottom: 1px solid #2a2a2a;
  }
  .storage-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.85rem;
  }
  .storage-size {
    font-size: 0.8rem;
    color: #aaa;
  }
</style>
