<script lang="ts">
  import { ContextMenu } from "gridworkdesign";
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
    <ContextMenu items={actions}>
      {@render trigger({ onkeydown: openFromKeyboard, onclick: openOnClick ? openFromClick : undefined })}
    </ContextMenu>
  </div>
{/if}
