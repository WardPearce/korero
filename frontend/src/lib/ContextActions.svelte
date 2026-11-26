<script lang="ts">
  import * as ContextMenu from "#lib/components/ui/context-menu/index.js";
  import type { Snippet } from "svelte";

  type Action = { label: string; onSelect: () => void; disabled?: boolean };
  type TriggerEvents = { onkeydown?: (event: KeyboardEvent) => void; onclick?: (event: MouseEvent) => void };

  let { trigger, actions, disabled = false, openOnClick = false }: {
    trigger: Snippet<[TriggerEvents]>;
    actions: Action[];
    disabled?: boolean;
    openOnClick?: boolean;
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
    openAtTrigger(event.currentTarget);
  }
</script>

{#if disabled || !actions.length}
  {@render trigger({})}
{:else}
  <div class="context-row">
    <ContextMenu.Root>
      <ContextMenu.Trigger>
        {@render trigger({ onkeydown: openFromKeyboard, onclick: openOnClick ? openFromClick : undefined })}
      </ContextMenu.Trigger>
      <ContextMenu.Content class="max-w-[calc(100vw-1rem)]">
        {#each actions as action (action.label)}
          <ContextMenu.Item disabled={action.disabled} onSelect={action.onSelect}>{action.label}</ContextMenu.Item>
        {/each}
      </ContextMenu.Content>
    </ContextMenu.Root>
  </div>
{/if}
