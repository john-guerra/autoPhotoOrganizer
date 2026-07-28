<script>
  /**
   * Finding faces (#166).
   *
   * ## Why the download is its own button
   *
   * This is the only feature in the app that asks the user to accept someone
   * else's licence. InsightFace's weights are non-commercial research use
   * only — and since 2025-11-24 their README asks users to contact them about
   * buffalo_l specifically. A single "Find faces" button that silently pulled
   * 191 MB and accepted that on the user's behalf would be the worst possible
   * shape for it. So the licence is on screen, verbatim from the model card,
   * with a link, BEFORE anything is fetched.
   *
   * ## Four states, four answers
   *
   * Weights absent, weights corrupt, scan running, or results to show. The
   * server distinguishes all four (GET /api/ml/faces) and so does this — a
   * panel that collapsed "not downloaded" into "nothing found yet" would send
   * the user looking for a bug that is really a missing 16 MB.
   */
  import {
    fetchFaceStatus,
    downloadFaceModel,
    startFaceScan,
    purgeFaces,
    retryFailedFaces,
    clusterPeople,
    cancelJob,
    fetchPeople,
    renamePerson,
    mergePeople,
  } from "./api.js";
  import { jobs, takeNewlyFinished } from "./jobs.js";
  import ScopeControl from "./ScopeControl.svelte";
  import {
    buildScopes,
    activeScope as activeScopeOf,
    scopeIdsFor,
    DEFAULT_SCOPE,
  } from "./scopeControl.js";

  /** #221: the scope selector needs the same two id sets MlSettings gets.
   *  They come down through MlPanel from App, which owns the selection and
   *  knows what the feed is showing. */
  let { onnotice, selectedIds = [], visibleIds = [] } = $props();

  /** Which set the next scan runs over. Defaults to the whole library — the
   *  panel is often opened with nothing selected, and a default that is empty
   *  makes the primary button start out disabled. */
  let scopeChoice = $state(DEFAULT_SCOPE);

  let status = $state(null);
  let people = $state([]);
  let modelId = $state("");
  let busy = $state("");
  let error = $state("");

  /** Poll only while something is running. A settings panel that polls
   *  forever keeps a laptop awake for no reason; one that never polls leaves
   *  a progress number frozen at whatever it was when you opened it. */
  let timer = null;

  async function refresh() {
    try {
      const s = await fetchFaceStatus(modelId || undefined);
      status = s;
      if (!modelId) modelId = s.modelId;
      people = await fetchPeople()
        .then((r) => r.people ?? [])
        .catch(() => []);
      clearTimeout(timer);
      if (s.running) timer = setTimeout(refresh, 2000);
    } catch (e) {
      error = `Couldn't read the face settings: ${e.message}`;
    }
  }
  $effect(() => {
    refresh();
    return () => clearTimeout(timer);
  });

  let model = $derived(status?.models.find((m) => m.id === modelId) ?? null);
  let pending = $derived(
    status
      ? status.counts.total - status.counts.scanned - status.counts.failed
      : 0
  );

  // The SAME functions ScopeControl renders from, so the button and the radio
  // buttons can never disagree about what was picked (#221).
  let scopes = $derived(
    buildScopes({ selectedIds, visibleIds, allCount: pending })
  );
  let activeScope = $derived(activeScopeOf(scopes, scopeChoice));
  let scopeIds = $derived(
    scopeIdsFor(scopeChoice, { selectedIds, visibleIds })
  );

  async function act(label, fn) {
    busy = label;
    error = "";
    try {
      await fn();
      await refresh();
    } catch (e) {
      // Server messages already name the file, the reason, and what to do.
      // Rendering them verbatim beats any wrapper this component could add.
      error = e.message;
    } finally {
      busy = "";
    }
  }

  const n = (v) => (v ?? 0).toLocaleString();

  // THE GROUPING PASS IS A JOB (#222), so this panel no longer awaits a
  // result. It reads the running row straight from the jobs SSE store — no
  // polling, and no second source of truth about whether one is in flight —
  // and picks the outcome up when the row reaches a terminal status.
  const clusterJob = $derived(
    $jobs.find((j) => j.type === "face-cluster" && j.status === "running") ??
      null
  );
  /** Set by Stop; cleared automatically once that job actually stops. Plain
   *  `let` for `handledClusterJobs` deliberately — it is bookkeeping for the
   *  effect below, and making it reactive would make the effect depend on its
   *  own write (the same note MlSettings carries). */
  let stoppingCluster = $state(null);
  const stoppingClusterNow = $derived(
    stoppingCluster !== null && clusterJob?.id === stoppingCluster
  );
  const handledClusterJobs = new Set();

  $effect(() => {
    // A finished pass rewrote every person, so the list this panel shows is
    // stale — refresh, and say what happened. Cancelled and failed are
    // DIFFERENT outcomes and get different sentences: a cancellation is not a
    // failure, and telling the user their grouping "failed" when they stopped
    // it themselves is the Finding 6 mistake.
    for (const job of takeNewlyFinished(
      $jobs,
      "face-cluster",
      handledClusterJobs
    )) {
      if (job.id === stoppingCluster) stoppingCluster = null;
      if (job.status === "canceled") {
        onnotice?.("Grouping stopped — nothing was changed.");
      } else if (job.status === "failed") {
        error = job.error ?? "Grouping failed.";
      } else {
        const r = job.result ?? {};
        onnotice?.(
          `Grouped ${n(r.assigned)} faces into ${n(r.people)} people` +
            (r.keptManual ? `, keeping ${n(r.keptManual)} you set by hand` : "")
        );
      }
      refresh();
    }
  });
