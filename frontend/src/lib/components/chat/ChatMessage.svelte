<script lang="ts">
  import type { Snippet } from "svelte";
  import Avatar from "#lib/components/Avatar.svelte";
  import { getChatDisplay } from "#lib/chat/chat-display";
  import { messageTime } from "#lib/connection/client";

  type MessageHeader = { senderId: string; createdAt: number };

  let { message, previous, name, children }: {
    message: MessageHeader;
    previous?: MessageHeader;
    name: string;
    children: Snippet;
  } = $props();

  const display = getChatDisplay();
  const compact = $derived(display.value.density === "compact");
  const elapsed = $derived(message.createdAt - (previous?.createdAt ?? message.createdAt));
  const grouped = $derived(display.value.groupMessages && previous?.senderId === message.senderId &&
    elapsed >= 0 && elapsed <= 5 * 60_000);
</script>

<article class={["chat-message", { compact, grouped, "with-avatar": display.value.showAvatars }]}>
  {#if display.value.showAvatars && !grouped}
    <Avatar {name} small={compact} />
  {/if}
  <div class="chat-content">
    <div class={["chat-meta", { "sr-only": grouped && !display.value.showTimestamps }]}>
      <strong class={grouped ? "sr-only" : undefined}>{name}</strong>
      {#if display.value.showTimestamps}
        <time datetime={new Date(message.createdAt).toISOString()}>{messageTime.format(message.createdAt)}</time>
      {/if}
    </div>
    <div class="chat-body">
      {@render children()}
    </div>
  </div>
</article>

<style>
  .chat-message {
    --chat-avatar-size: 2rem;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    align-items: start;
    gap: 10px;
    padding: calc(var(--ui-gap) * .55) var(--ui-gap);
  }
  .chat-message:hover { background: var(--control-hover); }
  .chat-message.compact {
    --chat-avatar-size: 1.5rem;
    gap: 6px;
    padding-block: calc(var(--ui-gap) * .2);
    line-height: 1.35;
  }
  .chat-message.with-avatar { grid-template-columns: var(--chat-avatar-size) minmax(0, 1fr); }
  .chat-content { grid-column: -2; min-width: 0; }
  .chat-meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 8px; }
  .chat-meta strong, .chat-body :global(p) { overflow-wrap: anywhere; }
  .chat-meta time { color: var(--muted-foreground); font-size: var(--type-small); }
  .chat-body { min-width: 0; }
  .chat-body :global(p) { white-space: pre-wrap; }
  .chat-message.grouped { padding-block-start: 0; }
  .grouped .chat-content:has(time) {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: baseline;
    column-gap: 8px;
  }
  .grouped .chat-meta { grid-column: 2; grid-row: 1; white-space: nowrap; }
  .grouped .chat-body { grid-column: 1; grid-row: 1; }
</style>
