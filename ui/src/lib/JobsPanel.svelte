<script>
  /**
   * Background jobs (scan / export / materialize / undo-move / transcode /
   * enrich), as a status-bar affordance rather than a wall of notices.
   *
   * It used to be an in-flow strip above the status bar, `flex-shrink: 0` and up
   * to 40vh tall, with one row per job and nothing that ever removed them. Play
   * three videos and three "Converting…" rows stacked up, took a third of the
   * window from the grid, and stayed there — the photos you came to look at were
   * being pushed off screen by notifications about the photos.
   *
   * Now it is a summary pill in the status bar's lower right, and the rows live
   * in a scrollable popover you open when you want them. Nothing is stolen from
   * the grid, however many jobs are running. Two other things do the real work of
   * keeping this quiet: a successful transcode/enrich clears its own row on the
   * server (see SELF_CLEARING in jobs/registry.js), and what's left can be swept
   * with Dismiss all.
   */
  import { jobs, undoFailureMessage } from "./jobs.js";
  import { cancelJob, dismissJob, dismissAllJobs, undoMove } from "./api.js";

  let open = $state(false);

  // Per-row error, keyed by job id — for undo, and for the same reason for
  // cancel and dismiss. `undoMove()` throws on a *synchronous* failure (a 413
  // before the undo job exists, a network drop, a server reject); firing it bare
  // left that rejection console-only — the silent failure issue #89 is about.
  // Cancel and Dismiss were STILL fire-and-forget: a rejected cancel left the row
  // sitting there claiming to be "running" forever, with no hint that the button
  // did nothing. Await them and surface the message on the row itself.
  let undoErrors = $state({});
  /** A failed Dismiss all — same rule: the button must not silently do nothing. */
  let sweepError = $state("");

  let running = $derived($jobs.filter((j) => j.status === "running"));
  /**
   * Genuinely wrong, as opposed to merely stopped.
   *
   * A cancellation is an OUTCOME the user asked for, not a failure — and
   * dressing it as one teaches people to distrust the error channel, which is
   * the one thing this pill exists to be believed about. Stopping a sweep (or
   * restarting the server mid-sweep) used to render "✗ 1 failed" in red, for
   * something that did exactly what was requested.
   *
   * Counted separately rather than dropped: a cancelled job still deserves a
   * row and a Dismiss, it just does not deserve an alarm.
   */
  let broken = $derived($jobs.filter((j) => j.status === "failed"));
  let stopped = $derived($jobs.filter((j) => j.status === "canceled"));
  let finished = $derived($jobs.filter((j) => j.status !== "running"));

  // What the pill says, in priority order: something is wrong > something is
  // working > something is waiting to be acknowledged. Only ONE line, because the
  // whole point is that it stays small.
  let pill = $derived(
    broken.length
      ? { kind: "err", icon: "✗", text: `${broken.length} failed` }
      : stopped.length && !running.length
        ? // Neutral, not red: nothing went wrong, something was stopped.
          { kind: "idle", icon: "◼", text: `${stopped.length} stopped` }
        : running.length
          ? {
              kind: "busy",
              icon: "◐",
              text:
                running.length === 1
                  ? running[0].label
                  : `${running.length} jobs running`,
            }
          : { kind: "ok", icon: "✓", text: `${finished.length} done` }
  );

  // A single bar for everything in flight. Jobs that can't count their own work
  // (a transcode: ffmpeg reports no step total) contribute nothing to either
  // side, so a lone uncountable job leaves the bar indeterminate rather than
  // pinning it at 0% and looking stuck.
  let countable = $derived(running.filter((j) => j.total > 0));
  let totalWork = $derived(countable.reduce((n, j) => n + j.total, 0));
  let doneWork = $derived(countable.reduce((n, j) => n + (j.done ?? 0), 0));

  // The popover is pointless once every job it was showing is gone; close it so
  // the user isn't left staring at an empty box that they now have to dismiss.
  // This is a genuine side effect (it mutates `open`, which is otherwise
  // user-driven, not a pure function of `$jobs`) so it stays an effect rather
  // than becoming a `$derived`.
  $effect(() => {
    if (!$jobs.length && open) open = false;
  });

  async function handleCancel(job) {
    undoErrors = { ...undoErrors, [job.id]: null };
    try {
      await cancelJob(job.id);
    } catch (e) {
      undoErrors = {
        ...undoErrors,
        [job.id]: `Couldn't cancel: ${e.message} — the job is still running.`,
      };
    }
  }

  async function handleDismiss(job) {
    undoErrors = { ...undoErrors, [job.id]: null };
    try {
      await dismissJob(job.id);
    } catch (e) {
      undoErrors = {
        ...undoErrors,
        [job.id]: `Couldn't dismiss: ${e.message}`,
      };
    }
  }

  async function handleDismissAll() {
    sweepError = "";
    try {
      await dismissAllJobs();
    } catch (e) {
      sweepError = `Couldn't clear the finished jobs: ${e.message} — try dismissing them one at a time.`;
    }
  }

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
    // These two clear themselves on success, so a row only reaches here when the
    // job was CANCELED — which still leaves a result. They had no branch at all
    // before, which rendered an empty summary next to the ✓.
    if (job.type === "enrich") {
      const read = r.read ?? 0;
      return r.failed
        ? `read ${read.toLocaleString()} · ${r.failed} unreadable`
        : `read ${read.toLocaleString()}`;
    }
    if (job.type === "transcode") {
      return r.url ? "ready to play" : "done";
    }
    if (job.type === "faces") {
      // Faces found is the answer the user asked for; how many photos were
      // looked through is the context that makes it mean something. `people`
      // appears only when new faces joined someone already named — the quiet
      // part worth surfacing, because it happens without being asked for.
      const parts = [
        `${(r.faces ?? 0).toLocaleString()} face${r.faces === 1 ? "" : "s"}`,
        `in ${(r.scanned ?? 0).toLocaleString()} photo${r.scanned === 1 ? "" : "s"}`,
      ];
      if (r.assigned)
        parts.push(
          `${r.assigned} added to ${r.people} ${r.people === 1 ? "person" : "people"}`
        );
      if (r.failed) parts.push(`${r.failed} unreadable`);
      return parts.join(" · ");
    }
    if (job.type === "face-download") {
      const got = r.downloaded?.length ?? 0;
      return got
        ? `downloaded ${got} file${got === 1 ? "" : "s"}`
        : "already on disk";
    }
    // Self-clears on success like enrich, so a row reaches here only when the
    // sweep was CANCELED or paused — which still leaves a result worth reading.
    if (job.type === "hash") {
      const hashed = r.hashed ?? 0;
      return r.failed
        ? `hashed ${hashed.toLocaleString()} · ${r.failed} unreadable`
        : `hashed ${hashed.toLocaleString()}`;
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

  /** Close on Escape, and don't let it bubble out and close the loupe too. */
  function onKeydown(event) {
    if (event.key === "Escape" && open) {
      event.stopPropagation();
      open = false;
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if $jobs.length}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="jobs-widget"
    onfocusout={(e) => {
      // Close when focus leaves the widget entirely — a click elsewhere in the
      // app shouldn't leave the popover hanging over the photos, which is the
      // whole complaint this change exists to answer.
      if (!e.currentTarget.contains(e.relatedTarget)) open = false;
    }}
  >
    {#if open}
      <div class="jobs-pop" role="dialog" aria-label="Background jobs">
        <header class="pop-head">
          <span class="pop-title">Background jobs</span>
          <button
            class="job-btn"
            disabled={!finished.length}
            title={finished.length
              ? "Clear every finished job (running jobs keep going)"
              : "Nothing finished to clear"}
            onclick={handleDismissAll}>Dismiss all</button
          >
          <button
            class="job-dismiss"
            title="Close"
            aria-label="Close"
            onclick={() => (open = false)}>×</button
          >
        </header>

        {#if sweepError}
          <p class="job-summary err" role="alert">{sweepError}</p>
        {/if}

        <div class="pop-list">
          {#each $jobs as job (job.id)}
            <div
              class="job-row"
              class:failed={job.status === "failed"}
              class:canceled={job.status === "canceled"}
            >
              <span class="job-label">{job.label}</span>

              {#if job.status === "running"}
                <!-- Two elements, not one with undefined props. A job with no
                     countable total (a transcode: ffmpeg reports no step count)
                     wants an INDETERMINATE bar, and the only way to get one is to
                     omit `value` entirely. Passing `undefined` doesn't omit it —
                     Svelte still assigns the DOM property, and
                     `progress.value = undefined` throws "The provided double
                     value is non-finite", inside Svelte's flush. That took the
                     whole component update down with it: the loupe froze
                     mid-render on an unrelated video. A crash in a progress bar
                     must not be able to break the rest of the app. -->
                {#if job.total}
                  <progress
                    class="job-progress"
                    value={job.done ?? 0}
                    max={job.total}
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
                <button class="job-btn" onclick={() => handleCancel(job)}
                  >Cancel</button
                >
              {:else if job.status === "done"}
                <span class="job-icon ok" aria-hidden="true">✓</span>
                <span class="job-summary">{summarize(job)}</span>
                {#if canUndo(job)}
                  <button class="job-btn" onclick={() => handleUndo(job)}
                    >Undo</button
                  >
                {/if}
                <button
                  class="job-dismiss"
                  title="Dismiss"
                  onclick={() => handleDismiss(job)}>×</button
                >
              {:else}
                <span class="job-icon err" aria-hidden="true">✗</span>
                <span class="job-summary">{job.error}</span>
                {#if canUndo(job)}
                  <button class="job-btn" onclick={() => handleUndo(job)}
                    >Undo</button
                  >
                {/if}
                <button
                  class="job-dismiss"
                  title="Dismiss"
                  onclick={() => handleDismiss(job)}>×</button
                >
              {/if}

              {#if undoErrors[job.id]}
                <span class="job-summary err" role="alert"
                  >{undoErrors[job.id]}</span
                >
              {/if}
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <button
      class="jobs-pill {pill.kind}"
      aria-expanded={open}
      title="Background jobs — click for details"
      onclick={() => (open = !open)}
    >
      <span
        class="pill-icon"
        class:spin={pill.kind === "busy"}
        aria-hidden="true">{pill.icon}</span
      >
      <span class="pill-text">{pill.text}</span>
      {#if running.length}
        {#if totalWork}
          <progress class="pill-progress" value={doneWork} max={totalWork}
          ></progress>
        {:else}
          <progress class="pill-progress"></progress>
        {/if}
      {/if}
    </button>
  </div>
{/if}

<style>
  /* Anchor for the popover, which opens UPWARD out of the status bar. Nothing
     here is in the grid's flow any more, so a job can no longer take space from
     the photos however many of them pile up. */
  .jobs-widget {
    position: relative;
    display: flex;
    align-items: center;
    font-size: 0.8rem;
  }
  .jobs-pill {
    display: flex;
    align-items: center;
    gap: 6px;
    max-width: 320px;
    background: #222;
    border: 1px solid #3a3a3a;
    color: #cfcfcf;
    border-radius: 999px;
    padding: 2px 10px;
    font-size: 0.78rem;
    cursor: pointer;
  }
  .jobs-pill:hover {
    background: #2f2f2f;
  }
  .jobs-pill.err {
    border-color: #7a3535;
    color: #ff8a80;
  }
  /* Stopped is not an alarm: neutral grey, deliberately NOT the red .err
     treatment, because the user asked for it. */
  .jobs-pill.idle {
    border-color: #4a4a4a;
    color: #b0b0b0;
  }
  .jobs-pill.busy {
    border-color: #35507a;
    color: #cfe3ff;
  }
  .pill-text {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pill-progress {
    flex: 0 0 auto;
    width: 56px;
    height: 6px;
    accent-color: #4c9aff;
  }
  .pill-icon.spin {
    display: inline-block;
    animation: spin 1.4s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  /* Respect the user's motion setting — a permanently spinning glyph in the
     corner is exactly the thing that setting exists to stop. */
  @media (prefers-reduced-motion: reduce) {
    .pill-icon.spin {
      animation: none;
    }
  }

  .jobs-pop {
    position: absolute;
    bottom: calc(100% + 8px);
    right: 0;
    z-index: 60;
    width: min(520px, calc(100vw - 2rem));
    display: flex;
    flex-direction: column;
    background: #101010;
    border: 1px solid #2f2f2f;
    border-radius: 8px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.55);
  }
  .pop-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-bottom: 1px solid #232323;
  }
  .pop-title {
    flex: 1;
    color: #e8e8e8;
    font-weight: 600;
  }
  /* The list scrolls; the widget itself never grows. */
  .pop-list {
    display: flex;
    flex-direction: column;
    max-height: 40vh;
    overflow-y: auto;
  }
  .job-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 10px;
    border-bottom: 1px solid #1c1c1c;
  }
  .job-row:last-child {
    border-bottom: none;
  }
  .job-label {
    flex: 0 0 auto;
    max-width: 220px;
    color: #e8e8e8;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .job-progress {
    flex: 1 1 120px;
    max-width: 200px;
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
    padding: 0 10px;
    margin: 6px 0 0;
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
  .job-btn:hover:not(:disabled) {
    background: #2f2f2f;
  }
  .job-btn:disabled {
    opacity: 0.5;
    cursor: default;
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
