<script lang="ts">
  import { ContextMenu } from "bits-ui";
  import type { Snippet } from "svelte";

  let { trigger, actions, menu, disabled = false, openOnClick = false }: {
    trigger: NonNullable<ContextMenu.TriggerProps["child"]>;
    actions: { label: string; select: () => void; danger?: boolean }[];
    menu?: Snippet;
    disabled?: boolean;
    openOnClick?: boolean;
  } = $props();

  function openFromKeyboard(event: KeyboardEvent) {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    openAtTrigger(event.target as HTMLElement);
  }

  function openAtTrigger(target: HTMLElement) {
    const rect = target.getBoundingClientRect();
    target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true,
      clientX: rect.left + 16, clientY: rect.bottom }));
  }
</script>

<ContextMenu.Root>
  <ContextMenu.Trigger child={trigger} disabled={disabled || (!actions.length && !menu)} onkeydown={openFromKeyboard}
    onclick={openOnClick ? (event) => openAtTrigger(event.currentTarget) : undefined} />
  <ContextMenu.Portal>
    <ContextMenu.Content class="context-menu" sideOffset={4}>
      {#each actions as action (action.label)}
        <ContextMenu.Item class="context-menu-item" data-danger={action.danger} onSelect={action.select}>
          {action.label}
        </ContextMenu.Item>
      {/each}
      {@render menu?.()}
    </ContextMenu.Content>
  </ContextMenu.Portal>
</ContextMenu.Root>
