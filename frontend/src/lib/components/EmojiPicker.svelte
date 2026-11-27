<script lang="ts">
  import type { Snippet } from "svelte";
  import type { Picker } from "emoji-picker-element";
  import emojiData from "emoji-picker-element-data/en/github/data.json?url";
  import * as Popover from "#lib/components/ui/popover/index.js";

  let {
    open = $bindable(false),
    disabled = false,
    label = "Choose emoji",
    triggerClass,
    side = "top",
    align = "end",
    onpick,
    children,
  }: {
    open?: boolean;
    disabled?: boolean;
    label?: string;
    triggerClass?: string;
    side?: "top" | "bottom" | "left" | "right";
    align?: "start" | "center" | "end";
    onpick: (emoji: string) => void;
    children: Snippet;
  } = $props();

  function mountPicker(container: HTMLDivElement) {
    let mounted = true;
    let picker: Picker | undefined;
    void import("emoji-picker-element").then(({ Picker }) => {
      if (!mounted) return;
      picker = new Picker({ dataSource: emojiData });
      picker.addEventListener("emoji-click", ({ detail }) => {
        if (detail.unicode) onpick(detail.unicode);
      });
      container.replaceChildren(picker);
    }).catch(() => {
      if (mounted) container.textContent = "Could not load the emoji picker.";
    });
    return () => {
      mounted = false;
      picker?.remove();
    };
  }
</script>

<Popover.Root bind:open>
  <Popover.Trigger type="button" aria-label={label} title={label} {disabled} class={triggerClass}>
    {@render children()}
  </Popover.Trigger>
  <Popover.Content {side} {align} class="w-auto p-0" aria-label="Emoji picker">
    {#if open}<div class="picker" {@attach mountPicker}></div>{/if}
  </Popover.Content>
</Popover.Root>

<style>
  .picker :global(emoji-picker) {
    width: min(315px, calc(100vw - 24px));
    height: min(360px, 54dvh);
    --background: var(--popover);
    --border-color: var(--border);
    --button-hover-background: var(--control-hover);
    --indicator-color: var(--primary);
    --input-border-color: var(--input);
    --input-font-color: var(--popover-foreground);
    --category-font-color: var(--muted-foreground);
    --outline-color: var(--ring);
  }
</style>
