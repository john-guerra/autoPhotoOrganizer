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
  } from "./api.js";
  import { jobs, takeNewlyFinished } from "./jobs.js";
  import { faceClusterSummary } from "./faceClusterSummary.js";
  import ScopeControl from "./ScopeControl.svelte";
  import {
    buildScopes,
    activeScope as activeScopeOf,
    scopeRequestFor,
    DEFAULT_SCOPE,
  } from "./scopeControl.js";

  /** #221: the scope selector needs the same two id sets MlSettings gets.
   *  They come down through MlPanel from App, which owns the selection and
   *  knows what the feed is showing. */
  let {
    onnotice,
    selectedIds = [],
    selectedInFilter = undefined,
    filterSpec = {},
    filteredCount = 0,
    keepActive = false,
    keepCount = 0,
  } = $props();

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
  // `allLabel` must match what ScopeControl renders, or `activeScope.label`
  // here says "All" while the control says "All remaining" — invisible today
  // only because the button hard-codes "photos" for the all branch.
  let scopes = $derived(
    buildScopes({
      selectedIds,
      selectedInFilter,
      filteredCount,
      keepActive,
      keepCount,
      allCount: pending,
      allLabel: "All remaining",
    })
  );
  let activeScope = $derived(activeScopeOf(scopes, scopeChoice));
  let scopeRequest = $derived(
    scopeRequestFor(scopeChoice, { selectedIds, filterSpec })
  );

  // GROUPING gets its own scope, and must: contract 1 says `allCount` is the
  // operation's REMAINING work, and grouping's remaining is faces without a
  // person — a different quantity from detection's photos-without-a-scan.
  // Sharing one control would make "All" quote the wrong number for whichever
  // operation lost.
  let groupChoice = $state(DEFAULT_SCOPE);
  const groupPending = $derived(status?.grouping?.pending ?? 0);
  let groupScopes = $derived(
    buildScopes({
      selectedIds,
      selectedInFilter,
      filteredCount,
      keepActive,
      keepCount,
      allCount: groupPending,
      allLabel: "All remaining",
    })
  );
  let activeGroupScope = $derived(activeScopeOf(groupScopes, groupChoice));
  let groupScopeRequest = $derived(
    scopeRequestFor(groupChoice, { selectedIds, filterSpec })
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
  /**
   * Which finished grouping jobs have already been announced.
   *
   * Seeded on mount with every job that has ALREADY finished: `face-cluster`
   * is not self-clearing, so its row lingers in `$jobs` until dismissed — and
   * a fresh Set per mount meant closing and reopening this panel re-announced
   * a grouping that finished ten minutes ago (or re-rendered the red error
   * line for one that failed).
   */
  const handledClusterJobs = new Set();
  let seededHandled = false;

  $effect(() => {
    // A finished pass rewrote every person, so the list this panel shows is
    // stale — refresh, and say what happened. Cancelled and failed are
    // DIFFERENT outcomes and get different sentences: a cancellation is not a
    // failure, and telling the user their grouping "failed" when they stopped
    // it themselves is the Finding 6 mistake.
    if (!seededHandled) {
      // Claim everything already terminal, WITHOUT announcing it. Must run
      // before the first real read, or the announcement fires once on mount.
      takeNewlyFinished($jobs, "face-cluster", handledClusterJobs);
      seededHandled = true;
      return;
    }
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
        // `r.people` only exists on the REGROUP result; the incremental pass
        // returns `created`, and `n()`'s `?? 0` rendered the missing field as
        // a confident "0 people" (#293). Same two shapes JobsPanel.summarize
        // has to tell apart.
        onnotice?.(`Grouping finished — ${faceClusterSummary(r)}.`);
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
        {selectedInFilter}
        {filteredCount}
        {keepActive}
        {keepCount}
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
        <!-- No `clusterJob` in `disabled` any more (#258 Phase 4). Scanning and
             grouping used to be mutually exclusive in the UI because nothing
             ordered them on the server; now the scheduler does, so a scan
             requested while a grouping runs QUEUES instead of being refused. A
             disabled button is a worse answer than a queue — it makes the user
             wait without telling them what for. -->
        <button
          class="primary"
          disabled={!!busy || status.running || !activeScope?.n}
          onclick={() =>
            act("scan", async () => {
              const r = await startFaceScan(modelId, scopeRequest);
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
          {#if clusterJob}
            <!-- The server refuses this while a grouping runs (it would throw
                 the grouping away), so the button must not offer it. A refusal
                 the UI could have prevented is a dead button with an
                 explanation. -->
            Grouping faces…
          {:else if status.running}
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
          <ScopeControl
            legend="Group"
            name="face-group-scope"
            testid="face-group-scope"
            {selectedIds}
            {selectedInFilter}
            {filteredCount}
            {keepActive}
            {keepCount}
            allCount={groupPending}
            allLabel="All remaining"
            emptyMessage="Every face here already belongs to someone."
            disabled={!!busy || status.running}
            bind:choice={groupChoice}
          />
          <!-- DEMOTED, not removed (#258 Phase 4). Finding faces now groups
               them as part of the same pass, so this is the advanced "run
               just this stage" affordance rather than a step the user has to
               know about. `quiet` matches Regroup beside it. -->
          <button
            class="quiet"
            disabled={!!busy || status.running || !activeGroupScope?.n}
            onclick={() =>
              act("cluster", async () => {
                await clusterPeople(modelId, undefined, groupScopeRequest);
                onnotice?.(
                  "Grouping faces into people — progress is in the jobs panel, and you can stop it there. It keeps what it finishes, so you can stop and pick it up later."
                );
              })}
            data-testid="face-cluster"
          >
            {clusterJob
              ? "Grouping…"
              : `Group ${(activeGroupScope?.n ?? 0).toLocaleString()} faces`}
          </button>
          <!-- The old whole-library pass, kept but demoted. It THROWS AWAY
               every grouping the model owns and rebuilds from scratch, so it
               is destructive in a way the default is not, all-or-nothing, and
               far slower. Confirmed rather than one-click, per CLAUDE.md on
               destructive actions. -->
          <button
            class="quiet"
            disabled={!!busy || status.running || !!clusterJob}
            title="Throw away the current groups and rebuild them from scratch"
            onclick={() =>
              act("regroup", async () => {
                const ok = confirm(
                  `Rebuild every group from scratch?\n\nThis discards the groups the app worked out (your named people and manual merges are kept) and regroups all ${status.counts.faces.toLocaleString()} faces. It cannot be stopped part-way — unlike Group, which keeps what it finishes.`
                );
                if (!ok) return;
                await clusterPeople(modelId, undefined, { mode: "regroup" });
                onnotice?.(
                  "Rebuilding every group — progress is in the jobs panel."
                );
              })}
            data-testid="face-regroup"
          >
            Regroup everything…
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
            <!-- Browsing and naming people MOVED to the main area (#223).
                 A settings panel is for settings; anything that shows you your
                 photos — or the faces in them — belongs where selection, the
                 loupe and the keyboard already live. Naming from a list of
                 "Unnamed · 34 faces" placeholders was guessing anyway: you
                 need to see the face. What stays here is the SETTINGS half:
                 which model, download it, the licence, forget everything. -->
            <p class="lede" data-testid="face-people-moved">
              {n(people.length)}
              {people.length === 1 ? "person" : "people"} found. Naming and merging
              now live in the <strong>People</strong> view — press
              <kbd>V</kbd> to switch the main area, or use the People button in the
              toolbar.
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
  .err {
    margin: 0;
    font-size: 0.78rem;
    color: #f87171;
    line-height: 1.45;
  }
</style>
