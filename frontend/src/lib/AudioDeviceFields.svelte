<script lang="ts">
  import SelectField from "#lib/components/SelectField.svelte";
  import AudioLevel from "./AudioLevel.svelte";
  import { getAudioSettings } from "./audio.svelte";

  let { direction }: { direction: "input" | "output" } = $props();
  const audio = getAudioSettings();
  const systemDefault = "System default";
  const defaultDeviceValue = "system-default";
  let label = $derived(direction === "input" ? "Microphone" : "Playback");
  let levelKey: "inputLevel" | "outputLevel" = $derived(direction === "input" ? "inputLevel" : "outputLevel");
  let devices = $derived(audio.devices?.[direction] ?? []);
  let selected = $derived(audio.profile[direction]);
  let unavailable = $derived(Boolean(selected && !devices.some(({ id }) => id === selected)));
  let disabled = $derived(!audio.available || audio.applying || audio.testing);

  let options = $derived.by(() => {
    const choices = [{ id: "", label: systemDefault, value: defaultDeviceValue, disabled: false }];
    if (unavailable) {
      const label = "Saved device unavailable";
      choices.push({ id: selected, label, value: `device:${selected}`, disabled: true });
    }
    const labels = new Set(choices.map(({ label }) => label));
    for (const device of devices) {
      let label = device.label;
      for (let number = 2; labels.has(label); number++) label = `${device.label} (${number})`;
      labels.add(label);
      choices.push({ id: device.id, label, value: `device:${device.id}`, disabled: false });
    }
    return choices;
  });
  let selectedValue = $derived(options.find(({ id }) => id === selected)?.value ?? defaultDeviceValue);

  function selectDevice(value: string) {
    const choice = options.find((option) => option.value === value);
    if (choice && !choice.disabled && choice.id !== selected) void audio.update(direction, choice.id);
  }
</script>

<div class="audio-fields">
  <SelectField label={`${label} device`} {options} disabled={disabled || (!devices.length && !selected)}
    bind:value={() => selectedValue, selectDevice} />
  {#if audio.devices && !devices.length}<small>The native engine uses the system default for this device.</small>{/if}
  {#if audio.devices && unavailable}<small>Using the system default until the saved device returns.</small>{/if}
  <AudioLevel setting={levelKey} label={direction === "input" ? "Input level (%)" : "Output level (%)"} />
</div>
