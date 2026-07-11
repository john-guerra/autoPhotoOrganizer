<script>
  // Bottom status-bar strip for background jobs (scan/export/materialize/
  // undo-move) — fed live by the SSE-backed `jobs` store. Renders nothing
  // when there are no jobs; each row lets a running job be canceled, and a
  // terminal job be dismissed (or, for a move-materialize, undone).
  import { jobs } from "./jobs.js";
  import { cancelJob, dismissJob, undoMove } from "./api.js";

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
      return r.skipped
        ? `copied ${r.copied} · skipped ${r.skipped}`
        : `copied ${r.copied}`;
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

  /** Undo is offered for a completed OR canceled move-materialize — the
   * backend stashes a partial manifest on cancel too. */
  function canUndo(job) {
    return (
      job.type === "materialize" &&
      !!job.result?.move &&
      !!job.result?.manifest?.length
    );
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
          <progress
            class="job-progress"
            value={job.total ? job.done : undefined}
            max={job.total || undefined}
          ></progress>
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
            <button
              class="job-btn"
              on:click={() => undoMove(job.result.manifest)}>Undo</button
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
            <button
              class="job-btn"
              on:click={() => undoMove(job.result.manifest)}>Undo</button
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
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 500;
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
