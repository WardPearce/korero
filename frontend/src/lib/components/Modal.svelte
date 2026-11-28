<script lang="ts">
  import { X } from "@lucide/svelte";
  import type { Snippet } from "svelte";
  import IconButton from "./IconButton.svelte";

  let {
    open = $bindable(false),
    title,
    description,
    children,
    icon,
    dismissible = true,
    class: className = "",
  }: {
    open: boolean;
    title: string;
    description: string;
    children: Snippet;
    icon?: Snippet;
    dismissible?: boolean;
    class?: string;
  } = $props();

  const id = $props.id();
  let pressedBackdrop = false;

  function syncDialog(dialog: HTMLDialogElement) {
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }

  function dismiss() {
    if (dismissible) open = false;
  }
</script>

<dialog {@attach syncDialog} class={["app-dialog", className]} aria-labelledby={id + "-title"} aria-describedby={id + "-description"}
  oncancel={(event) => { event.preventDefault(); dismiss(); }}
  onpointerdown={(event) => { pressedBackdrop = event.target === event.currentTarget; }}
  onclick={(event) => { if (pressedBackdrop && event.target === event.currentTarget) dismiss(); }}>
  <div class="dialog-body">
    <header class="dialog-heading">
      {#if icon}<div class="dialog-icon">{@render icon()}</div>{/if}
      <h2 id={id + "-title"}>{title}</h2>
      {#if dismissible}
        <IconButton label="Close dialog" onclick={dismiss}><X size={18} aria-hidden="true" /></IconButton>
      {/if}
    </header>
    <p id={id + "-description"} class="dialog-description">{description}</p>
    {@render children()}
  </div>
</dialog>
