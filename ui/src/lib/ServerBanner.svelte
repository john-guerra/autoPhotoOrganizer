<script>
  /**
   * "The backend is gone" banner. A dead/restarting server used to be invisible
   * — failed fetches went to the console and the UI just sat there showing stale
   * data. Now it says what happened, that it's retrying, and offers a manual
   * retry. Deliberately loud (top, full width): everything on screen is suspect
   * while this is up.
   */
  import {
    serverStatus,
    serverBusyWith,
    reconnectAttempts,
    retryServerNow,
  } from "./serverHealth.js";

  /** "Resetting the library" / "Resetting the library and 2 more". */
  const busyLabel = (running) =>
    running.length === 0
      ? "Something long-running"
      : running.length === 1
        ? running[0]
        : `${running[0]} and ${running.length - 1} more`;
</script>

<!-- BUSY is not an error, and must not look like one (#282). Amber, no
     alert role, no "Retry now" — there is nothing to retry and nothing is
     wrong; the server is doing what it was asked. Telling the user it is
     coming back is the entire content. -->
{#if $serverStatus === "busy"}
  <div class="server-busy" role="status">
    <span class="dot busy-dot" aria-hidden="true"></span>
    <span class="msg">
      <strong>{busyLabel($serverBusyWith)} is still running.</strong>
      The app will catch up on its own — nothing is lost, and you can watch or stop
      it in the jobs panel.
    </span>
  </div>
{:else if $serverStatus === "down"}
  <div class="server-down" role="alert">
    <span class="dot" aria-hidden="true"></span>
    <span class="msg">
      <strong>Lost the connection to the AutoGallery server.</strong>
      Photos, ratings and jobs can't be loaded or saved right now — what's on screen
      may be out of date.
      {#if $reconnectAttempts > 0}
        Reconnecting… (attempt {$reconnectAttempts})
      {/if}
    </span>
    <button class="retry" onclick={retryServerNow}>Retry now</button>
  </div>
{/if}

<style>
  .server-busy,
  .server-down {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 2000;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 14px;
    background: #5a1a1a;
    border-bottom: 1px solid #a33;
    color: #ffd7d7;
    font-size: 0.82rem;
  }
  /* Amber, not red: this is information, not a fault. */
  .server-busy {
    background: #4a3a12;
    border-bottom: 1px solid #8a6d1f;
    color: #ffeec2;
  }
  .busy-dot {
    background: #e9b949;
  }
  .dot {
    flex: 0 0 auto;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: #ff6b6b;
    animation: pulse 1.1s ease-in-out infinite;
  }
  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.25;
    }
  }
  .msg {
    flex: 1;
    min-width: 0;
  }
  .msg strong {
    color: #fff;
  }
  .retry {
    flex: 0 0 auto;
    background: #7a2020;
    border: 1px solid #a33;
    color: #fff;
    border-radius: 5px;
    padding: 3px 10px;
    font-size: 0.78rem;
    cursor: pointer;
  }
  .retry:hover {
    background: #942828;
  }
</style>
