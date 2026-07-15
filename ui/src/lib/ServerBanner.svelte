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
    reconnectAttempts,
    retryServerNow,
  } from "./serverHealth.js";
</script>

{#if $serverStatus === "down"}
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
