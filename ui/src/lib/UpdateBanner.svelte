<script>
  /**
   * Auto-update banner (Electron only). Subscribes to the main process's
   * "update:status" stream via the preload bridge and shows a small, dismissible
   * card as an update moves through available → downloading → ready. The silent
   * startup check stays quiet: "checking"/"up to date"/"error" only surface when
   * the user explicitly triggered a check (Check for Updates… menu). In the web
   * build window.autogallery is undefined, so this renders nothing.
   */
  import { onMount, onDestroy } from "svelte";

  const updates =
    typeof window !== "undefined" ? window.autogallery?.updates : null;

  let status = null;
  let unsub = null;

  onMount(() => {
    if (!updates) return;
    unsub = updates.onStatus((s) => (status = s));
  });
  onDestroy(() => unsub && unsub());

  $: state = status?.state;

  // Which states get a visible card. Non-actionable states (checking / up to
  // date / error) only show when the user asked — otherwise the background
  // startup check would flash a banner every launch.
  $: visible =
    state === "available" ||
    state === "downloading" ||
    state === "downloaded" ||
    ((state === "checking" || state === "none" || state === "error") &&
      status?.userInitiated);

  // Reset dismissal on genuine state transitions only (not on every
  // download-progress tick, so the card stays dismissible mid-download).
  let dismissed = false;
  let prevState;
  $: if (state !== prevState) {
    prevState = state;
    dismissed = false;
  }

  let installing = false;
  async function restart() {
    installing = true;
    await updates?.install();
  }
</script>

{#if updates && visible && !dismissed}
  <div class="update-banner" class:ready={state === "downloaded"} role="status">
    <div class="msg">
      {#if state === "checking"}
        <span class="spin" aria-hidden="true"></span> Checking for updates…
      {:else if state === "available"}
        <span class="spin" aria-hidden="true"></span> Update
        {status.version ? `v${status.version}` : ""} available — downloading…
      {:else if state === "downloading"}
        Downloading update… {status.percent ?? 0}%
      {:else if state === "downloaded"}
        Update {status.version ? `v${status.version}` : ""} ready to install.
      {:else if state === "none"}
        You’re up to date.
      {:else if state === "error"}
        Update check failed: {status.message}
      {/if}
    </div>

    {#if state === "downloading"}
      <div class="bar"><div class="fill" style="width:{status.percent ?? 0}%"></div></div>
    {/if}

    {#if state === "downloaded"}
      <button class="install" on:click={restart} disabled={installing}>
        {installing ? "Restarting…" : "Restart & Install"}
      </button>
    {/if}

    <button class="close" title="Dismiss" aria-label="Dismiss" on:click={() => (dismissed = true)}
      >×</button
    >
  </div>
{/if}

<style>
  .update-banner {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: 1000;
    max-width: 360px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    background: #1d2634;
    color: #e6edf6;
    border: 1px solid #33405a;
    border-radius: 10px;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
    font-size: 0.85rem;
  }
  .update-banner.ready {
    border-color: #3d7fe0;
  }
  .msg {
    flex: 1 1 auto;
    line-height: 1.35;
  }
  .bar {
    position: absolute;
    left: 12px;
    right: 12px;
    bottom: 6px;
    height: 3px;
    background: #33405a;
    border-radius: 2px;
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: #4c9aff;
    transition: width 120ms linear;
  }
  .install {
    flex: 0 0 auto;
    background: #3d7fe0;
    color: #fff;
    border: none;
    border-radius: 6px;
    padding: 5px 10px;
    font-size: 0.8rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .install:hover {
    background: #4c8ef0;
  }
  .install:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .close {
    flex: 0 0 auto;
    background: none;
    border: none;
    color: #8ea2bd;
    font-size: 1.1rem;
    line-height: 1;
    cursor: pointer;
    padding: 0 2px;
  }
  .close:hover {
    color: #e6edf6;
  }
  .spin {
    display: inline-block;
    width: 11px;
    height: 11px;
    border: 2px solid #4c9aff;
    border-top-color: transparent;
    border-radius: 50%;
    vertical-align: -1px;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
