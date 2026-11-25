<script lang="ts">
  import { Dialog } from "bits-ui";
  import { X } from "lucide-svelte";
  import type { Snippet } from "svelte";

  let {
    open = $bindable(false),
    title,
    description,
    children,
    icon,
    dismissible = true,
  }: {
    open: boolean;
    title: string;
    description: string;
    children: Snippet;
    icon?: Snippet;
    dismissible?: boolean;
  } = $props();
</script>

<Dialog.Root bind:open>
  <Dialog.Portal>
    <Dialog.Overlay class="dialog-overlay" />
    <Dialog.Content
      class="dialog-content"
      escapeKeydownBehavior={dismissible ? "close" : "ignore"}
      interactOutsideBehavior={dismissible ? "close" : "ignore"}
    >
      {#if icon}<div class="dialog-icon">{@render icon()}</div>{/if}
      {#if dismissible}
        <Dialog.Close class="icon-button dialog-close" aria-label="Close dialog"><X size={18} /></Dialog.Close>
      {/if}
      <Dialog.Title class="dialog-title">{title}</Dialog.Title>
      <Dialog.Description class="dialog-description">{description}</Dialog.Description>
      {@render children()}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
