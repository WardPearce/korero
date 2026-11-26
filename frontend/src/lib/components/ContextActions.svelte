<script lang="ts">
  import * as ContextMenu from "#lib/components/ui/context-menu/index.js";
  import type { Snippet } from "svelte";

  type Action = { label: string; onSelect: () => void; disabled?: boolean };
  type TriggerEvents = {
    onkeydown?: (event: KeyboardEvent) => void;
    onclick?: (event: MouseEvent) => void;
    ondblclick?: () => void;
  };

  let { trigger, actions = [], content, disabled = false, openOnClick = false, onDoubleClick, onOpenChange }: {
    trigger: Snippet<[TriggerEvents]>;
    actions?: Action[];
    content?: Snippet;
    disabled?: boolean;
    openOnClick?: boolean;
    onDoubleClick?: () => void;
    onOpenChange?: (open: boolean) => void;
  } = $props();

  function openAtTrigger(target: EventTarget | null) {
    if (!(target instanceof HTMLElement)) return;
    const rect = target.getBoundingClientRect();
    target.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, clientX: rect.left + 16, clientY: rect.bottom,
    }));
  }

  function openFromKeyboard(event: KeyboardEvent) {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    openAtTrigger(event.target);
  }

  function openFromClick(event: MouseEvent) {
    if (onDoubleClick && event.detail > 0 && !(event instanceof PointerEvent && event.pointerType === "touch")) return;
    openAtTrigger(event.currentTarget);
  }
</script>

{#if disabled || (!actions.length && !content)}
  {@render trigger({})}
{:else}
  <div class="context-row">
    <ContextMenu.Root {onOpenChange}>
      <ContextMenu.Trigger>
        {@render trigger({ onkeydown: openFromKeyboard, onclick: openOnClick ? openFromClick : undefined, ondblclick: onDoubleClick })}
      </ContextMenu.Trigger>
      <ContextMenu.Content class="max-w-[calc(100vw-1rem)]">
        {#if content}
          {@render content()}
        {:else}
          {#each actions as action (action.label)}
            <ContextMenu.Item disabled={action.disabled} onSelect={action.onSelect}>{action.label}</ContextMenu.Item>
          {/each}
        {/if}
      </ContextMenu.Content>
    </ContextMenu.Root>
  </div>
{/if}
