<script>
  /**
   * One tuning control: a slider you can drag and a number you can retype
   * (#327).
   *
   * BOTH, because neither alone works here. A bare `<input type="number">`
   * will not let you get from 5 to 50 by typing a 0 after the 5 — the browser
   * clamps on every keystroke, so the 0 lands on a value that is already at
   * the maximum and nothing happens. That is the annoyance that opened this
   * issue. A bare slider, meanwhile, cannot express an exact value.
   *
   * `oninput` fires continuously while dragging — the live preview listens to
   * it. `onchange` fires on release, and on the number field's commit — the
   * Apply path listens to that. A caller that wants only one uses only one.
   */
  let { spec, value, oninput, onchange } = $props();

  /** Never emit a value the schema would reject; `defaultParams` clamps too,
   *  but a control that shows an impossible number has already lied. */
  const clamp = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return spec.default;
    return Math.min(spec.max, Math.max(spec.min, n));
  };
</script>

<label class="tunable">
  <span class="tunable-name">{spec.label}</span>
  <span class="row">
    <input
      type="range"
      data-testid={`map-param-${spec.key}`}
      min={spec.min}
      max={spec.max}
      step={spec.step}
      {value}
      oninput={(e) => oninput?.(clamp(e.currentTarget.value))}
      onchange={(e) => onchange?.(clamp(e.currentTarget.value))}
    />
    <input
      class="num"
      type="number"
      data-testid={`map-param-${spec.key}-num`}
      min={spec.min}
      max={spec.max}
      step={spec.step}
      {value}
      onchange={(e) => onchange?.(clamp(e.currentTarget.value))}
    />
  </span>
  <span class="tunable-help">{spec.help}</span>
</label>

<style>
  .tunable {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .tunable-name {
    font-size: 0.85rem;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  input[type="range"] {
    flex: 1 1 auto;
    min-width: 0;
    accent-color: #7aa2f7;
  }
  .num {
    flex: 0 0 auto;
    width: 6ch;
    font: inherit;
    font-size: 0.85rem;
    background: #111;
    color: inherit;
    border: 1px solid #333;
    border-radius: 4px;
    padding: 2px 4px;
  }
  .tunable-help {
    font-size: 0.72rem;
    color: #888;
    line-height: 1.35;
  }
</style>
