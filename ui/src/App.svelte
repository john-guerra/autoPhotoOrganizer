<script>
  // Placeholder page. Proves the dev loop: fetch /api/health through the Vite
  // proxy to the Express server on :4321.
  let health = "checking…";

  async function checkHealth() {
    try {
      const res = await fetch("/api/health");
      const data = await res.json();
      health = `${data.status} (server v${data.version})`;
    } catch (err) {
      health = `unreachable: ${err.message}`;
    }
  }

  checkHealth();
</script>

<main>
  <h1>AutoGallery v2</h1>
  <p>Fast, local-first photo triage — scaffold only.</p>
  <p class="health">API health: <strong>{health}</strong></p>
</main>

<style>
  main {
    font-family:
      system-ui,
      -apple-system,
      sans-serif;
    max-width: 40rem;
    margin: 4rem auto;
    padding: 0 1rem;
    color: #222;
  }
  h1 {
    font-weight: 600;
  }
  .health {
    color: #555;
  }
</style>
