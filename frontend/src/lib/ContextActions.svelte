<script lang="ts">
  import { ContextMenu } from "bits-ui";

  let { trigger, actions, disabled = false }: {
    trigger: NonNullable<ContextMenu.TriggerProps["child"]>;
    actions: { label: string; select: () => void; danger?: boolean }[];
    disabled?: boolean;
  } = $props();

  function openFromKeyboard(event: KeyboardEvent) {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    const target = event.target as HTMLElement;
    const rect = target.getBoundingClientRect();
    target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true,
      clientX: rect.left + 16, clientY: rect.bottom }));
  }
</script>

<ContextMenu.Root>
  <ContextMenu.Trigger child={trigger} disabled={disabled || !actions.length} onkeydown={openFromKeyboard} />
  <ContextMenu.Portal>
    <ContextMenu.Content class="context-menu" sideOffset={4}>
      {#each actions as action (action.label)}
        <ContextMenu.Item class="context-menu-item" data-danger={action.danger} onSelect={action.select}>
          {action.label}
        </ContextMenu.Item>
      {/each}
    </ContextMenu.Content>
  </ContextMenu.Portal>
</ContextMenu.Root>
