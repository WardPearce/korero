<script lang="ts">
  import { getAudioSettings } from "./audio.svelte";

  let { direction }: { direction: "input" | "output" } = $props();
  const audio = getAudioSettings();
  let label = $derived(direction === "input" ? "Microphone" : "Playback");
  let levelKey: "inputLevel" | "outputLevel" = $derived(direction === "input" ? "inputLevel" : "outputLevel");
  let devices = $derived(audio.devices?.[direction] ?? []);
  let selected = $derived(audio.profile[direction]);
  let unavailable = $derived(selected && !devices.some(({ id }) => id === selected));
  let disabled = $derived(!audio.available || audio.applying || audio.testing);
  let preview = $state<number | null>(null);
</script>

<div class="audio-fields">
  <label>
    {label} device
    <select value={selected} disabled={disabled || (!devices.length && !selected)}
      onchange={(event) => audio.update(direction, event.currentTarget.value)}>
      <option value="">System default</option>
      {#if unavailable}<option value={selected} disabled>Saved device unavailable</option>{/if}
      {#each devices as device (device.id)}
        <option value={device.id}>{device.label}</option>
      {/each}
    </select>
  </label>
  {#if audio.devices && !devices.length}<small>The native engine uses the system default for this device.</small>{/if}
  {#if audio.devices && unavailable}<small>Using the system default until the saved device returns.</small>{/if}
  <label>
    <span class="flex justify-between gap-2">{direction === "input" ? "Input level" : "Output level"} <span>{preview ?? audio.profile[levelKey]}%</span></span>
    <input type="range" min="0" max="100" value={audio.profile[levelKey]} disabled={disabled}
      oninput={(event) => { preview = event.currentTarget.valueAsNumber; }}
      onchange={async (event) => {
        const slider = event.currentTarget;
        await audio.update(levelKey, slider.valueAsNumber);
        preview = null;
        slider.valueAsNumber = audio.profile[levelKey];
      }} />
  </label>
</div>
