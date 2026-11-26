<script lang="ts">
  import { Button } from "gridworkdesign";
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

<Button type="button" aria-label={label} title={label} aria-pressed={active} {onclick} {disabled} class="icon-button {classes}">
  {@render children()}
</Button>
