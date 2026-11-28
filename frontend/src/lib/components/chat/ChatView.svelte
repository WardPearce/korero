<script lang="ts">
  import { CircleAlert, Download, Headphones, MessageCircle, Paperclip, Pencil, PhoneOff, Pin, Search, X } from "@lucide/svelte";
  import { tick } from "svelte";
  import ChatComposer from "#lib/components/chat/ChatComposer.svelte";
  import ChatMessage from "#lib/components/chat/ChatMessage.svelte";
  import RichMessage from "#lib/components/chat/RichMessage.svelte";
  import Avatar from "#lib/components/Avatar.svelte";
  import IconButton from "#lib/components/IconButton.svelte";
  import ScreenSharing from "#lib/components/media/ScreenSharing.svelte";
  import { Button, buttonVariants } from "#lib/components/ui/button/index.js";
  import * as Popover from "#lib/components/ui/popover/index.js";
  import { downloadAttachment } from "#lib/chat/chat-attachments";
  import { maxChatTextLength } from "#lib/chat/rich-chat";
  import { channelMessageContext, channelPins, channelSearch, messageFrom, messageTime, type Channel, type Message, type MessageSearchPage,
    type PinCursor, type PinnedMessagePage, type SearchCursor } from "#lib/connection/client";
  import { Input } from "#lib/components/ui/input/index.js";
  import { matchParts } from "#lib/chat/search-highlight";
  import { mentionsMe, type MentionKind } from "#lib/chat/mentions";
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
  const supportsSearch = $derived(currentChannel?.messageSearch === true);
  const chatScope = $derived(canRead && (supportsPins || supportsSearch) && connectionId && channelId
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
  let searchFor = $state.raw<ChatScope | null>(null);
  const searchOpen = $derived(chatScope !== null && searchFor === chatScope);
  let searchQuery = $state("");
  let searchedQuery = $state("");
  let searchPage = $state.raw<MessageSearchPage | null>(null);
  let searchError = $state("");
  let searching = $state(false);
  let searchRequest = 0;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let history = $state.raw<{ scope: ChatScope; messageId: string; messages: Message[]; revision: number } | null>(null);
  const showingHistory = $derived(history !== null && history.scope === chatScope);
  const displayedMessages = $derived(showingHistory && history ? history.messages : messages);
  let highlight = $state.raw<{ scope: ChatScope; messageId: string } | null>(null);
  let replying = $state.raw<{ channelId: string; id: string; name: string; text: string } | null>(null);
  const replyDraft = $derived(replying && replying.channelId === currentChannel?.id ? replying : undefined);
  const myRoles = $derived(me?.roles ?? (me ? [me.role] : []));
  const canReact = $derived(canChat && currentChannel?.messageReactions === true);
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
      // Mentions have their own sound, played for every channel.
      if (arrivals.length === 1 && latest.id === latestId && latest.senderId !== me?.id && Date.now() - latest.createdAt < 15000 &&
        !mentionsMe(latest, me?.id, myRoles)) {
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

  $effect(() => () => clearTimeout(searchTimer));

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

  function setSearchOpen(open: boolean) {
    searchFor = open ? chatScope : null;
    searchRequest++;
    clearTimeout(searchTimer);
    searchQuery = "";
    searchedQuery = "";
    searchPage = null;
    searchError = "";
    searching = false;
    jumpingTo = null;
  }

  function queueSearch() {
    clearTimeout(searchTimer);
    searchRequest++;
    searchError = "";
    if (!searchQuery.trim()) {
      searchPage = null;
      searchedQuery = "";
      searching = false;
      return;
    }
    searching = true;
    searchTimer = setTimeout(() => { if (chatScope) void runSearch(chatScope, searchQuery.trim()); }, 250);
  }

  async function runSearch(scope: ChatScope, query: string, before?: SearchCursor) {
    clearTimeout(searchTimer);
    const request = ++searchRequest;
    const current = () => searchFor === scope && chatScope === scope && request === searchRequest;
    searching = true;
    searchError = "";
    try {
      const page = await channelSearch(scope.origin, scope.connectionId, scope.channelId, query, before);
      if (!current()) return;
      searchPage = before && searchPage ? { ...page, messages: [...searchPage.messages, ...page.messages] } : page;
      searchedQuery = query;
    } catch (cause) {
      if (current()) searchError = messageFrom(cause);
    } finally {
      if (current()) searching = false;
    }
  }

  async function jumpToMessage(messageId: string, source: "pins" | "search" | "reply" = "pins") {
    const scope = chatScope;
    const sourceOpen = () => source === "pins" ? pinsOpen : source === "search" ? searchOpen : true;
    const showError = (message: string) => {
      if (source === "pins") pinError = message;
      else if (source === "search") searchError = message;
      else workspace.actionError = message;
    };
    if (!scope || !sourceOpen() || jumpingTo) return;
    jumpingTo = messageId;
    showError("");
    try {
      if (messages.some((entry) => entry.id === messageId)) {
        history = null;
      } else if (!displayedMessages.some((entry) => entry.id === messageId)) {
        const requestedRevision = revision;
        const entries = await channelMessageContext(scope.origin, scope.connectionId, scope.channelId, messageId);
        if (chatScope !== scope || !sourceOpen() || jumpingTo !== messageId) return;
        history = { scope, messageId, messages: entries, revision: requestedRevision };
      }
      if (source === "pins") setPinsOpen(false);
      else if (source === "search") setSearchOpen(false);
      highlight = { scope, messageId };
      await tick();
      const target = document.getElementById(`chat-message-${messageId}`);
      if (chatScope === scope && target && messageList?.contains(target)) {
        target.tabIndex = -1;
        target.scrollIntoView({ block: "center" });
        target.focus({ preventScroll: true });
      }
    } catch (cause) {
      if (chatScope === scope && sourceOpen()) showError(messageFrom(cause));
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

  /** Opens a replied-to message, scrolling to it when it is loaded or fetching its context otherwise. */
  async function openReply(messageId: string) {
    if (displayedMessages.some(({ id }) => id === messageId)) {
      highlight = chatScope && { scope: chatScope, messageId };
      document.getElementById(`chat-message-${messageId}`)?.scrollIntoView({ block: "center" });
      return;
    }
    await jumpToMessage(messageId, "reply");
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

  function mentionLabel(kind: MentionKind, target: string) {
    if (kind === "role") return { label: target, me: myRoles.includes(target) };
    const label = target === me?.id ? me.displayName : snapshot?.presence.find((person) => person.accountId === target)?.displayName;
    return { label, me: target === me?.id };
  }

  function startReply(entry: Message) {
    if (!entry.channelId) return;
    replying = { channelId: entry.channelId, id: entry.id, name: authorName(entry),
      text: entry.text.slice(0, 120) || entry.attachment?.name || "" };
    void tick().then(() => document.querySelector<HTMLElement>(".chat-pane .composer .tiptap, .chat-pane .composer input")?.focus());
  }

  function authorName({ senderId, senderName }: Pick<Message, "senderId" | "senderName">) {
    if (senderId === me?.id) return me.displayName;
    return snapshot?.presence.find((person) => person.accountId === senderId)?.displayName
      ?? snapshot?.members.find((person) => person.accountId === senderId)?.displayName ?? senderName ?? "Channel member";
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
  {#if chatScope && supportsSearch}
    <Popover.Root bind:open={() => searchOpen, setSearchOpen}>
      <Popover.Trigger aria-label="Search messages" title="Search messages" aria-pressed={searchOpen}
        class={[buttonVariants({ variant: "outline", size: "icon" }), "icon-button"]}>
        <Search size={18} aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Content side="bottom" align="end" class="pins-popover" aria-label="Search messages">
        {@render searchResults()}
      </Popover.Content>
    </Popover.Root>
  {/if}
  {#if chatScope && supportsPins}
    <Popover.Root bind:open={() => pinsOpen, setPinsOpen}>
      <Popover.Trigger aria-label="Pinned messages" title="Pinned messages" aria-pressed={pinsOpen}
        class={[buttonVariants({ variant: "outline", size: "icon" }), "icon-button"]}>
        <Pin size={18} aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Content side="bottom" align="end" class="pins-popover" aria-label="Pinned messages">
        {@render pinnedMessages()}
      </Popover.Content>
    </Popover.Root>
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
          {@const reply = entry.replyTo}
          <ChatMessage message={entry} messageId={entry.id} pinned={Boolean(entry.pinnedAt)}
            highlighted={highlight !== null && highlight.scope === chatScope && highlight.messageId === entry.id}
            mentioned={mentionsMe(entry, me?.id, myRoles)}
            replyTo={reply} replyName={reply && "senderId" in reply ? authorName(reply) : undefined}
            onopenreply={reply && "senderId" in reply && (chatScope || messages.some(({ id }) => id === reply.id))
              ? () => void openReply(reply.id) : undefined}
            reactions={entry.reactions}
            onreact={canReact ? (emoji, reacted) => {
              void run("message-react", "react_message", { channelId: entry.channelId, messageId: entry.id, emoji, reacted });
            } : undefined}
            onreply={canChat ? () => startReply(entry) : undefined}
            previous={displayedMessages[index - 1]} name={authorName(entry)}
            editText={own && canChat ? entry.text : undefined} editLimit={maxChatTextLength}
            onedit={own && canChat ? (text) => changeMessage("message-edit", "edit_message", { messageId: entry.id, text }) : undefined}
            onpin={currentChannel?.canPinMessages && !pending ? () => {
              void run("message-pin", "pin_message", { channelId: entry.channelId, messageId: entry.id, pinned: !entry.pinnedAt });
            } : undefined}
            ondelete={own || currentChannel?.canDeleteMessages
              ? () => changeMessage("message-delete", "delete_message", { messageId: entry.id }) : undefined}>
            <RichMessage text={entry.text} html={entry.html} mention={mentionLabel} />
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
        disabledHint={outsideChat ? "You can't send messages here" : undefined}
        replyTo={replyDraft} oncancelreply={() => { replying = null; }} />
    {/key}
  </section>
</div>

{#snippet searchResults()}
  <header class="pins-header">
    <Search size={18} aria-hidden="true" />
    <Input class="search-input" type="search" placeholder="Search {currentChannel?.name ?? 'this channel'}" aria-label="Search messages"
      maxlength={100} spellcheck={false} autocomplete="off" bind:value={searchQuery} oninput={queueSearch}
      onkeydown={(event) => { if (event.key === "Enter" && chatScope && searchQuery.trim()) void runSearch(chatScope, searchQuery.trim()); }} />
  </header>
  <div class="pins-list">
    {#if searchError}<p class="form-error px-1" role="alert">{searchError}</p>{/if}
    {#if searchPage?.messages.length}
      <ul class="grid gap-2" aria-label="Search results">
        {#each searchPage.messages as result (result.id)}
          {@const name = authorName(result)}
          <li class="pin-card">
            <Avatar {name} accountId={result.senderId} />
            <div class="min-w-0">
              <div class="pin-meta">
                <strong class="wrap-anywhere">{name}</strong>
                <time datetime={new Date(result.createdAt).toISOString()} title={new Date(result.createdAt).toLocaleString()}>
                  {new Date(result.createdAt).toLocaleDateString()}, {messageTime.format(result.createdAt)}
                </time>
              </div>
              <p class="pin-body search-body">
                {#each matchParts(result.text, searchedQuery) as part, index (index)}
                  {#if part.match}<mark>{part.text}</mark>{:else}{part.text}{/if}
                {/each}
              </p>
              {#if result.attachmentName}
                <p class="pin-attachment"><Paperclip size={14} aria-hidden="true" /><span class="truncate">{result.attachmentName}</span></p>
              {/if}
            </div>
            <div class="pin-actions">
              <Button size="sm" variant="secondary" disabled={jumpingTo !== null} onclick={() => jumpToMessage(result.id, "search")}>
                {jumpingTo === result.id ? "Opening…" : "Jump"}
              </Button>
            </div>
          </li>
        {/each}
      </ul>
    {:else if searching}
      <p class="pins-empty" role="status">Searching…</p>
    {:else if searchPage}
      <div class="pins-empty" role="status">
        <Search size={32} strokeWidth={1.5} aria-hidden="true" />
        <p>{searchPage.next ? "No matches in this batch." : `No stored messages match “${searchedQuery}”.`}</p>
      </div>
    {:else}
      <p class="pins-empty">Search this channel’s stored messages.</p>
    {/if}
    {#if searchPage?.next && chatScope}
      <Button size="sm" variant="ghost" class="mt-2 w-full" disabled={searching} onclick={() => {
        if (chatScope && searchPage?.next) void runSearch(chatScope, searchedQuery, searchPage.next);
      }}>{searching ? "Loading…" : "Search older messages"}</Button>
    {/if}
  </div>
{/snippet}

{#snippet pinnedMessages()}
  <header class="pins-header">
    <Pin size={18} aria-hidden="true" />
    <h3>Pinned Messages</h3>
  </header>
  <div class="pins-list">
    {#if pinError}<p class="form-error px-1" role="alert">{pinError}</p>{/if}
    {#if pinPage?.messages.length}
      <ul class="grid gap-2">
        {#each pinPage.messages as pin (pin.id)}
          {@const name = authorName(pin)}
          <li class="pin-card">
            <Avatar {name} accountId={pin.senderId} />
            <div class="min-w-0">
              <div class="pin-meta">
                <strong class="wrap-anywhere">{name}</strong>
                <time datetime={new Date(pin.createdAt).toISOString()} title={new Date(pin.createdAt).toLocaleString()}>
                  {new Date(pin.createdAt).toLocaleDateString()}, {messageTime.format(pin.createdAt)}
                </time>
              </div>
              {#if pin.text}<div class="pin-body"><RichMessage text={pin.text} /></div>{/if}
              {#if pin.attachmentName}
                <p class="pin-attachment"><Paperclip size={14} aria-hidden="true" /><span class="truncate">{pin.attachmentName}</span></p>
              {/if}
            </div>
            <div class="pin-actions">
              <Button size="sm" variant="secondary" disabled={jumpingTo !== null} onclick={() => jumpToMessage(pin.id)}>
                {jumpingTo === pin.id ? "Opening…" : "Jump"}
              </Button>
              {#if currentChannel?.canPinMessages}
                <Button size="icon-sm" variant="secondary" aria-label="Unpin message" title="Unpin message" disabled={Boolean(pending)}
                  onclick={() => run("message-pin", "pin_message", { channelId: currentChannel.id, messageId: pin.id, pinned: false })}>
                  <X size={14} aria-hidden="true" />
                </Button>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
      {#if pinPage.next && chatScope}
        <Button size="sm" variant="ghost" class="mt-2 w-full" disabled={loadingPins} onclick={() => {
          if (chatScope && pinPage?.next) void loadPins(chatScope, revision, pinPage.next);
        }}>{loadingPins ? "Loading…" : "Load more pins"}</Button>
      {/if}
    {:else if loadingPins}
      <p class="pins-empty" role="status">Loading pinned messages…</p>
    {:else if pinPage}
      <div class="pins-empty">
        <Pin size={32} strokeWidth={1.5} aria-hidden="true" />
        <p>This channel doesn't have any pinned messages… yet.</p>
      </div>
    {/if}
  </div>
{/snippet}

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
  :global(.pins-popover) {
    width: min(26rem, calc(100vw - 1rem));
    max-height: min(70vh, 36rem);
    gap: 0;
    padding: 0;
    overflow: hidden;
  }
  .pins-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
  }
  .pins-header :global(.search-input) { flex: 1; min-width: 0; }
  .search-body { margin: 0; white-space: pre-wrap; }
  .search-body mark { border-radius: 2px; background: color-mix(in srgb, var(--primary) 30%, transparent); color: inherit; }
  .pins-header h3 { margin: 0; font-size: 1rem; font-weight: 600; }
  .pins-list { min-height: 0; overflow: auto; padding: 8px; }
  .pin-card {
    position: relative;
    display: grid;
    grid-template-columns: 2rem minmax(0, 1fr);
    gap: 10px;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--card);
  }
  .pin-card:hover, .pin-card:focus-within { background: var(--control-hover); }
  .pin-meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 8px; }
  .pin-meta time { color: var(--muted-foreground); font-size: var(--type-small); }
  .pin-body { font-size: var(--type-body, .875rem); overflow-wrap: anywhere; }
  .pin-body :global(p) { margin: 0; white-space: pre-wrap; }
  .pin-attachment { display: flex; align-items: center; gap: 4px; margin: 2px 0 0; color: var(--muted-foreground); font-size: var(--type-small); }
  .pin-actions {
    position: absolute;
    top: 6px;
    right: 6px;
    display: flex;
    gap: 4px;
    opacity: 0;
    transition: opacity 100ms;
  }
  .pin-card:hover .pin-actions, .pin-card:focus-within .pin-actions { opacity: 1; }
  @media (hover: none) { .pin-actions { opacity: 1; } }
  .pins-empty {
    display: grid;
    justify-items: center;
    gap: 8px;
    padding: 24px 16px;
    color: var(--muted-foreground);
    text-align: center;
  }
  .pins-empty p { margin: 0; }
</style>
