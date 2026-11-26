<script lang="ts">
  import SliderField from "#lib/components/SliderField.svelte";
  import { getAudioSettings } from "./audio.svelte";

  let { setting, label, min = 0 }: {
    setting: "inputLevel" | "outputLevel" | "activityThreshold";
    label: string;
    min?: number;
  } = $props();

  const audio = getAudioSettings();
  let disabled = $derived(!audio.available || audio.applying || audio.testing);
  let preview = $state<number>();
  let pointer: number | undefined;

  function startDrag(event: PointerEvent) {
    if (!disabled && event.button === 0 && pointer === undefined) pointer = event.pointerId;
  }

  function finishDrag(event: PointerEvent) {
    if (event.pointerId !== pointer) return;
    pointer = undefined;
    if (event.type === "pointercancel") preview = undefined;
    else void commit();
  }

  function update(value: number) {
    preview = value;
    if (pointer === undefined) void commit();
  }

  async function commit() {
    if (preview !== undefined && preview !== audio.profile[setting]) await audio.update(setting, preview);
    preview = undefined;
  }
</script>

<svelte:window onpointerup={finishDrag} onpointercancel={finishDrag} />

<div class="audio-level" onpointerdowncapture={startDrag}>
  <SliderField {label} {min} {disabled} bind:value={() => preview ?? audio.profile[setting], update} />
</div>
