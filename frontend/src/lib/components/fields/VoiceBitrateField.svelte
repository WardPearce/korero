<script lang="ts">
  import SelectField from "./SelectField.svelte";

  let { label, defaultLabel, defaultBitrate, savedBitrate, value = $bindable(), disabled = false }: {
    label: string;
    defaultLabel: string;
    defaultBitrate?: number;
    savedBitrate?: number | null;
    value: number | null;
    disabled?: boolean;
  } = $props();

  const presets = [32000, 64000, 128000];
  const options = $derived([
    { value: "default", label: defaultBitrate == null ? defaultLabel : `${defaultLabel} (${defaultBitrate / 1000} kbps)` },
    ...presets.map((bitrate) => ({ value: String(bitrate), label: `${bitrate / 1000} kbps` })),
    ...(savedBitrate != null && !presets.includes(savedBitrate)
      ? [{ value: String(savedBitrate), label: `${savedBitrate / 1000} kbps (current)` }]
      : []),
  ]);
</script>

<SelectField {label} {options} {disabled}
  bind:value={() => value == null ? "default" : String(value), (next) => { value = next === "default" ? null : Number(next); }} />
