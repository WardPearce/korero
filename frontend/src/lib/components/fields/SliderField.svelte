<script lang="ts">
  import { Root as Slider } from "#lib/components/ui/slider/index.js";

  let { label, value = $bindable(25), min = 0, max = 100, step = 1, unit = "", disabled = false, variant = "default", level }: {
    label: string;
    value?: number;
    min?: number;
    max?: number;
    step?: number;
    unit?: string;
    disabled?: boolean;
    variant?: "default" | "threshold";
    level?: number;
  } = $props();

  const id = $props.id();
</script>

<div class="grid gap-1 text-sm">
  <div class="flex justify-between gap-2">
    <span {id}>{label}</span>
    <output>{value}{unit ? ` ${unit}` : ""}</output>
  </div>
  <Slider type="single" class="min-h-8" thumbLabelledBy={id} {min} {max} {step} {disabled} {variant} {level} bind:value />
</div>