</script>

<section class="faces" data-testid="face-settings">
  <h3>Find faces</h3>

  {#if !status}
    <p class="lede">Checking…</p>
  {:else}
    <label class="row">
      <span>Model</span>
      <select
        bind:value={modelId}
        onchange={refresh}
        disabled={!!busy || status.running}
        data-testid="face-model"
      >
        {#each status.models as m (m.id)}
          <option value={m.id}>{m.label}</option>
        {/each}
      </select>
    </label>

    {#if model}
      <!-- The consent notice. Verbatim from the model card, never paraphrased
           — see server/ml/faceModels.js on why this string has a bar. -->
      <p class="licence" data-testid="face-licence">
        <strong>Licence:</strong>
        {model.licence}.
        <a href={model.modelCardUrl} target="_blank" rel="noreferrer">
          Read the model card
        </a>
      </p>
    {/if}

    {#if !status.weights.ready}
      <p class="warn" data-testid="face-weights-missing">
        {#if status.weights.corrupt.length}
          The {status.weights.corrupt.join(" and ")} on disk {status.weights
            .corrupt.length > 1
            ? "do"
            : "does"} not match the expected checksum, so {status.weights
            .corrupt.length > 1
            ? "they were"
            : "it was"} not used. Downloading again will replace {status.weights
            .corrupt.length > 1
            ? "them"
            : "it"}.
        {:else}
          Not downloaded yet — about {model?.approxDownloadMB} MB, kept on this machine
          and never uploaded anywhere.
        {/if}
      </p>
      <button
        class="primary"
        disabled={!!busy}
        onclick={() =>
          act("download", async () => {
            await downloadFaceModel(modelId);
            onnotice?.(
              `Downloading ${model?.label} (about ${model?.approxDownloadMB} MB) — progress is in the jobs panel.`
            );
          })}
        data-testid="face-download"
      >
        {busy === "download"
          ? "Starting…"
          : `Download (${model?.approxDownloadMB} MB)`}
      </button>
    {:else}
      <div class="counts" data-testid="face-counts">
        {#if status.counts.scanned === 0}
          Nothing scanned yet — {n(status.counts.total)} photos to look through, about
          {status.approxMinutes} minute{status.approxMinutes === 1 ? "" : "s"}.
        {:else}
          <strong>{n(status.counts.faces)}</strong> faces in
          <strong>{n(status.counts.withFaces)}</strong> photos.
          {n(status.counts.scanned)} of {n(status.counts.total)} looked at{pending >
          0
            ? `, ${n(pending)} still to go`
            : ""}{status.counts.failed
            ? `, ${n(status.counts.failed)} could not be read`
            : ""}.
        {/if}
      </div>

      <!-- WHERE to look, before the button is pressed (#221). The SAME control
           embedding uses — the contract is explicit that this is one component,
           not one per feature. Without it the only offer was the whole library:
           you select twenty photos and the app proposes fourteen minutes of
           inference to answer a question about twenty. -->
      <ScopeControl
        legend="Find faces in"
        name="face-scope"
        testid="face-scope"
        {selectedIds}
        {visibleIds}
        allCount={pending}
        allLabel="All remaining"
        msPerPhoto={model?.approxMsPerPhoto}
        emptyMessage={pending === 0 && scopeChoice === "all"
          ? "Every photo has been looked at."
          : "Nothing to scan in this scope."}
        disabled={!!busy || status.running}
        bind:choice={scopeChoice}
      />

      <div class="actions">
        <button
          class="primary"
          disabled={!!busy || status.running || !activeScope?.n}
          onclick={() =>
            act("scan", async () => {
              const r = await startFaceScan(modelId, scopeIds);
              // `r.pending` — how many of the chosen photos are actually still
              // to be looked at — comes from the SERVER, because only the
              // worklist query knows. Saying `activeScope.n` here would
              // announce "20 photos" and then have the jobs panel count to 5,
              // which reads as the scan having given up.
              onnotice?.(
                r.alreadyRunning
                  ? "A face scan is already running."
                  : r.nothingToDo
                    ? r.message
                    : `Looking for faces in ${n(r.pending)} photo${r.pending === 1 ? "" : "s"} — progress is in the jobs panel.`
              );
            })}
          data-testid="face-scan"
        >
          {#if status.running}
            Scanning…
          {:else if !activeScope?.n}
            {pending === 0 ? "All photos scanned" : "Nothing in this scope"}
          {:else}
            Find faces in {n(activeScope.n)}
            {scopeChoice === "all"
              ? "photos"
              : `${activeScope.label.toLowerCase()} photos`}
          {/if}
        </button>

        {#if status.counts.failed > 0}
          <!-- A "could not be read" verdict only clears when the file's bytes
               change, i.e. never. Without this button a bad model file or a
               since-fixed bug would mark photos unscannable for good. -->
          <button
            disabled={!!busy || status.running}
            onclick={() =>
              act("retry", async () => {
                const r = await retryFailedFaces(modelId);
                onnotice?.(
                  `${n(r.cleared)} photo${r.cleared === 1 ? "" : "s"} will be tried again on the next scan.`
                );
              })}
            data-testid="face-retry-failed"
          >
            {busy === "retry"
              ? "Resetting…"
              : `Try the ${n(status.counts.failed)} unreadable again`}
          </button>
        {/if}

        {#if status.counts.scanned > 0}
          <button
            disabled={!!busy || status.running}
            onclick={() =>
              act("purge", async () => {
                const r = await purgeFaces(modelId);
                onnotice?.(
                  `Forgot ${n(r.faces)} faces. Nothing was done to your photos.`
                );
              })}
            data-testid="face-purge"
          >
            {busy === "purge" ? "Forgetting…" : "Forget all face data"}
          </button>
        {/if}
      </div>

      {#if status.counts.faces > 0}
        <div class="people">
          <!-- Starts a JOB and returns (#222). It does NOT await the result:
               grouping ~10,700 faces is 57 million comparisons, and this used
               to be a frozen button inside a panel that took the whole
               operation with it when you closed it. Progress, cancel and the
               outcome all live in the JobsPanel now — reachable from the main
               interface, which is the point. -->
          <button
            disabled={!!busy || status.running || !!clusterJob}
            onclick={() =>
              act("cluster", async () => {
                await clusterPeople(modelId);
                onnotice?.(
                  "Grouping faces into people — progress is in the jobs panel, and you can stop it there."
                );
              })}
            data-testid="face-cluster"
          >
            {clusterJob ? "Grouping…" : "Group faces into people"}
          </button>
          {#if clusterJob}
            <!-- A second way to stop it, right where it was started. The
                 JobsPanel's Cancel is the canonical one; this exists because
                 the user is looking HERE. -->
            <button
              disabled={stoppingClusterNow}
              onclick={() => {
                stoppingCluster = clusterJob.id;
                cancelJob(clusterJob.id);
              }}
              data-testid="face-cluster-stop"
            >
              {stoppingClusterNow ? "Stopping…" : "Stop"}
            </button>
          {/if}

          {#if people.length}
            <!-- Largest first, because ten minutes spent naming the biggest
                 clusters covers most of a library. An unnamed person is still
                 listed and still browsable — #167 is explicit about that. -->
            <ul data-testid="people-list">
              {#each people.slice(0, 40) as p (p.id)}
                <li>
                  {#if p.coverFaceId}
                    <span class="dot" aria-hidden="true"></span>
                  {/if}
                  <input
                    type="text"
                    value={p.name ?? ""}
                    placeholder={`Unnamed · ${n(p.faces)} face${p.faces === 1 ? "" : "s"}`}
                    onchange={(e) =>
                      act("name", async () => {
                        await renamePerson(p.id, e.currentTarget.value);
                      })}
                    aria-label={`Name for the person in ${p.photos} photos`}
                  />
                  <!-- Merging is the correction #167 requires, and it has to
                       be durable: the server marks every affected face as a
                       human's decision so the next grouping pass keeps it. -->
                  <select
                    class="merge"
                    value=""
                    aria-label={`Merge someone into ${p.name || "this person"}`}
                    onchange={(e) => {
                      const from = Number(e.currentTarget.value);
                      e.currentTarget.value = "";
                      if (!from) return;
                      act("merge", async () => {
                        const r = await mergePeople(p.id, from);
                        onnotice?.(
                          `Merged ${n(r.moved)} faces into ${r.name || "one person"}. It will survive the next grouping.`
                        );
                      });
                    }}
                  >
                    <option value="">Merge…</option>
                    {#each people
                      .filter((o) => o.id !== p.id)
                      .slice(0, 40) as o (o.id)}
                      <option value={o.id}>
                        {o.name || `Unnamed (${n(o.faces)})`}
                      </option>
                    {/each}
                  </select>
                  <span class="count">{n(p.photos)}</span>
                </li>
              {/each}
            </ul>
            {#if people.length > 40}
              <p class="lede">…and {n(people.length - 40)} more.</p>
            {/if}
            <p class="lede">
              Name someone and they appear in the Person filter in the toolbar.
            </p>
          {/if}
        </div>
      {/if}

      <!-- Face data is personal data about people who did not install this
           app. Saying plainly where it lives, and that it can be removed in
           one click, belongs next to the button that creates it. -->
      <p class="lede">
        Faces are stored only in this app's local index and never leave your
        machine. “Forget all face data” removes every one.
      </p>
    {/if}

    {#if error}
      <p class="err" data-testid="face-error">{error}</p>
    {/if}
  {/if}
</section>

<style>
  .faces {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
  }
  h3 {
    margin: 0;
    font-size: 0.95rem;
  }
  .lede,
  .licence {
    margin: 0;
    font-size: 0.75rem;
    opacity: 0.72;
    line-height: 1.45;
  }
  .licence a {
    color: #7aa7ff;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8rem;
  }
  select {
    background: #1c1c1c;
    color: inherit;
    border: 1px solid #3a3a3a;
    border-radius: 4px;
    padding: 0.25rem 0.4rem;
    flex: 1;
    min-width: 0;
  }
  .counts {
    font-size: 0.8rem;
    line-height: 1.45;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  button {
    background: #2c2c2c;
    color: inherit;
    border: none;
    border-radius: 4px;
    padding: 0.35rem 0.7rem;
    cursor: pointer;
    white-space: nowrap;
  }
  button.primary {
    background: #2563eb;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .warn {
    margin: 0;
    font-size: 0.78rem;
    color: #fbbf24;
    line-height: 1.45;
  }
  .people {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .people ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
    max-height: 13rem;
    overflow-y: auto;
  }
  .people li {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .people input {
    flex: 1;
    min-width: 0;
    background: #1c1c1c;
    color: inherit;
    border: 1px solid #333;
    border-radius: 4px;
    padding: 0.2rem 0.35rem;
    font-size: 0.78rem;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #4c9aff;
    flex: none;
  }
  .merge {
    background: #1c1c1c;
    color: #9a9a9a;
    border: 1px solid #333;
    border-radius: 4px;
    font-size: 0.7rem;
    padding: 0.15rem 0.2rem;
    max-width: 6rem;
    flex: none;
  }
  .count {
    font-size: 0.72rem;
    opacity: 0.6;
    min-width: 2.5rem;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .err {
    margin: 0;
    font-size: 0.78rem;
    color: #f87171;
    line-height: 1.45;
  }
</style>
