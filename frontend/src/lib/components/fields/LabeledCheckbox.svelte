<script lang="ts">
  import { Checkbox } from "#lib/components/ui/checkbox/index.js";

  let { label, checked = $bindable(false), disabled = false }: {
    label: string;
    checked?: boolean;
    disabled?: boolean;
  } = $props();

  const id = $props.id();
</script>

<label for={id} class="check-control flex w-fit min-h-8 items-center gap-2 text-sm has-[:disabled]:opacity-60">
  <Checkbox {id} bind:checked {disabled} />
  <span>{label}</span>
</label>
