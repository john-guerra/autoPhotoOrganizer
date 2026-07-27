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
  } from "./api.js";

  let { onnotice } = $props();

  let status = $state(null);
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

      <div class="actions">
        <button
          class="primary"
          disabled={!!busy || status.running || pending === 0}
          onclick={() =>
            act("scan", async () => {
              const r = await startFaceScan(modelId);
              onnotice?.(
                r.alreadyRunning
                  ? "A face scan is already running."
                  : "Looking for faces — progress is in the jobs panel."
              );
            })}
          data-testid="face-scan"
        >
          {status.running
            ? "Scanning…"
            : pending === 0
              ? "All photos scanned"
              : `Find faces in ${n(pending)} photos`}
        </button>

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
  .err {
    margin: 0;
    font-size: 0.78rem;
    color: #f87171;
    line-height: 1.45;
  }
</style>
