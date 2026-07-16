<script>
  // Scroll / prefetch settings. Visual controls over the predictive-prefetch
  // policy that the benchmark (prefetchPolicy.bench.test.js) scores, plus the
  // adaptive page-size toggle. Presentational: it binds to state owned by
  // App.svelte and never touches the network itself. Built on the shared Modal;
  // the comma key that opens it is owned by App.svelte's onKeydown.
  import Modal from "./Modal.svelte";
  import {
    PREFETCH_PRESETS,
    PREFETCH_KNOBS,
    normalizePrefetch,
  } from "./prefetchPolicy.js";

  let {
    onclose,
    preset = $bindable(),
    custom = $bindable(),
    adaptivePageSize = $bindable(),
    scrubberAxis = $bindable(),
  } = $props();

  const close = () => onclose?.();
  const presetNames = [...Object.keys(PREFETCH_PRESETS), "custom"];
  const presetLabels = {
    off: "Off — no prefetch (pre-2.16.4)",
    baseline: "Baseline — unbounded (2.16.4)",
    balanced: "Balanced — recommended",
    conservative: "Conservative — slow disks / huge libraries",
    custom: "Custom — tune below",
  };

  // The effective config the app is running with, for the read-out and as the
  // seed when the user switches to Custom.
  const effective = $derived(
    preset === "custom"
      ? normalizePrefetch(custom)
      : (PREFETCH_PRESETS[preset] ?? PREFETCH_PRESETS.balanced)
  );

  // Editing a knob switches the preset to Custom (seeded from whatever was
  // active), so the change actually takes effect instead of being ignored.
  function editKnob(key, value) {
    const base = preset === "custom" ? custom : effective;
    const next = { ...base, [key]: value };
    custom = next;
    preset = "custom";
  }

  // What Custom shows on its sliders: the live custom object once selected, else
  // the currently-active preset (so switching to Custom keeps the same feel).
  const shown = $derived(
    preset === "custom" ? normalizePrefetch(custom) : effective
  );
  // inFlightCap === Infinity ("unlimited") maps to the slider's max.
  const sliderVal = (k) =>
    k.key === "inFlightCap" && shown.inFlightCap === Infinity
      ? k.max
      : shown[k.key];
</script>

<Modal open={true} title="Scrolling & prefetch" size="md" onclose={close}>
  <div class="settings">
    <section>
      <h3>Load-ahead</h3>
      <label class="toggle">
        <input type="checkbox" bind:checked={adaptivePageSize} />
        <span>
          Adaptive load-ahead
          <small
            >Fetch a full screen-plus of photos per load (instead of a fixed 60)
            and keep a scroll reserve below the loaded rows, so a fast fling at
            small thumbnails doesn't outrun the loader or stop dead at a false
            "end of page." The fix for "I reach the end before it loads more."</small
          >
        </span>
      </label>
    </section>

    <section>
      <h3>Scrubber rail</h3>
      <label class="preset">
        <span>Position axis</span>
        <select bind:value={scrubberAxis}>
          <option value="count">By photo count (tracks scroll)</option>
          <option value="value">By sort value (date &amp; numeric)</option>
        </select>
      </label>
      <small
        >Count keeps the thumb tracking your scroll; a busy month takes more
        rail. Value spaces landmarks by the sort value (like the top timeline)
        and shows a date "scent" — it falls back to count for folder/categorical
        grouping.</small
      >
    </section>

    <section>
      <h3>Predictive prefetch</h3>
      <label class="preset">
        <span>Strategy</span>
        <select bind:value={preset}>
          {#each presetNames as name}
            <option value={name}>{presetLabels[name] ?? name}</option>
          {/each}
        </select>
      </label>

      <div class="knobs" class:dim={!effective.enabled && preset !== "custom"}>
        {#each PREFETCH_KNOBS as k}
          {#if k.kind === "toggle"}
            <label class="toggle">
              <input
                type="checkbox"
                checked={!!shown[k.key]}
                onchange={(e) => editKnob(k.key, e.currentTarget.checked)}
              />
              <span>{k.label}<small>{k.hint}</small></span>
            </label>
          {:else}
            <label class="range">
              <span class="range-head">
                {k.label}
                <b
                  >{sliderVal(
                    k
                  )}{#if k.key === "inFlightCap" && shown.inFlightCap === Infinity}<span
                      class="inf"
                    >
                      (∞)</span
                    >{/if}</b
                >
              </span>
              <input
                type="range"
                min={k.min}
                max={k.max}
                step={k.step}
                value={sliderVal(k)}
                oninput={(e) => editKnob(k.key, Number(e.currentTarget.value))}
              />
              <small>{k.hint}</small>
            </label>
          {/if}
        {/each}
      </div>
    </section>
  </div>

  {#snippet footer()}
    <span
      >Changes apply live to the grid you're scrolling. Press <kbd>,</kbd> anytime
      to reopen.</span
    >
  {/snippet}
</Modal>

<style>
  .settings {
    display: flex;
    flex-direction: column;
    gap: 1.1rem;
    min-width: 340px;
  }
  section h3 {
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #8ab4ff;
    margin: 0 0 0.5rem;
  }
  .preset {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-bottom: 0.75rem;
  }
  .preset span {
    color: #cfcfcf;
    font-size: 0.85rem;
  }
  select {
    flex: 1;
    background: #2c2c2c;
    color: #f0f0f0;
    border: 1px solid #444;
    border-radius: 5px;
    padding: 4px 6px;
    font-size: 0.85rem;
  }
  .knobs {
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
    transition: opacity 0.15s ease;
  }
  .knobs.dim {
    opacity: 0.45;
  }
  .toggle {
    display: flex;
    align-items: flex-start;
    gap: 0.55rem;
    cursor: pointer;
  }
  .toggle input {
    margin-top: 2px;
  }
  .toggle span,
  .range-head {
    color: #e6e6e6;
    font-size: 0.85rem;
  }
  small {
    display: block;
    color: #8f8f8f;
    font-size: 0.75rem;
    margin-top: 2px;
    line-height: 1.3;
  }
  .range {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .range-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }
  .range-head b {
    color: #8ab4ff;
    font:
      600 0.8rem/1 ui-monospace,
      SFMono-Regular,
      Menlo,
      monospace;
  }
  .inf {
    color: #777;
  }
  input[type="range"] {
    width: 100%;
    accent-color: #8ab4ff;
  }
  kbd {
    display: inline-block;
    padding: 1px 5px;
    background: #2c2c2c;
    border: 1px solid #444;
    border-bottom-width: 2px;
    border-radius: 4px;
    font:
      600 0.75rem/1 ui-monospace,
      SFMono-Regular,
      Menlo,
      monospace;
    color: #f0f0f0;
  }
</style>
