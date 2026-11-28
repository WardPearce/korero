<script lang="ts">
  import { CornerUpLeft, Pin, SmilePlus } from "@lucide/svelte";
  import { swipeable, type SwipeEndEventDetail } from "@svelte-put/swipeable";
  import type { Snippet } from "svelte";
  import Avatar from "#lib/components/Avatar.svelte";
  import { getChatDisplay } from "#lib/chat/chat-display";
  import EmojiPicker from "#lib/components/EmojiPicker.svelte";
  import Modal from "#lib/components/Modal.svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import * as ContextMenu from "#lib/components/ui/context-menu/index.js";
  import { messageFrom, messageTime, type MessageReaction, type ReplyPreview } from "#lib/connection/client";

  type MessageHeader = { senderId: string; createdAt: number; editedAt?: number | null };

  let { message, messageId, highlighted = false, mentioned = false, pinned = false, previous, name, showProfilePicture = true, editText, editLimit = 2000,
    replyTo, replyName, onopenreply, reactions = [], onreact, onreply, onedit, ondelete, onpin, children }: {
    message: MessageHeader;
    messageId?: string;
    highlighted?: boolean;
    /** The message mentions the reader or one of their roles. */
    mentioned?: boolean;
    pinned?: boolean;
    replyTo?: ReplyPreview | { id: string; missing: true };
    /** Current display name of the replied-to sender. */
    replyName?: string;
    onopenreply?: () => void;
    reactions?: MessageReaction[];
    /** Adds or removes the reader's reaction. Reactions are read-only without it. */
    onreact?: (emoji: string, reacted: boolean) => void;
    onreply?: () => void;
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
  let reactionPickerOpen = $state(false);
  const canEdit = $derived(editText !== undefined && Boolean(onedit));
  const hasActions = $derived(canEdit || Boolean(ondelete) || Boolean(onpin) || Boolean(onreply) || Boolean(onreact));
  const missingReply = $derived(replyTo !== undefined && "missing" in replyTo);
  const reply = $derived(replyTo && !("missing" in replyTo) ? replyTo : undefined);

  /** Swipe-to-reply is for touch screens; with a mouse, dragging a message selects its text. */
  const touchScreen = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  const swipeReply = $derived(touchScreen && Boolean(onreply) && !editing);
  /** How far left a message must travel to reply; the reply icon is fully revealed at this point. */
  const replySwipeDistance = 56;
  let settling = $state(false);

  function settleSwipe(node: HTMLElement) {
    settling = true;
    node.style.setProperty("--swipe-distance-x", "0px");
    setTimeout(() => { settling = false; }, 180);
  }

  function swipeEnded(event: CustomEvent<SwipeEndEventDetail>) {
    // Without follow-through the library leaves the message where the finger lifted.
    settleSwipe(event.currentTarget as HTMLElement);
    if (!event.detail.passThreshold || !onreply) return;
    navigator.vibrate?.(10);
    onreply();
  }

  function toggleReaction(emoji: string) {
    reactionPickerOpen = false;
    const current = reactions.find((reaction) => reaction.emoji === emoji);
    onreact?.(emoji, !current?.me);
  }

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
    elapsed >= 0 && elapsed <= 5 * 60_000 && !replyTo);
</script>

