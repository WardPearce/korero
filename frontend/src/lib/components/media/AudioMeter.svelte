<script lang="ts">
  let { level, threshold, active = false, label }: {
    level: number;
    /** Draws a cutoff marker when the meter is tied to a voice activity threshold. */
    threshold?: number;
    active?: boolean;
    label: string;
  } = $props();

  let clampedLevel = $derived(Math.min(100, Math.max(0, level)));
  let clampedThreshold = $derived(threshold === undefined ? undefined : Math.min(100, Math.max(0, threshold)));
</script>

<div
  class="audio-meter"
  class:active
  style={`--level: ${clampedLevel}%; --threshold: ${clampedThreshold ?? 0}%`}
  role="meter"
  aria-label={label}
  aria-valuemin={0}
  aria-valuemax={100}
  aria-valuenow={Math.round(clampedLevel)}
>
  <div class="audio-meter-track"><div class="audio-meter-fill"></div></div>
  {#if clampedThreshold !== undefined}
    <div class="audio-meter-cutoff" title={`Cutoff at ${clampedThreshold}%`}></div>
  {/if}
</div>

<style>
  .audio-meter { position: relative; height: 10px; }
  .audio-meter-track {
    position: absolute;
    inset: 0;
    overflow: hidden;
    border-radius: 999px;
    background: color-mix(in srgb, var(--border) 65%, var(--muted));
  }
  .audio-meter-fill {
    position: absolute;
    inset-block: 0;
    inset-inline-start: 0;
    width: var(--level);
    border-radius: inherit;
    background: var(--warning);
    transition: width 60ms linear, background-color 120ms linear;
  }
  .audio-meter.active .audio-meter-fill { background: var(--success); }
  .audio-meter-cutoff {
    position: absolute;
    inset-block: -3px;
    inset-inline-start: calc(var(--threshold) - 1.5px);
    width: 3px;
    border-radius: 999px;
    background: var(--foreground);
    box-shadow: 0 0 0 2px var(--card);
    pointer-events: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .audio-meter-fill { transition: none; }
  }
</style>
