<script lang="ts" generics="Value extends string">
  import * as Select from "#lib/components/ui/select/index.js";

  let { label, options, value = $bindable(), placeholder = "Choose an option", disabled = false }: {
    label: string;
    options: readonly { value: Value; label: string; disabled?: boolean }[];
    value?: Value;
    placeholder?: string;
    disabled?: boolean;
  } = $props();

  const id = $props.id();
  const selectedLabel = $derived(options.find((option) => option.value === value)?.label);

  function changeValue(next: string) {
    const option = options.find((option) => option.value === next);
    if (option && !option.disabled) value = option.value;
  }
</script>

<div class="grid min-w-0 gap-1">
  <label for={id} class="text-sm font-medium">{label}</label>
  <Select.Root type="single" {disabled} items={[...options]}
    bind:value={() => value ?? "", changeValue}>
    <Select.Trigger {id} class="w-full min-w-0 text-left">
      <span class="truncate">{selectedLabel ?? placeholder}</span>
    </Select.Trigger>
    <Select.Content class="app-select-content" align="start">
      {#each options as option (option.value)}
        <Select.Item value={option.value} label={option.label} disabled={option.disabled}
          class="[&>span:last-child]:min-w-0 [&>span:last-child]:shrink [&>span:last-child]:whitespace-normal [&>span:last-child]:wrap-anywhere" />
      {/each}
    </Select.Content>
  </Select.Root>
</div>
