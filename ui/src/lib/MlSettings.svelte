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
    retryMlFailed,
    startEmbed,
    startNearDupes,
    cancelJob,
  } from "./api.js";
  import { jobs } from "./jobs.js";

  /** @type {{enabled:boolean, modelId:string, threads:number, maxThreads:number, models:Array<object>}|null} */
  let settings = $state(null);
  /**
   * What the three controls currently SHOW, mirrored out of `settings`.
   *
   * They exist because a one-way `checked={settings.enabled}` cannot revert.
   * Svelte 5 caches the last value it wrote to an attribute and skips the DOM
   * write when the new value matches that cache — it never looks at the
   * element's real state. So after the user ticks the box and the PUT fails
   * (a read-only `~/.autogallery`, which is the whole reason
   * MlSettingsPersistError exists), re-reading `enabled: false` from the server
   * writes nothing: `false` was already the cached value, and the checkbox
   * stays visibly ON while the server stored nothing. Same for the `<select>`
   * (stuck on the model that was refused) and the slider (thumb at 8 above a
   * label reading "4 of 8 cores").
   *
   * `bind:` assigns unconditionally, so these mirrors are what makes
   * `syncDrafts()` — and therefore every failure path — actually revert the UI.
   */
  let enabledDraft = $state(false);
  let modelDraft = $state("");
  let threadsDraft = $state(1);
  /**
   * The near-duplicate controls (#162), mirrored for the same reason as the
   * three above.
   *
   * `thresholdDraft` always holds a NUMBER, never null, because a range input
   * has no representation for "unset" — it would silently render 0.5 (its min)
   * and the user would be looking at a value the server is not using. The
   * stored setting keeps null meaning "use the active model's own value", so
   * the draft is seeded from the model's default and a Reset control puts the
   * null back. Whether the user is currently on the default is `usingModelDefault`.
   */
  let thresholdDraft = $state(0.9);
  let windowSecDraft = $state(60);
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
  /** Same bookkeeping, for the grouping pass — its counts live in the same
   *  /api/ml/stats payload, so a finished pass leaves them stale too. */
  let lastDupeJobId = null;
  /** Set by Stop; cleared automatically once that job actually stops. */
  let stoppingId = $state(null);
  const stopping = $derived(
    stoppingId !== null && runningJob?.id === stoppingId
  );

  const dupeJob = $derived(
    $jobs.find((j) => j.type === "near-dupes" && j.status === "running") ?? null
  );
  /** Whether the stored setting is still `null` — i.e. following the active
   *  model's own value rather than an override the user typed. */
  const usingModelDefault = $derived(settings?.nearDupeThreshold == null);
  const activeModel = $derived(
    settings?.models?.find((m) => m.id === settings.modelId) ?? null
  );
  const counts = $derived(stats?.counts ?? null);
  /**
   * Do the counts on screen describe the model that is selected above them?
   *
   * /api/ml/stats answers for ONE model and says which, so when a refresh
   * fails after a model switch the block would otherwise show the old model's
   * numbers under the new model's name — "12,431 embedded of 12,500" for a
   * model with zero vectors. That is the exact counts-honesty failure this
   * panel exists to prevent, so the mismatch is rendered rather than hidden.
   */
  const countsStale = $derived(
    !!stats && !!settings && stats.model !== settings.modelId
  );
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

  /** Put the controls back to exactly what the server last told us. */
  function syncDrafts() {
    if (!settings) return;
    enabledDraft = settings.enabled;
    modelDraft = settings.modelId;
    threadsDraft = settings.threads;
    // null (the default) resolves to the ACTIVE model's own threshold, so the
    // slider shows the number actually in force rather than an invented one.
    thresholdDraft = settings.nearDupeThreshold ?? modelThreshold(settings);
    windowSecDraft = Math.round(settings.nearDupeWindowMs / 1000);
  }

  /** The active model's own measured threshold — what `null` means. */
  function modelThreshold(s) {
    return s?.models?.find((m) => m.id === s.modelId)?.nearDupeThreshold ?? 0.9;
  }

  /**
   * Every one of these returns its failure instead of announcing it, because
   * they are called from handlers that go on to say something else — and the
   * LAST `say()` wins. A refresh failure swallowed into the message channel
   * and then overwritten by "Switched to CLIP" is a success banner on top of
   * the previous model's numbers.
   * @returns {Promise<string|null>} null on success, the reason otherwise.
   */
  async function load() {
    try {
      const [s, st] = await Promise.all([fetchMlSettings(), fetchMlStats()]);
      settings = s;
      stats = st;
      syncDrafts();
      loadFailed = false;
      return null;
    } catch (e) {
      // A panel that renders nothing and says nothing is the failure mode this
      // whole section exists to avoid.
      loadFailed = true;
      return e.message;
    }
  }
  async function retryLoad() {
    const err = await load();
    say(
      err
        ? `Couldn't read the image-understanding settings: ${err}`
        : "Settings reloaded.",
      err ? "err" : "info"
    );
  }
  load().then((err) => {
    if (err) {
      say(`Couldn't read the image-understanding settings: ${err}`, "err");
    }
  });

  /** @returns {Promise<string|null>} null on success, the reason otherwise. */
  async function refreshStats() {
    try {
      stats = await fetchMlStats();
      return null;
    } catch (e) {
      return e.message;
    }
  }

  async function refreshStatsAnnounced() {
    const err = await refreshStats();
    say(
      err
        ? `Couldn't refresh the embedding counts: ${err}`
        : "Counts refreshed.",
      err ? "err" : "info"
    );
  }

  // A sweep that just ended leaves the counts on screen stale. The dependency
  // is the job's id (a primitive), never a DOM node — see CLAUDE.md's first
  // reactivity trap.
  $effect(() => {
    const id = runningJob?.id ?? null;
    const ended = lastJobId !== null && id === null;
    lastJobId = id;
    if (ended) {
      // Job ids are per-process (`job-${++seq}`), so a server restart hands out
      // `job-3` again: an uncleared stoppingId would render the NEXT sweep as
      // "Stopping…" with Stop disabled, forever.
      stoppingId = null;
      refreshStats().then((err) => {
        if (err) say(`Couldn't refresh the embedding counts: ${err}`, "err");
      });
    }
  });

  // The grouping pass, same shape. Kept as its own effect rather than folded
  // into the one above because the two jobs end independently — a single
  // effect reading both ids would re-run (and re-fetch) whenever EITHER
  // changed, including while the other is still mid-sweep.
  $effect(() => {
    const id = dupeJob?.id ?? null;
    const ended = lastDupeJobId !== null && id === null;
    lastDupeJobId = id;
    if (ended) {
      refreshStats().then((err) => {
        if (err)
          say(`Couldn't refresh the near-duplicate counts: ${err}`, "err");
      });
    }
  });

  /** @param {{enabled?:boolean, modelId?:string, threads?:number}} patch */
  async function save(patch) {
    busy = true;
    try {
      settings = { ...settings, ...(await saveMlSettings(patch)) };
      syncDrafts();
      return true;
    } catch (e) {
      // The server distinguishes "you gave us something invalid" (400) from
      // "we couldn't save it" (500) and words each specifically — pass that
      // through instead of flattening it.
      const why = `Couldn't save: ${e.message}`;
      // Put the controls back to what is actually STORED, so the panel never
      // shows a setting the server rejected. `syncDrafts` runs either way: if
      // the re-read also failed, reverting to the last known-stored values is
      // still closer to the truth than leaving the user's rejected input on
      // screen.
      const reloadErr = await load();
      syncDrafts();
      say(
        reloadErr
          ? `${why} Re-reading the stored settings failed too (${reloadErr}), so these controls may not match what is on disk.`
          : why,
        "err"
      );
      return false;
    } finally {
      busy = false;
    }
  }

  async function toggleEnabled() {
    const next = enabledDraft; // bind: has already applied the click
    if (!(await save({ enabled: next }))) return;
    say(
      next
        ? `Image understanding is on. The first run downloads ${labelFor(settings.modelId)} (about ${activeModel?.approxDownloadMB ?? "?"} MB, once) — press “Embed now” to start it, or it starts with your next scan.`
        : "Image understanding is off. Nothing new will be embedded; the vectors already computed are kept."
    );
  }

  async function changeModel() {
    const nextId = modelDraft;
    const previous = labelFor(settings.modelId);
    if (nextId === settings.modelId) return;
    if (!(await save({ modelId: nextId }))) return;
    const switched = `Switched to ${labelFor(nextId)}. Every photo needs a fresh backfill — vectors from two models are not comparable — but ${previous}'s vectors are kept, so switching back needs no re-embedding.`;
    const refreshErr = await refreshStats();
    // Never a success banner over the OLD model's counts: if the refresh
    // failed, that is the headline, and the counts block below labels itself
    // with the model it actually describes.
    say(
      refreshErr
        ? `${switched} The counts below could not be refreshed (${refreshErr}) — they still describe ${previous}. Press “Refresh counts”.`
        : switched,
      refreshErr ? "err" : "info"
    );
  }

  async function changeThreads() {
    await save({ threads: Number(threadsDraft) });
  }

  /**
   * Changing either near-duplicate input makes the STORED grouping describe a
   * rule that is no longer in force, so the server clears it and starts a
   * fresh pass. Say that plainly: a user who tightens the threshold and sees
   * their stacks vanish for a few seconds should know it is regrouping, not
   * broken.
   */
  async function changeThreshold() {
    if (!(await save({ nearDupeThreshold: Number(thresholdDraft) }))) return;
    say(regroupingNote());
  }

  async function changeWindow() {
    if (!(await save({ nearDupeWindowMs: Number(windowSecDraft) * 1000 })))
      return;
    say(regroupingNote());
  }

  /** Back to the active model's own measured value — the `null` the setting
   *  stores, not a number copied out of the model, so a later model switch
   *  follows the new model instead of carrying this one's value across. */
  async function resetThreshold() {
    if (!(await save({ nearDupeThreshold: null }))) return;
    say(
      `Back to ${labelFor(settings.modelId)}'s own value (${modelThreshold(settings).toFixed(2)}). ${regroupingNote()}`
    );
  }

  function regroupingNote() {
    return "Regrouping now — stacks update when the job finishes. No photo is moved or deleted.";
  }

  async function findNearDupesNow() {
    busy = true;
    try {
      const r = await startNearDupes();
      if (r.started) say("Looking for near-duplicates — watch the jobs panel.");
      else if (r.alreadyRunning)
        say("Already looking for near-duplicates.", "warn");
    } catch (e) {
      // Includes the server's 409 when the feature is off, in its own words
      // ("Turn it on in Manage library to compute embeddings first").
      say(`Couldn't start near-duplicate detection: ${e.message}`, "err");
    } finally {
      busy = false;
    }
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

  /**
   * Take back every "could not be embedded" record for the active model.
   *
   * The panel needs this because a failure record is otherwise permanent:
   * only a change to the file's bytes, deleting the photo, or Purge clears
   * one — and Purge is rendered per row of `storage`, so a sweep that failed
   * EVERYTHING (a model that would not download) leaves no vectors, no
   * storage row, and therefore no button anywhere in the app. The only way
   * back was deleting index.db, which also takes ratings, keep-scope, manual
   * stacks and album names with it.
   */
  async function retryFailed() {
    if (
      !confirm(
        `Try ${counts.failed.toLocaleString()} failed photo(s) again with ${labelFor(settings.modelId)}? Nothing already embedded is touched.`
      )
    ) {
      return;
    }
    busy = true;
    try {
      const r = await retryMlFailed();
      const refreshErr = await refreshStats();
      say(
        refreshErr
          ? `${r.cleared.toLocaleString()} photo(s) will be tried again, but the counts below could not be refreshed (${refreshErr}) — press “Refresh counts”.`
          : `${r.cleared.toLocaleString()} photo(s) will be tried again — press “Embed now”, or they go with the next scan.`,
        refreshErr ? "err" : "info"
      );
    } catch (e) {
      // Includes the 409 the server answers while a sweep is running, in its
      // own words ("stop it in the jobs panel first") — the button is also
      // disabled then, but the request can still race a sweep that started
      // a moment ago.
      say(`Couldn't clear the failures: ${e.message}`, "err");
    } finally {
      busy = false;
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
      const refreshErr = await refreshStats();
      say(
        refreshErr
          ? `Deleted ${r.rows.toLocaleString()} vector(s) for ${labelFor(row.model)}, but the counts below could not be refreshed (${refreshErr}) — press “Refresh counts”.`
          : `Deleted ${r.rows.toLocaleString()} vector(s) for ${labelFor(row.model)}.`,
        refreshErr ? "err" : "info"
      );
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
      <button onclick={retryLoad}>Try again</button>
    </div>
  {:else if !settings || !stats}
    <p class="empty">Loading…</p>
  {:else}
    <p class="hint">
      Reads each photo once with a small vision model so AutoGallery can find
      photos by what is in them. Everything runs on this computer — no photo is
      ever uploaded.
    </p>

    <!-- BEFORE the toggle, in DOM order, not merely above it visually: a
         keyboard or screen-reader user reaches controls in this order, and the
         checkbox's own name is just "Embed photos in the background" — the
         size and the licence are the part they are consenting to. Also wired
         as the checkbox's description, so it is announced with it either
         way. -->
    <p class="hint consent" id="ml-consent-text" data-testid="ml-consent">
      Off until you turn it on, because turning it on downloads
      <strong>{activeModel?.label ?? settings.modelId}</strong>
      — about
      <strong>{activeModel?.approxDownloadMB ?? "?"} MB</strong>, once, from
      Hugging Face. Licence: {activeModel?.licence ??
        "not known — check the model card"}.
      {#if activeModel?.modelCardUrl}
        <!-- The licence line only ever repeats what the card DECLARES, and for
             some models that is nothing at all — so the card itself is always
             one click away rather than being something the user has to take
             our word for. -->
        <a
          href={activeModel.modelCardUrl}
          target="_blank"
          rel="noreferrer noopener">Model card</a
        >
      {/if}
    </p>
    <label class="toggle">
      <input
        type="checkbox"
        data-testid="ml-enable"
        bind:checked={enabledDraft}
        aria-describedby="ml-consent-text"
        disabled={busy}
        onchange={toggleEnabled}
      />
      <span>Embed photos in the background</span>
    </label>

    <label class="field">
      <span class="field-label">Model</span>
      <select
        data-testid="ml-model"
        bind:value={modelDraft}
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
        bind:value={threadsDraft}
        disabled={busy}
        onchange={changeThreads}
      />
      <!-- The DRAFT, so the label tracks the thumb while it is being dragged
           and reverts with it when a save is refused. -->
      <span class="field-value"
        >{threadsDraft} of {settings.maxThreads} cores</span
      >
    </label>
    <p class="hint">
      Fewer cores keeps scrolling and thumbnails responsive while embedding runs
      in the background; more cores finish sooner but make the app feel slower
      meanwhile.
    </p>

    <!-- Which model these numbers describe, ALWAYS — /api/ml/stats answers for
         one model and says which, so there is no state in which the counts sit
         on screen unlabelled. When it disagrees with the picker above (a
         refresh that didn't come through), that is said outright rather than
         left for the user to misread as the new model's progress. -->
    <p class="counts-for" class:stale={countsStale} data-testid="ml-counts-for">
      {#if countsStale}
        Showing {labelFor(stats.model)}'s counts — not the model selected above.
        Press “Refresh counts”.
      {:else}
        Counts for {labelFor(stats.model)}
      {/if}
    </p>
    <ul class="counts" class:stale={countsStale} data-testid="ml-counts">
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
    {#if counts.failed > 0}
      <!-- A failure record used to be permanent: nothing else in the app can
           clear one unless vectors also exist (Purge is rendered per stored-
           vector row). So the way back has to live right next to the number
           it undoes. -->
      <div class="ml-actions">
        <button
          data-testid="ml-retry-failed"
          disabled={busy || !!runningJob}
          title={runningJob
            ? "Stop the running sweep first — clearing these while it runs would interrupt it."
            : "Forget these failures and try the photos again on the next sweep."}
          onclick={retryFailed}
        >
          Retry {counts.failed.toLocaleString()} failed
        </button>
      </div>
    {/if}
    <!-- RAW is not attempted at all, and saying so is cheaper than leaving
         the user to wonder why the totals don't match their library. -->
    <p class="hint" data-testid="ml-raw-note">
      RAW files are skipped — there is no preview AutoGallery can read for one
      yet — so they are left out of these counts rather than counted as
      failures. JPEGs, PNGs and videos are all included.
    </p>

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
      <button disabled={busy} onclick={refreshStatsAnnounced}
        >Refresh counts</button
      >
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

    <h4>Near-duplicates</h4>
    <p class="hint">
      Photos of the same shot are stacked together, even when the pause between
      them is too long for burst detection to catch on timing alone. Only photos
      taken within the time window below are ever compared — the same scene
      re-shot on another day is left alone.
    </p>

    <label class="field">
      <span class="field-label">Similarity</span>
      <!-- Floor 0.5, matching the server's clamp. Below the band where two
           unrelated photos that merely share a genre already score (0.61-0.68),
           a lower value does not group "more aggressively" — it collapses whole
           minutes of a shoot into one stack. -->
      <input
        type="range"
        data-testid="ml-dupe-threshold"
        min="0.5"
        max="0.99"
        step="0.01"
        bind:value={thresholdDraft}
        disabled={busy}
        onchange={changeThreshold}
      />
      <span class="field-value">{Number(thresholdDraft).toFixed(2)}</span>
    </label>
    <p class="hint">
      Higher means only near-identical frames stack — safer, and the reason the
      default is deliberately strict: a missed duplicate is invisible, but a
      wrong one hides a photo behind a stack cover.
      {#if usingModelDefault}
        Using {labelFor(settings.modelId)}'s own value.
      {:else}
        <button class="linkish" disabled={busy} onclick={resetThreshold}>
          Reset to {labelFor(settings.modelId)}'s value ({modelThreshold(
            settings
          ).toFixed(2)})
        </button>
      {/if}
    </p>

    <label class="field">
      <span class="field-label">Time window</span>
      <input
        type="range"
        data-testid="ml-dupe-window"
        min="3"
        max="600"
        step="1"
        bind:value={windowSecDraft}
        disabled={busy}
        onchange={changeWindow}
      />
      <span class="field-value">{windowSecDraft}s</span>
    </label>

    <ul class="counts" data-testid="ml-dupe-counts">
      <li>
        <strong>{(stats.nearDupes?.groups ?? 0).toLocaleString()}</strong>
        groups found
        <span class="of"
          >— covering {(stats.nearDupes?.photos ?? 0).toLocaleString()} photos</span
        >
      </li>
    </ul>

    <div class="ml-actions">
      <button
        data-testid="ml-find-dupes"
        disabled={busy || !!dupeJob}
        onclick={findNearDupesNow}
      >
        {dupeJob ? "Looking…" : "Find near-duplicates now"}
      </button>
    </div>
    <p class="hint">
      Uses the vectors already stored, so this takes seconds — it never re-reads
      your photos.
    </p>
    {#if dupeJob}
      <p class="hint">{dupeJob.phase || "Comparing photos"}</p>
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
            <!-- Disabled while a sweep runs: purging deletes the very rows
                 the sweep is working through, which trips runSweep's stall
                 guard and kills it with a message that reads like an
                 internal bug report ("markFailed is not removing the row…")
                 for an action the panel invited. The server refuses with a
                 409 too — this only keeps the user from being told off for
                 pressing an enabled button. -->
            <button
              disabled={busy || !!runningJob}
              title={runningJob
                ? "Stop the running sweep first — purging while it runs would interrupt it."
                : `Delete the stored vectors for ${labelFor(row.model)}.`}
              onclick={() => purge(row)}>Purge</button
            >
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
  .consent a {
    color: #6aa9ff;
    white-space: nowrap;
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
  .counts-for {
    margin: 0.7rem 0 0;
    font-size: 0.78rem;
    color: #888;
  }
  .counts-for.stale {
    color: #c9b48a;
  }
  .counts.stale {
    opacity: 0.65;
  }
  .counts {
    list-style: none;
    margin: 0.3rem 0 0;
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
  /* An inline action inside a hint paragraph — the reset belongs beside the
     sentence explaining what it resets to, not in the button row below. */
  .linkish {
    background: none;
    border: none;
    padding: 0;
    color: #6aa9ff;
    font: inherit;
    cursor: pointer;
    text-decoration: underline;
  }
  .linkish:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
