<script lang="ts">
  import { CircleAlert, Download, Headphones, MessageCircle, Pencil, PhoneOff, Pin } from "@lucide/svelte";
  import { tick } from "svelte";
  import ChatComposer from "#lib/components/chat/ChatComposer.svelte";
  import ChatMessage from "#lib/components/chat/ChatMessage.svelte";
  import RichMessage from "#lib/components/chat/RichMessage.svelte";
  import IconButton from "#lib/components/IconButton.svelte";
  import Modal from "#lib/components/Modal.svelte";
  import ScreenSharing from "#lib/components/media/ScreenSharing.svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import { downloadAttachment } from "#lib/chat/chat-attachments";
  import { maxChatTextLength } from "#lib/chat/rich-chat";
  import { channelMessageContext, channelPins, messageFrom, type Channel, type Message, type PinCursor, type PinnedMessagePage } from "#lib/connection/client";
  import { voiceApp } from "#lib/connection/platform";
  import { playUiSound } from "#lib/ui-sounds";
  import { getWorkspace } from "#lib/workspace";

  let { onjoin, onedit, footer }: {
    onjoin: (channel: Channel) => void;
    onedit: (channel: Channel) => void;
    footer: HTMLDivElement | undefined;
  } = $props();

  const workspace = getWorkspace();
  const voiceAvailable = voiceApp();
  const { run } = workspace;
  const view = $derived(workspace.view);
  const pending = $derived(workspace.pending);
  const actionError = $derived(workspace.actionError);
  let messageList: HTMLDivElement | undefined;
  let lastChatChannel: string | null | undefined;
  let lastLatestMessage: string | undefined;
  let knownMessageIds = new Set<string>();
  let initializedMessages = false;

  let snapshot = $derived(view.snapshot);
  let me = $derived(snapshot?.account);
  let online = $derived(view.phase === "online");
  let activeChannel = $derived(snapshot?.channels.find((channel) => channel.id === snapshot?.channelId));
  let currentChannel = $derived(snapshot?.channels.find((channel) => channel.id === workspace.selectedChannelId) ?? activeChannel ?? snapshot?.channels[0]);
  let isInRoom = $derived(Boolean(currentChannel && activeChannel?.id === currentChannel.id));
  // Servers without `canChat` only allow chat in the joined channel.
  let outsideChat = $derived(currentChannel?.canChat !== undefined);
  let canRead = $derived(online && (currentChannel?.canChat ?? isInRoom));
  let canChat = $derived(online && (currentChannel?.canChat ?? (isInRoom && snapshot?.canSendText !== false)));
  let messages = $derived(currentChannel ? view.messages.filter(({ channelId }) => channelId === currentChannel.id) : []);
  const origin = $derived(workspace.serverOrigin);
  const connectionId = $derived(snapshot?.connectionId);
  const channelId = $derived(currentChannel?.id);
  const supportsPins = $derived(currentChannel?.messagePins === true);
  const chatScope = $derived(canRead && supportsPins && connectionId && channelId
    ? { origin, connectionId, channelId } : null);
  type ChatScope = NonNullable<typeof chatScope>;
  const revision = $derived(channelId ? view.messageRevisions?.[channelId] ?? 0 : 0);
  let pinsFor = $state.raw<ChatScope | null>(null);
  const pinsOpen = $derived(chatScope !== null && pinsFor === chatScope);
  let pinPage = $state.raw<PinnedMessagePage | null>(null);
  let pinError = $state("");
  let loadingPins = $state(false);
  let jumpingTo = $state<string | null>(null);
  let pinRequest = 0;
  let history = $state.raw<{ scope: ChatScope; messageId: string; messages: Message[]; revision: number } | null>(null);
  const showingHistory = $derived(history !== null && history.scope === chatScope);
  const displayedMessages = $derived(showingHistory && history ? history.messages : messages);
  let highlight = $state.raw<{ scope: ChatScope; messageId: string } | null>(null);
  let unavailableHint = $derived(!outsideChat ? "Join a channel to read and send messages."
    : currentChannel?.passwordRequired && !isInRoom ? "Join this password-protected channel to read and send messages."
    : "Your role cannot read or send messages in this channel.");

  $effect(() => {
    const connectionId = snapshot?.connectionId;
    if (!online || !connectionId || !currentChannel || !outsideChat) return;
    workspace.viewChannel(connectionId, currentChannel.canChat ? currentChannel.id : null);
  });

  $effect.pre(() => {
    // Measure the old viewport before Svelte inserts messages.
    const channel = currentChannel?.id;
    const channelChanged = channel !== lastChatChannel;
    lastChatChannel = channel;
    const latestId = messages.at(-1)?.id;
    const latestChanged = latestId !== lastLatestMessage;
    lastLatestMessage = latestId;
    if (initializedMessages && !channelChanged && canRead) {
      // History arrives in bulk after switching channels. Only a single fresh arrival is a new message.
      const arrivals = messages.filter(({ id }) => !knownMessageIds.has(id));
      const latest = arrivals[0];
      if (arrivals.length === 1 && latest.id === latestId && latest.senderId !== me?.id && Date.now() - latest.createdAt < 15000) {
        playUiSound("message");
      }
    }
    knownMessageIds = new Set(messages.map(({ id }) => id));
    initializedMessages = true;
    if (!showingHistory && messages.length && messageList &&
      (channelChanged || (latestChanged && messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 90))) {
      void scrollMessages();
    }
  });

  $effect(() => {
    if (pinsOpen && chatScope) void loadPins(chatScope, revision);
  });

  $effect(() => {
    if (!showingHistory || !history || history.revision === revision) return;
    void refreshHistory(history, revision);
  });

  function attachMessageList(element: HTMLDivElement) {
    messageList = element;
    void scrollMessages();
    return () => {
      if (messageList === element) messageList = undefined;
    };
  }

  async function scrollMessages() {
    await tick();
    if (messageList) messageList.scrollTop = messageList.scrollHeight;
  }

  function setPinsOpen(open: boolean) {
    pinsFor = open ? chatScope : null;
    pinRequest++;
    pinPage = null;
    pinError = "";
    jumpingTo = null;
  }

  async function loadPins(scope: ChatScope, requestedRevision: number, before?: PinCursor) {
    const request = ++pinRequest;
    const current = () => pinsFor === scope && chatScope === scope && revision === requestedRevision && request === pinRequest;
    loadingPins = true;
    pinError = "";
    try {
      const page = await channelPins(scope.origin, scope.connectionId, scope.channelId, before);
      if (current()) pinPage = before && pinPage ? { ...page, messages: [...pinPage.messages, ...page.messages] } : page;
    } catch (cause) {
      if (current()) pinError = messageFrom(cause);
    } finally {
      if (current()) loadingPins = false;
    }
  }

  async function jumpToMessage(messageId: string) {
    const scope = chatScope;
    if (!scope || !pinsOpen || jumpingTo) return;
    jumpingTo = messageId;
    pinError = "";
    try {
      if (messages.some((entry) => entry.id === messageId)) {
        history = null;
      } else if (!displayedMessages.some((entry) => entry.id === messageId)) {
        const requestedRevision = revision;
        const entries = await channelMessageContext(scope.origin, scope.connectionId, scope.channelId, messageId);
        if (chatScope !== scope || !pinsOpen || jumpingTo !== messageId) return;
        history = { scope, messageId, messages: entries, revision: requestedRevision };
      }
      setPinsOpen(false);
      highlight = { scope, messageId };
      await tick();
      const target = document.getElementById(`chat-message-${messageId}`);
      if (chatScope === scope && target && messageList?.contains(target)) {
        target.tabIndex = -1;
        target.scrollIntoView({ block: "center" });
        target.focus({ preventScroll: true });
      }
    } catch (cause) {
      if (chatScope === scope && pinsOpen) pinError = messageFrom(cause);
    } finally {
      if (jumpingTo === messageId) jumpingTo = null;
    }
  }

  async function refreshHistory(current: NonNullable<typeof history>, requestedRevision: number) {
    const { scope, messageId } = current;
    try {
      const entries = await channelMessageContext(scope.origin, scope.connectionId, scope.channelId, messageId);
      if (history === current && chatScope === scope && revision === requestedRevision) {
        history = { ...current, messages: entries, revision: requestedRevision };
      }
    } catch (cause) {
      if (history === current && chatScope === scope && revision === requestedRevision) {
        workspace.actionError = messageFrom(cause);
        returnToLatest();
      }
    }
  }

  function returnToLatest() {
    history = null;
    highlight = null;
    void scrollMessages();
  }

  async function leaveChannel() {
    await run("leave", "leave_channel");
  }

  async function changeMessage(action: string, command: string, args: Record<string, unknown>) {
    workspace.actionError = "";
    if (!(await workspace.run(action, command, args))) throw new Error(workspace.actionError || "The request could not be completed.");
  }

  function senderName(id: string) {
    if (id === me?.id) return me.displayName;
    return snapshot?.presence.find((person) => person.accountId === id)?.displayName
      ?? snapshot?.members.find((person) => person.accountId === id)?.displayName ?? "Channel member";
  }
