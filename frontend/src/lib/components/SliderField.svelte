<script lang="ts">
  import { Root as Slider } from "#lib/components/ui/slider/index.js";

  let { label, value = $bindable(25), min = 0, disabled = false }: {
    label: string;
    value?: number;
    min?: number;
    disabled?: boolean;
  } = $props();

  const id = $props.id();
</script>

<div class="grid gap-1 text-sm">
  <div class="flex justify-between gap-2">
    <span {id}>{label}</span>
    <output>{value}</output>
  </div>
  <Slider type="single" class="min-h-8" thumbLabelledBy={id} {min} max={100} step={1} {disabled} bind:value />
</div>