{#snippet article(props: Record<string, unknown> = {})}
  <article {...props} id={messageId && `chat-message-${messageId}`}
    class={["chat-message", { compact, grouped, highlighted, mentioned, settling, "with-avatar": display.value.showAvatars, "swipe-reply": swipeReply }]}
    style:--reply-swipe-distance="{replySwipeDistance}px"
    use:swipeable={{ direction: "left", threshold: `${replySwipeDistance}px`, followThrough: false, disableTouchEvents: false, enabled: swipeReply }}
    onswipeend={swipeEnded} onpointercancel={(event) => { if (swipeReply) settleSwipe(event.currentTarget); }}>
    {#if swipeReply}
      <span class="chat-swipe-reply" aria-hidden="true"><CornerUpLeft size={18} /></span>
    {/if}
    {#if replyTo}
      <div class="chat-reply">
        {#if display.value.showAvatars}
          <span class="chat-reply-spine" aria-hidden="true"></span>
        {:else}
          <CornerUpLeft size={13} aria-hidden="true" />
        {/if}
        {#if reply}
          <button type="button" class="chat-reply-target" disabled={!onopenreply} onclick={onopenreply}
            aria-label={`Replying to ${replyName ?? reply.senderName}: ${reply.text || reply.attachmentName || "attachment"}. Open original message`}>
            {#if display.value.showAvatars}
              <span class="chat-reply-avatar"><Avatar name={replyName ?? reply.senderName} accountId={reply.senderId} small /></span>
            {/if}
            <strong>{replyName ?? reply.senderName}</strong>
            <span class="chat-reply-text truncate">{reply.text || reply.attachmentName || "Attachment"}</span>
          </button>
        {:else if missingReply}
          <span class="chat-reply-missing">Original message unavailable</span>
        {/if}
      </div>
    {/if}
    {#if display.value.showAvatars && !grouped}
      <Avatar {name} accountId={showProfilePicture ? message.senderId : undefined} small={compact} />
    {/if}
    <div class="chat-content">
      <div class={["chat-meta", { "sr-only": grouped && !display.value.showTimestamps && !pinned }]}>
        <strong class={grouped ? "sr-only" : undefined}>{name}</strong>
        {#if pinned}
          <span class="chat-pin-tag"><Pin size={11} strokeWidth={2.5} aria-hidden="true" />Pinned</span>
        {/if}
        {#if display.value.showTimestamps}
          <time datetime={new Date(message.createdAt).toISOString()}>{messageTime.format(message.createdAt)}</time>
        {/if}
      </div>
      <div class="chat-body">
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
      {#if reactions.length || reactionPickerOpen}
        <div class="chat-reactions" role="group" aria-label="Reactions">
          {#each reactions as reaction (reaction.emoji)}
            <button type="button" class="chat-reaction" aria-pressed={reaction.me} disabled={!onreact}
              aria-label={`${reaction.emoji} ${reaction.count} ${reaction.count === 1 ? "reaction" : "reactions"}${reaction.me ? ", including yours" : ""}`}
              onclick={() => toggleReaction(reaction.emoji)}>
              <span aria-hidden="true">{reaction.emoji}</span><span aria-hidden="true">{reaction.count}</span>
            </button>
          {/each}
          {#if onreact}
            <EmojiPicker bind:open={reactionPickerOpen} label="Add reaction" side="top" align="start" triggerClass="chat-reaction add-reaction"
              onpick={(emoji) => toggleReaction(emoji)}>
              <SmilePlus size={14} aria-hidden="true" />
            </EmojiPicker>
          {/if}
        </div>
      {/if}
    </div>
  </article>
{/snippet}

{#if hasActions && !editing}
  <ContextMenu.Root>
    <ContextMenu.Trigger class="select-text">
      {#snippet child({ props })}{@render article(props)}{/snippet}
    </ContextMenu.Trigger>
    <ContextMenu.Content class="max-w-[calc(100vw-1rem)]">
      {#if onreply}<ContextMenu.Item onSelect={onreply}>Reply</ContextMenu.Item>{/if}
      {#if onreact}<ContextMenu.Item onSelect={() => { reactionPickerOpen = true; }}>Add reaction</ContextMenu.Item>{/if}
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
  .chat-message.mentioned { background: color-mix(in srgb, var(--primary) 9%, transparent); box-shadow: inset 3px 0 color-mix(in srgb, var(--primary) 70%, transparent); }
  .chat-message.mentioned:hover { background: color-mix(in srgb, var(--primary) 14%, transparent); }
  .chat-reply {
    grid-column: 1 / -1;
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    margin-bottom: -2px;
    color: var(--muted-foreground);
    font-size: var(--type-small);
  }
  .chat-message.with-avatar .chat-reply { padding-inline-start: calc(var(--chat-avatar-size) + 10px); }
  .chat-message.compact.with-avatar .chat-reply { padding-inline-start: calc(var(--chat-avatar-size) + 6px); }
  /* An elbow from above the sender's avatar to the quoted message. */
  .chat-reply-spine {
    position: absolute;
    top: 50%;
    left: calc(var(--chat-avatar-size) / 2);
    width: calc(var(--chat-avatar-size) / 2 + 4px);
    height: calc(50% + 6px);
    border-top: 2px solid color-mix(in srgb, var(--muted-foreground) 45%, transparent);
    border-left: 2px solid color-mix(in srgb, var(--muted-foreground) 45%, transparent);
    border-top-left-radius: 6px;
  }
  .chat-reply :global(svg) { flex: none; }
  .chat-reply-target {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    color: inherit;
    text-align: start;
  }
  .chat-reply-target:not(:disabled) { cursor: pointer; }
  .chat-reply-target:not(:disabled):hover .chat-reply-text { color: var(--foreground); }
  .chat-reply-avatar { flex: none; display: inline-flex; }
  .chat-reply-avatar :global(.member-avatar), .chat-reply-avatar :global([data-slot="avatar"]) { width: 1rem; height: 1rem; font-size: .5rem; }
  .chat-reply-target strong { flex: none; color: var(--foreground); font-weight: 600; opacity: .85; }
  .chat-reply-text { color: color-mix(in srgb, var(--foreground) 70%, transparent); }
  .chat-reply-missing { font-style: italic; }
  .chat-reactions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
  .chat-reactions :global(.chat-reaction) {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-height: 1.6rem;
    padding: 0 7px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--card);
    font-size: var(--type-small);
    font-variant-numeric: tabular-nums;
  }
  .chat-reactions :global(.chat-reaction:not(:disabled):hover) { background: var(--control-hover); }
  .chat-reactions :global(.chat-reaction[aria-pressed="true"]) {
    border-color: color-mix(in srgb, var(--primary) 60%, transparent);
    background: color-mix(in srgb, var(--primary) 16%, transparent);
    color: var(--primary);
  }
  .chat-reactions :global(.add-reaction) { color: var(--muted-foreground); }
  /* Swipe left to reply: the message slides with the finger and reveals a reply icon at the right edge. */
  .chat-message.swipe-reply {
    --reply-swipe-offset: clamp(calc(-1 * var(--reply-swipe-distance)), var(--swipe-distance-x, 0px), 0px);
    position: relative;
    overflow-x: clip;
    touch-action: pan-y;
  }
  .chat-message.swipe-reply > :not(.chat-swipe-reply) { transform: translateX(var(--reply-swipe-offset)); }
  .chat-swipe-reply {
    position: absolute;
    top: 50%;
    right: 12px;
    display: grid;
    place-items: center;
    width: 2rem;
    height: 2rem;
    border-radius: 999px;
    background: color-mix(in srgb, var(--primary) 20%, transparent);
    color: var(--primary);
    transform: translate(calc(var(--reply-swipe-distance) + 12px + var(--reply-swipe-offset)), -50%);
    pointer-events: none;
  }
  .chat-message.settling > *, .chat-message.settling .chat-swipe-reply { transition: transform 180ms ease-out; }
  @media (prefers-reduced-motion: reduce) {
    .chat-message.settling > *, .chat-message.settling .chat-swipe-reply { transition: none; }
  }
  .chat-message.compact {
    --chat-avatar-size: 1.5rem;
    gap: 6px;
    padding-block: calc(var(--ui-gap) * .2);
    line-height: 1.35;
  }
  .chat-message.with-avatar { grid-template-columns: var(--chat-avatar-size) minmax(0, 1fr); }
  .chat-content { grid-column: -2; min-width: 0; }
  .chat-pin-tag {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    align-self: center;
    padding: 0 6px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--primary) 20%, transparent);
    color: var(--primary);
    font-size: var(--type-small);
    font-weight: 600;
    line-height: 1.5;
  }
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
