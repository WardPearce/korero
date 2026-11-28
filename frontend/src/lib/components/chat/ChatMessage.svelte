<script lang="ts">
  import { Pin } from "@lucide/svelte";
  import type { Snippet } from "svelte";
  import Avatar from "#lib/components/Avatar.svelte";
  import { getChatDisplay } from "#lib/chat/chat-display";
  import Modal from "#lib/components/Modal.svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import * as ContextMenu from "#lib/components/ui/context-menu/index.js";
  import { messageFrom, messageTime } from "#lib/connection/client";

  type MessageHeader = { senderId: string; createdAt: number; editedAt?: number | null };

  let { message, messageId, highlighted = false, pinned = false, previous, name, showProfilePicture = true, editText, editLimit = 2000, onedit, ondelete, onpin, children }: {
    message: MessageHeader;
    messageId?: string;
    highlighted?: boolean;
    pinned?: boolean;
    previous?: MessageHeader;
    name: string;
    showProfilePicture?: boolean;
    /** Plain text to start from when editing. Editing is available when this and `onedit` are set. */
    editText?: string;
    editLimit?: number;
    onedit?: (text: string) => Promise<void>;
    ondelete?: () => Promise<void>;
    onpin?: () => void;
    children: Snippet;
  } = $props();

  let editing = $state(false);
  let draft = $state("");
  let confirmingDelete = $state(false);
  let busy = $state(false);
  let error = $state("");
  const canEdit = $derived(editText !== undefined && Boolean(onedit));
  const hasActions = $derived(canEdit || Boolean(ondelete) || Boolean(onpin));

  function startEditing() {
    draft = editText ?? "";
    error = "";
    editing = true;
  }

  async function saveEdit(event: SubmitEvent) {
    event.preventDefault();
    if (busy || !onedit) return;
    if (draft === editText) { editing = false; return; }
    busy = true;
    error = "";
    try {
      await onedit(draft);
      editing = false;
    } catch (cause) {
      error = messageFrom(cause);
    } finally {
      busy = false;
    }
  }

  function editKeys(event: KeyboardEvent) {
    if (event.key === "Escape") { event.preventDefault(); editing = false; }
    else if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      (event.currentTarget as HTMLElement).closest("form")?.requestSubmit();
    }
  }

  async function confirmDelete() {
    if (busy || !ondelete) return;
    busy = true;
    error = "";
    try {
      await ondelete();
      confirmingDelete = false;
    } catch (cause) {
      error = messageFrom(cause);
    } finally {
      busy = false;
    }
  }

  function focusField(field: HTMLTextAreaElement) {
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }

  const display = getChatDisplay();
  const compact = $derived(display.value.density === "compact");
  const elapsed = $derived(message.createdAt - (previous?.createdAt ?? message.createdAt));
  const grouped = $derived(display.value.groupMessages && previous?.senderId === message.senderId &&
    elapsed >= 0 && elapsed <= 5 * 60_000);
</script>

{#snippet article(props: Record<string, unknown> = {})}
  <article {...props} id={messageId && `chat-message-${messageId}`}
    class={["chat-message", { compact, grouped, highlighted, "with-avatar": display.value.showAvatars }]}>
    {#if display.value.showAvatars && !grouped}
      <Avatar {name} accountId={showProfilePicture ? message.senderId : undefined} small={compact} />
    {/if}
    <div class="chat-content">
      <div class={["chat-meta", { "sr-only": grouped && !display.value.showTimestamps }]}>
        <strong class={grouped ? "sr-only" : undefined}>{name}</strong>
        {#if display.value.showTimestamps}
          <time datetime={new Date(message.createdAt).toISOString()}>{messageTime.format(message.createdAt)}</time>
        {/if}
      </div>
      <div class="chat-body">
        {#if pinned}
          <span class="mb-0.5 flex items-center gap-1 text-xs text-muted-foreground"><Pin size={12} aria-hidden="true" /> Pinned</span>
        {/if}
        {#if editing}
          <form class="chat-edit" onsubmit={saveEdit}>
            <textarea bind:value={draft} {@attach focusField} onkeydown={editKeys} rows="2" maxlength={editLimit}
              aria-label="Edit message" disabled={busy}></textarea>
            {#if error}<p class="form-error" role="alert">{error}</p>{/if}
            <div class="chat-edit-actions">
              <span class="text-muted-foreground">Escape to cancel, Enter to save</span>
              <Button type="button" variant="outline" size="sm" disabled={busy} onclick={() => { editing = false; }}>Cancel</Button>
              <Button type="submit" size="sm" disabled={busy || !draft.trim()}>{busy ? "Saving…" : "Save"}</Button>
            </div>
          </form>
        {:else}
          {@render children()}
          {#if message.editedAt}
            <span class="chat-edited text-muted-foreground" title={`Edited ${new Date(message.editedAt).toLocaleString()}`}>(edited)</span>
          {/if}
        {/if}
      </div>
    </div>
  </article>
{/snippet}

{#if hasActions && !editing}
  <ContextMenu.Root>
    <ContextMenu.Trigger class="select-text">
      {#snippet child({ props })}{@render article(props)}{/snippet}
    </ContextMenu.Trigger>
    <ContextMenu.Content class="max-w-[calc(100vw-1rem)]">
      {#if canEdit}<ContextMenu.Item onSelect={startEditing}>Edit message</ContextMenu.Item>{/if}
      {#if onpin}
        <ContextMenu.Item disabled={busy} onSelect={onpin}>{pinned ? "Unpin message" : "Pin message"}</ContextMenu.Item>
      {/if}
      {#if ondelete}
        <ContextMenu.Item variant="destructive" onSelect={() => { error = ""; confirmingDelete = true; }}>Delete message</ContextMenu.Item>
      {/if}
    </ContextMenu.Content>
  </ContextMenu.Root>
{:else}
  {@render article()}
{/if}
{#if ondelete}
  <Modal bind:open={confirmingDelete} title="Delete message?" description="This permanently deletes the message for everyone in the conversation." dismissible={!busy}>
    {#if error}<p class="form-error" role="alert">{error}</p>{/if}
    <div class="dialog-actions">
      <Button variant="outline" disabled={busy} onclick={() => { confirmingDelete = false; }}>Cancel</Button>
      <Button variant="destructive" disabled={busy} onclick={confirmDelete}>{busy ? "Deleting…" : "Delete"}</Button>
    </div>
  </Modal>
{/if}

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
  .chat-message.highlighted { background: var(--control-hover); box-shadow: inset 3px 0 var(--primary); }
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
  .chat-edited { font-size: var(--type-small); user-select: none; }
  .chat-edit { display: grid; gap: 6px; }
  .chat-edit textarea { width: 100%; resize: vertical; min-height: 2.5rem; padding: 6px 8px; border: 1px solid var(--border);
    border-radius: 6px; background: var(--background); color: inherit; font: inherit; }
  .chat-edit-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; font-size: var(--type-small); }
  .chat-edit-actions span { margin-right: auto; }
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