</script>

<header class="workspace-header">
  <div class="heading-icon"><MessageCircle size={19} /></div>
  <div class="flex-content">
    <div class="breadcrumb">Channel chat</div>
    <h2 class="truncate">{currentChannel?.name ?? "Chats"}</h2>
    {#if currentChannel?.description?.trim()}
      <p class="channel-description" title={currentChannel.description}>{currentChannel.description}</p>
    {/if}
  </div>
  {#if chatScope}
    <IconButton label="Pinned messages" onclick={() => setPinsOpen(true)}><Pin size={18} aria-hidden="true" /></IconButton>
  {/if}
  {#if currentChannel?.canEdit}
    <IconButton label="Edit channel" disabled={!online || Boolean(pending)} onclick={() => onedit(currentChannel)}><Pencil size={19} aria-hidden="true" /></IconButton>
  {/if}
  {#if currentChannel}
    <Button variant="outline" onclick={() => isInRoom ? leaveChannel() : onjoin(currentChannel)} disabled={!online || Boolean(pending)}>
      {#if isInRoom}<PhoneOff size={16} /> {voiceAvailable ? "Leave voice" : "Leave channel"}
      {:else}<Headphones size={16} /> {voiceAvailable ? "Join voice" : "Join channel"}{/if}
    </Button>
  {/if}
</header>

<div class="workspace chat-workspace">
  {#if online && snapshot?.motd}
    <details class="server-motd" open>
      <summary>Message of the day</summary>
      <p>{snapshot.motd}</p>
    </details>
  {/if}
  {#if actionError || view.error || view.voiceError}
    <div class="notice" role="status"><CircleAlert size={17} /><span>{actionError || view.error || view.voiceError}</span></div>
  {/if}
  {#if online && snapshot?.channelId && footer}
    {#key snapshot.connectionId + "/" + snapshot.channelId}
      <ScreenSharing {snapshot} controlsTarget={footer} visible={Boolean(activeChannel)} source="camera" />
    {/key}
  {/if}
  <div class="contents" bind:this={workspace.screenShareViewerTarget}></div>
  <section class="chat-pane" aria-label="Channel chat">
    {#if showingHistory}
      <div class="flex items-center justify-between gap-2 border-b border-border px-3 py-2 text-sm">
        <span>Earlier messages</span>
        <Button variant="outline" size="sm" onclick={returnToLatest}>Back to latest</Button>
      </div>
    {/if}
    <div class="chat-log" {@attach attachMessageList} role="log" aria-label="Channel messages">
      {#if canRead && displayedMessages.length}
        {#each displayedMessages as entry, index (entry.id)}
          {@const own = entry.senderId === me?.id}
          <ChatMessage message={entry} messageId={entry.id} pinned={Boolean(entry.pinnedAt)}
            highlighted={highlight !== null && highlight.scope === chatScope && highlight.messageId === entry.id}
            previous={displayedMessages[index - 1]} name={senderName(entry.senderId)}
            editText={own && canChat ? entry.text : undefined} editLimit={maxChatTextLength}
            onedit={own && canChat ? (text) => changeMessage("message-edit", "edit_message", { messageId: entry.id, text }) : undefined}
            onpin={currentChannel?.canPinMessages && !pending ? () => {
              void run("message-pin", "pin_message", { channelId: entry.channelId, messageId: entry.id, pinned: !entry.pinnedAt });
            } : undefined}
            ondelete={own || currentChannel?.canDeleteMessages
              ? () => changeMessage("message-delete", "delete_message", { messageId: entry.id }) : undefined}>
            <RichMessage text={entry.text} html={entry.html} />
            {#if entry.attachment && snapshot}
              {@const connectionId = snapshot.connectionId}
              <Button type="button" variant="outline" class="chat-attachment" disabled={!canChat || Boolean(pending)}
                onclick={() => workspace.runAction("attachment-download", () => downloadAttachment(workspace.serverOrigin, connectionId, entry))}>
                <Download size={15} /><span class="truncate">{entry.attachment.name}</span>
              </Button>
            {/if}
          </ChatMessage>
        {/each}
      {:else}
        <div class="chat-empty">
          <MessageCircle size={23} strokeWidth={1.5} />
          {#if view.phase === "offline" && !workspace.serverOrigin}
            <div><strong>No server connected</strong><p>Connect to a server to see its channels and messages.</p></div>
            <Button variant="outline" onclick={() => workspace.showConnect()}>Connect to a server</Button>
          {:else}
            <div><strong>{canRead ? "No messages yet" : "Channel messages appear here"}</strong><p>{canRead ? "Send a message to start the conversation." : unavailableHint}</p></div>
          {/if}
        </div>
      {/if}
    </div>
    {#key (snapshot?.connectionId ?? "") + "/" + (currentChannel?.id ?? "")}
      <ChatComposer channelId={currentChannel?.id ?? ""} channelName={currentChannel?.name ?? ""} enabled={canChat}
        disabledHint={outsideChat ? "You can't send messages here" : undefined} />
    {/key}
  </section>
</div>

<Modal bind:open={() => pinsOpen, setPinsOpen} title="Pinned messages" description={currentChannel?.name ?? ""}>
  {#if pinError}<p class="form-error" role="alert">{pinError}</p>{/if}
  {#if pinPage?.messages.length}
    <ul class="grid max-h-[min(55vh,28rem)] gap-2 overflow-auto p-1">
      {#each pinPage.messages as pin (pin.id)}
        <li class="grid gap-1 rounded-md border border-border p-3">
          <div class="flex flex-wrap items-baseline gap-x-2">
            <strong class="wrap-anywhere">{senderName(pin.senderId)}</strong>
            <time class="text-xs text-muted-foreground" datetime={new Date(pin.createdAt).toISOString()}>{new Date(pin.createdAt).toLocaleString()}</time>
          </div>
          {#if pin.text}<p class="wrap-anywhere whitespace-pre-wrap text-sm">{pin.text}</p>{/if}
          {#if pin.attachmentName}<p class="wrap-anywhere text-sm text-muted-foreground">{pin.attachmentName}</p>{/if}
          <Button size="sm" variant="outline" class="mt-1 justify-self-start" disabled={jumpingTo !== null} onclick={() => jumpToMessage(pin.id)}>
            {jumpingTo === pin.id ? "Opening…" : "Go to message"}
          </Button>
        </li>
      {/each}
      {#if pinPage.next && chatScope}
        <li><Button size="sm" variant="outline" disabled={loadingPins} onclick={() => {
          if (chatScope && pinPage?.next) void loadPins(chatScope, revision, pinPage.next);
        }}>{loadingPins ? "Loading…" : "Load more pins"}</Button></li>
      {/if}
    </ul>
  {:else if loadingPins}
    <p role="status">Loading pinned messages…</p>
  {:else if pinPage}
    <p>No pinned messages.</p>
  {/if}
</Modal>

<style>
  .channel-description {
    margin: 0;
    overflow: hidden;
    color: var(--muted-foreground);
    font-size: var(--type-caption);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .server-motd {
    margin: .5rem .5rem 0;
    padding: .5rem .75rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--card);
  }
  .server-motd summary { width: fit-content; font-weight: 600; cursor: pointer; }
  .server-motd p { margin: .25rem 0 0; max-height: 9rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
