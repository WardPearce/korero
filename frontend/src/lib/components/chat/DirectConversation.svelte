<script lang="ts">
  import { ArrowLeft, ExternalLink, LockKeyhole } from "@lucide/svelte";
  import { onMount, tick, untrack } from "svelte";
  import ChatMessage from "./ChatMessage.svelte";
  import ChatComposer from "./ChatComposer.svelte";
  import RichMessage from "./RichMessage.svelte";
  import IconButton from "#lib/components/IconButton.svelte";
  import Modal from "#lib/components/Modal.svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { directRequest, isSameDirectMessage, messageFrom, type DirectMessage, type DirectMessageChange,
    type DirectMessageReference } from "#lib/connection/client";
  import { archiveMessages, countSince, openConversation, watchConversation, withoutDeleted,
    type ArchivedDirectMessage, type OpenedConversation } from "#lib/chat/direct-archive";
  import { encodeDirectContent, type DirectCursor, type DirectPacket, type DirectPage, type DirectPeer } from "#lib/chat/direct-crypto";
  import { preferences } from "#lib/preferences";
  import { getWorkspace } from "#lib/workspace";

  const pageSize = 50;
  let { accountId, focus, onback }: {
    accountId: string;
    /** A message to scroll to and highlight once the conversation opens. */
    focus?: { id: string; createdAt: number };
    onback: () => void;
  } = $props();
  const workspace = getWorkspace();
  const snapshot = $derived(workspace.view.snapshot!);
  const policy = $derived(snapshot.directMessages!);
  const online = $derived(snapshot.presence.some((peer) => peer.accountId === accountId));
  const canSendDirectMessages = $derived(policy.canSend ?? snapshot.serverPermissions.includes("text"));
  const canSend = $derived(canSendDirectMessages && (online || policy.persistent || policy.offlineDelivery === true));
  let peer = $state.raw<DirectPeer>();
  let conversation = $state.raw<OpenedConversation["conversation"]>();
  let mode = $state<"loading" | "unverified" | "verified" | "error">("loading");
  let pinKey = "";
  let verificationOpen = $state(false);
  let confirmation = $state("");
  let verificationError = $state("");
  let verificationPending = $state(false);
  let retry: { content: string; packet: DirectPacket } | undefined;
  let externalUrl = $state("");
  let pending = $state(false);
  let error = $state("");
  let historyError = $state("");
  let loadingHistory = $state(false);
  let historyLoaded = $state(false);
  let changesDuringHistory: DirectMessageChange[] | undefined;
  let next = $state.raw<DirectCursor | null>(null);
  let list: HTMLDivElement | undefined;
  let lastMessageId: string | undefined;
  let limit = $state(pageSize);
  let archived = $state.raw<{ messages: ArchivedDirectMessage[]; total: number }>({ messages: [], total: 0 });
  let archiveReady = $state(false);
  /** Packets that failed verification or decryption. They are shown but never archived. */
  let failed = $state.raw<DirectMessage[]>([]);
  let highlighted = $state<string | null>(null);
  const ownId = $derived(snapshot.account.id);
  // The conversation belongs to the session it opened in. A reconnect remounts it.
  const scope = untrack(() => ({ serverId: workspace.serverId, ownerId: snapshot.account.id, connectionId: snapshot.connectionId }));
  const safetyCode = $derived(conversation?.safetyCode.match(/.{4}/g)?.join(" ") ?? "");
  type Entry = { message: DirectMessageReference & { createdAt: number; editedAt?: number | null }; content?: ArchivedDirectMessage };
  const messages = $derived.by(() => {
    const entries = new Map<string, Entry>();
    for (const message of failed) entries.set(messageKey(message), { message });
    for (const content of archived.messages) entries.set(messageKey(content), { message: content, content });
    return [...entries.values()].sort((a, b) => a.message.createdAt - b.message.createdAt || a.message.id.localeCompare(b.message.id));
  });
  const hasOlder = $derived(Boolean(next) || archived.total > archived.messages.length);

  onMount(() => {
    const unwatch = workspace.watchDirectChanges(scope.connectionId, (change) => {
      if (!isInConversation(change.message, scope.ownerId)) return;
      changesDuringHistory?.push(change);
      if (change.type === "delete") failed = failed.filter((message) => !isSameDirectMessage(message, change.message));
    });
    void open();
    return unwatch;
  });

  $effect(() => {
    const subscription = watchConversation(scope.serverId, scope.ownerId, accountId, limit).subscribe({
      next: (value) => { archived = value; archiveReady = true; },
      error: (cause) => { historyError = messageFrom(cause); },
    });
    return () => subscription.unsubscribe();
  });

  $effect(() => {
    // The workspace archives live packets too. This pass only finds the ones that fail to verify.
    const live = (workspace.view.directMessages ?? []).filter((message) => isInConversation(message, ownId));
    if (!conversation || !live.length) return;
    void archiveMessages(scope, live).then(addFailed);
  });

  function addFailed(messages: DirectMessage[]) {
    const fresh = messages.filter((message) => !failed.some((known) => isSameDirectMessage(known, message)));
    if (fresh.length) failed = [...failed, ...fresh];
  }

  function isInConversation({ senderId, recipientId }: DirectMessageReference, ownId: string) {
    return (senderId === ownId && recipientId === accountId) || (senderId === accountId && recipientId === ownId);
  }

  function messageKey({ id, senderId, recipientId }: DirectMessageReference) {
    return `${senderId}/${recipientId}/${id}`;
  }

  $effect.pre(() => {
    const latest = messages.at(-1)?.message.id;
    if (latest && latest !== lastMessageId && !highlighted && list && list.scrollHeight - list.scrollTop - list.clientHeight < 90) {
      void scrollToBottom();
    }
    lastMessageId = latest;
  });

  function attachLog(element: HTMLDivElement) {
    list = element;
    void scrollToBottom();
    return () => { if (list === element) list = undefined; };
  }

  async function scrollToBottom() {
    await tick();
    if (list) list.scrollTop = list.scrollHeight;
  }

  async function open() {
    mode = "loading";
    error = "";
    try {
      const opened = await openConversation(scope, accountId);
      peer = opened.peer;
      pinKey = opened.pinKey;
      conversation = opened.conversation;
      const pinned = await preferences.local.get(pinKey);
      mode = pinned ? "verified" : "unverified";
      if (focus) await showFocus(focus);
      await loadHistory();
    } catch (cause) {
      error = messageFrom(cause);
      mode = "error";
    }
  }

  async function showFocus(target: { id: string; createdAt: number }) {
    limit = Math.max(limit, await countSince(scope.serverId, scope.ownerId, accountId, target.createdAt) + 10);
    highlighted = target.id;
    // Wait for the archive query to include the message before scrolling to it.
    for (let attempt = 0; attempt < 20 && !archived.messages.some(({ id }) => id === target.id); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await tick();
    const element = document.getElementById(`chat-message-${target.id}`);
    if (element && list?.contains(element)) {
      element.tabIndex = -1;
      element.scrollIntoView({ block: "center" });
      element.focus({ preventScroll: true });
    }
  }

  function showVerification() {
    confirmation = "";
    verificationError = "";
    verificationOpen = true;
  }

  async function verifyContact(event: SubmitEvent) {
    event.preventDefault();
    if (mode !== "unverified" || !conversation || verificationPending) return;
    const code = conversation.safetyCode;
    if (confirmation.replace(/[\s-]/g, "").toLowerCase() !== code) {
      verificationError = "The safety codes differ. Check the code you received from your contact.";
      return;
    }
    verificationPending = true;
    verificationError = "";
    try {
      await preferences.transaction("rw", preferences.local, async () => {
        const pinned = await preferences.local.get(pinKey);
        if (pinned && pinned.value !== code) throw new Error("The verified identity changed on this device.");
        if (!pinned) await preferences.local.add({ key: pinKey, value: code });
      });
      confirmation = "";
      mode = "verified";
      verificationOpen = false;
    } catch (cause) {
      verificationError = messageFrom(cause);
    } finally {
      verificationPending = false;
    }
  }

  /** Fetches a server history page into the archive. Without `before` it fetches the newest page. */
  async function loadHistory(before?: DirectCursor) {
    if (loadingHistory || !policy.persistent) return;
    loadingHistory = true;
    changesDuringHistory = [];
    historyError = "";
    try {
      const page = await directRequest<DirectPage>(scope.connectionId, "direct.history", { accountId, before });
      // A delete can arrive while the server's history response is in flight.
      addFailed(await archiveMessages(scope, withoutDeleted(page.messages, changesDuringHistory)));
      next = page.next;
      historyLoaded = true;
      if (!before && !highlighted) await scrollToBottom();
    } catch (cause) {
      historyError = messageFrom(cause);
    } finally {
      changesDuringHistory = undefined;
      loadingHistory = false;
    }
  }

  async function loadOlder() {
    const oldHeight = list?.scrollHeight;
    const oldTop = list?.scrollTop ?? 0;
    const shown = archived.messages.length;
    // Fetch from the server only once the archive has nothing older to show.
    if (next && archived.total <= shown) await loadHistory(next);
    limit = shown + pageSize;
    for (let attempt = 0; attempt < 20 && archived.messages.length === shown && archived.total > shown; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await tick();
    if (list && oldHeight !== undefined) list.scrollTop = oldTop + list.scrollHeight - oldHeight;
  }

  function confirmLink(url: string) {
    externalUrl = url;
  }

  function openLink() {
    window.open(externalUrl, "_blank", "noopener,noreferrer");
    externalUrl = "";
  }

  function fits(content: string) {
    return new TextEncoder().encode(content).length <= policy.maxBytes;
  }

  async function edit(message: DirectMessageReference, text: string) {
    if (!conversation) throw new Error("The conversation is unavailable.");
    const content = encodeDirectContent(text);
    if (!fits(content)) throw new Error(`Messages can use up to ${policy.maxBytes} bytes on this server.`);
    const packet = await conversation.encrypt(content, message.id);
    await directRequest(scope.connectionId, "direct.edit", packet);
  }

  async function remove(message: DirectMessageReference) {
    await directRequest(scope.connectionId, "direct.delete", { accountId, id: message.id });
  }

  async function send(text: string, html?: string) {
    if ((mode !== "verified" && mode !== "unverified") || !conversation || !canSend || pending || !text) return false;
    const content = encodeDirectContent(text, html);
    if (!fits(content)) {
      error = `Messages can use up to ${policy.maxBytes} bytes on this server. Shorten this message or remove formatting.`;
      return false;
    }
    pending = true;
    error = "";
    try {
      const packet = retry?.content === content ? retry.packet : await conversation.encrypt(content);
      retry = { content, packet };
      await directRequest(scope.connectionId, "direct.send", packet);
      retry = undefined;
      highlighted = null;
      await scrollToBottom();
      return true;
    } catch (cause) {
      error = messageFrom(cause);
      return false;
    } finally {
      pending = false;
    }
  }
</script>

<header class="workspace-header">
  <IconButton label="Back to direct messages" onclick={onback}><ArrowLeft size={18} /></IconButton>
  <div class="flex-content">
    <div class="breadcrumb truncate">{workspace.serverTitle} · Direct messages</div>
    <h2 class="truncate">{peer?.displayName ?? "Conversation"}</h2>
  </div>
  {#if mode === "unverified" || mode === "verified"}
    <Button variant="outline" aria-haspopup="dialog" onclick={showVerification}>
      <LockKeyhole size={16} aria-hidden="true" />
      {mode === "verified" ? "Safety code" : "Verify safety code"}
    </Button>
  {:else}
    <LockKeyhole size={18} aria-label="End-to-end encryption" />
  {/if}
</header>

{#if (mode === "verified" || mode === "unverified") && conversation}
  <section class="workspace chat-workspace" aria-label="Direct conversation">
    <div class="chat-log" {@attach attachLog} role="log" aria-label="Direct messages">
      {#if hasOlder || historyError}
        <div class="px-3 pt-3">
          {#if historyError}<p class="form-error" role="alert">{historyError}</p>{/if}
          <Button variant="outline" disabled={loadingHistory} onclick={() => historyError && !historyLoaded ? loadHistory() : loadOlder()}>
            {loadingHistory ? "Loading…" : historyError ? "Retry history" : "Load older messages"}
          </Button>
        </div>
      {/if}
      {#each messages as { message, content }, index (messageKey(message))}
        {@const name = message.senderId === snapshot.account.id ? snapshot.account.displayName : peer?.displayName ?? content?.peerName ?? "Contact"}
        {@const own = message.senderId === snapshot.account.id}
        {@const previous = messages[index - 1]?.message}
        {#if content}
          <ChatMessage {message} {previous} {name} messageId={message.id} highlighted={highlighted === message.id}
            editText={own && canSendDirectMessages ? content.text : undefined} editLimit={policy.maxBytes}
            onedit={own ? (text) => edit(message, text) : undefined}
            ondelete={own ? () => remove(message) : undefined}>
            <RichMessage text={content.text} html={content.html} onlink={confirmLink} />
          </ChatMessage>
        {:else}
          <ChatMessage {message} {previous} {name} messageId={message.id} ondelete={own ? () => remove(message) : undefined}>
            <p class="form-error">Message could not be verified or decrypted.</p>
          </ChatMessage>
        {/if}
      {:else}
        <div class="chat-empty">
          <LockKeyhole size={23} />
          <p>{!archiveReady || (policy.persistent && !historyLoaded && !historyError) ? "Loading messages…" : "No messages yet."}</p>
        </div>
      {/each}
    </div>
    {#if error}<p class="form-error px-3" role="alert">{error}</p>{/if}
    {#if !canSendDirectMessages}
      <p class="px-3 text-sm text-muted-foreground">Your role cannot send direct messages on this server.</p>
    {:else if !online && !policy.persistent && !policy.offlineDelivery}
      <p class="px-3 text-sm text-muted-foreground">This contact is offline. The server does not retain direct messages.</p>
    {:else if !online}
      <p class="px-3 text-sm text-muted-foreground">This contact is offline. The server delivers your messages when they next connect.</p>
    {/if}
    <ChatComposer enabled={canSend} direct={{ busy: pending, maxBytes: policy.maxBytes, send }} />
  </section>
  <Modal bind:open={() => Boolean(externalUrl), (open) => { if (!open) externalUrl = ""; }} title="Open external link?"
    description="This link opens a website outside Korero.chat. Check the address before continuing.">
    {#snippet icon()}<ExternalLink size={20} aria-hidden="true" />{/snippet}
    <div class="key-display mb-3"><code dir="ltr">{externalUrl}</code></div>
    <div class="dialog-actions">
      <Button variant="outline" onclick={() => { externalUrl = ""; }}>Cancel</Button>
      <Button onclick={openLink}>Open in browser</Button>
    </div>
  </Modal>
  <Modal bind:open={verificationOpen} title="Compare safety codes" dismissible={!verificationPending}
    description={mode === "verified"
      ? "You verified this contact’s safety code on this device."
      : `Ask ${peer?.displayName} to open this conversation and share their safety code in person or through a trusted channel.`}>
    {#snippet icon()}<LockKeyhole size={20} aria-hidden="true" />{/snippet}
    {#if verificationError}<p class="form-error" role="alert">{verificationError}</p>{/if}
    <form class="dialog-form" onsubmit={verifyContact}>
      <p class="key-display font-mono select-all">{safetyCode}</p>
      {#if mode === "unverified"}
        <label>Safety code from your contact
          <Input required bind:value={confirmation} spellcheck={false} autocomplete="off" disabled={verificationPending} />
        </label>
      {/if}
      <div class="dialog-actions">
        <Button variant="outline" onclick={() => { verificationOpen = false; }} disabled={verificationPending}>Back</Button>
        {#if mode === "unverified"}
          <Button type="submit" disabled={verificationPending}>{verificationPending ? "Verifying…" : "Verify safety code"}</Button>
        {/if}
      </div>
    </form>
  </Modal>
{:else}
  <div class="workspace">
    {#if error}<p class="form-error" role="alert">{error}</p>{/if}
    {#if mode === "loading"}
      <p role="status">Loading conversation…</p>
    {:else if mode === "error"}
      <Button class="self-start" variant="outline" onclick={open}>Retry</Button>
    {/if}
  </div>
{/if}
