<script lang="ts">
  import { Tooltip } from "bits-ui";
  import type { Snippet } from "svelte";

  let {
    label,
    children,
    onclick,
    disabled = false,
    active,
    class: classes = "",
  }: {
    label: string;
    children: Snippet;
    onclick?: () => void;
    disabled?: boolean;
    active?: boolean;
    class?: string;
  } = $props();
</script>

<Tooltip.Root>
  <Tooltip.Trigger
    aria-label={label}
    aria-pressed={active}
    {onclick}
    {disabled}
    class="icon-button {classes}"
  >
    {@render children()}
  </Tooltip.Trigger>
  <Tooltip.Portal>
    <Tooltip.Content class="tooltip" sideOffset={8}>{label}</Tooltip.Content>
  </Tooltip.Portal>
</Tooltip.Root>
