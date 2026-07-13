<script>
  // Bottom status-bar strip for background jobs (scan/export/materialize/
  // undo-move) — fed live by the SSE-backed `jobs` store. Renders nothing
  // when there are no jobs; each row lets a running job be canceled, and a
  // terminal job be dismissed (or, for a move-materialize, undone).
  import { jobs, undoFailureMessage } from "./jobs.js";
  import { cancelJob, dismissJob, undoMove } from "./api.js";

  // Per-row undo error, keyed by job id. `undoMove()` throws on a *synchronous*
  // failure (a 413 before the undo job exists, a network drop, a server
  // reject); firing it bare left that rejection console-only — the silent
  // failure issue #89 is about. Await it and surface the message inline.
  let undoErrors = {};

  async function handleUndo(job) {
    undoErrors = { ...undoErrors, [job.id]: null };
    try {
      await undoMove(job.result.manifest);
    } catch (e) {
      undoErrors = {
        ...undoErrors,
        [job.id]: undoFailureMessage(e, job.result.manifest.length),
      };
    }
  }

  /** Sum per-album {moved,copied,skipped} for a materialize job's result. */
  function materializeTotals(result) {
    return (result?.albums ?? []).reduce(
      (acc, a) => ({
        moved: acc.moved + (a.moved || 0),
        copied: acc.copied + (a.copied || 0),
        skipped: acc.skipped + (a.skipped || 0),
      }),
      { moved: 0, copied: 0, skipped: 0 }
    );
  }

  function summarize(job) {
    const r = job.result;
    if (!r) return "";
    if (job.type === "materialize") {
      const { moved, copied, skipped } = materializeTotals(r);
      const parts = [];
      if (moved) parts.push(`moved ${moved}`);
      if (copied) parts.push(`copied ${copied}`);
      if (skipped) parts.push(`skipped ${skipped}`);
      return parts.join(" · ") || "done";
    }
    if (job.type === "export") {
      const verb = r.move ? "moved" : "copied";
      return r.skipped
        ? `${verb} ${r.copied} · skipped ${r.skipped}`
        : `${verb} ${r.copied}`;
    }
    if (job.type === "scan") {
      const folders = r.folders ?? 0;
      const count = r.count ?? 0;
      return `${folders} folder${folders === 1 ? "" : "s"} · ${count} photo${count === 1 ? "" : "s"}`;
    }
    if (job.type === "undo-move") {
      return r.skipped
        ? `restored ${r.restored} · skipped ${r.skipped}`
        : `restored ${r.restored}`;
    }
    return "";
  }

  /** Undo is offered for any completed OR canceled MOVE that left a manifest —
   * a move-materialize, or an export run in "move" mode. (The backend stashes a
   * partial manifest on cancel too.) Keyed on the manifest, not the job type, so
   * a new move-capable job gets undo for free. */
  function canUndo(job) {
    return !!job.result?.move && !!job.result?.manifest?.length;
  }
</script>

{#if $jobs.length}
  <div class="jobs-panel">
    {#each $jobs as job (job.id)}
      <div
        class="job-row"
        class:failed={job.status === "failed"}
        class:canceled={job.status === "canceled"}
      >
        <span class="job-label">{job.label}</span>

        {#if job.status === "running"}
          <!-- Two elements, not one with undefined props. A job with no countable
               total (a transcode: ffmpeg reports no step count) wants an
               INDETERMINATE bar, and the only way to get one is to omit `value`
               entirely. Passing `undefined` doesn't omit it — Svelte still
               assigns the DOM property, and `progress.value = undefined` throws
               "The provided double value is non-finite", inside Svelte's flush.
               That took the whole component update down with it: the loupe froze
               mid-render on an unrelated video. A crash in a progress bar must
               not be able to break the rest of the app. -->
          {#if job.total}
            <progress class="job-progress" value={job.done ?? 0} max={job.total}
            ></progress>
          {:else}
            <progress class="job-progress"></progress>
          {/if}
          <span class="job-phase">
            {#if job.total}<strong class="job-count"
                >{(job.done ?? 0).toLocaleString()} / {job.total.toLocaleString()}</strong
              >{/if}
            {job.phase}
          </span>
          <button class="job-btn" on:click={() => cancelJob(job.id)}
            >Cancel</button
          >
        {:else if job.status === "done"}
          <span class="job-icon ok" aria-hidden="true">✓</span>
          <span class="job-summary">{summarize(job)}</span>
          {#if canUndo(job)}
            <button class="job-btn" on:click={() => handleUndo(job)}
              >Undo</button
            >
          {/if}
          {#if undoErrors[job.id]}
            <span class="job-summary err" role="alert"
              >{undoErrors[job.id]}</span
            >
          {/if}
          <button
            class="job-dismiss"
            title="Dismiss"
            on:click={() => dismissJob(job.id)}>×</button
          >
        {:else}
          <span class="job-icon err" aria-hidden="true">✗</span>
          <span class="job-summary">{job.error}</span>
          {#if canUndo(job)}
            <button class="job-btn" on:click={() => handleUndo(job)}
              >Undo</button
            >
          {/if}
          {#if undoErrors[job.id]}
            <span class="job-summary err" role="alert"
              >{undoErrors[job.id]}</span
            >
          {/if}
          <button
            class="job-dismiss"
            title="Dismiss"
            on:click={() => dismissJob(job.id)}>×</button
          >
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .jobs-panel {
    /* In-flow strip in the app's flex column (was position:fixed bottom:0,
       which painted over the status bar). flex-shrink:0 so it keeps its
       height and the grid above shrinks instead. */
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    background: #101010;
    border-top: 1px solid #2a2a2a;
    font-size: 0.8rem;
    max-height: 40vh;
    overflow-y: auto;
  }
  .job-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 12px;
    border-bottom: 1px solid #1c1c1c;
  }
  .job-row:last-child {
    border-bottom: none;
  }
  .job-label {
    flex: 0 0 auto;
    color: #e8e8e8;
    font-weight: 600;
    white-space: nowrap;
  }
  .job-progress {
    flex: 1 1 160px;
    max-width: 240px;
    accent-color: #4c9aff;
  }
  .job-count {
    color: #cfcfcf;
    font-variant-numeric: tabular-nums;
    margin-right: 4px;
  }
  .job-phase {
    flex: 1;
    min-width: 0;
    color: #9a9a9a;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .job-summary {
    flex: 1;
    min-width: 0;
    color: #9a9a9a;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .job-row.failed .job-summary,
  .job-row.canceled .job-summary {
    color: #ff8a80;
  }
  /* An undo error can appear on an otherwise-"done" row (the row itself isn't
     failed/canceled), so colour the message red on its own. */
  .job-summary.err {
    color: #ff8a80;
    white-space: normal;
  }
  .job-icon.ok {
    color: #8fd18f;
  }
  .job-icon.err {
    color: #ff8a80;
  }
  .job-btn {
    flex: 0 0 auto;
    background: #222;
    border: 1px solid #3a3a3a;
    color: #e8e8e8;
    border-radius: 6px;
    padding: 3px 9px;
    font-size: 0.78rem;
    cursor: pointer;
  }
  .job-btn:hover {
    background: #2f2f2f;
  }
  .job-dismiss {
    flex: 0 0 auto;
    background: none;
    border: none;
    color: #888;
    font-size: 1rem;
    line-height: 1;
    cursor: pointer;
    padding: 0 2px;
  }
  .job-dismiss:hover {
    color: #fff;
  }
</style>
