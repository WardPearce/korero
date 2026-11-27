<script lang="ts">
  import { ArrowLeft, ExternalLink, LockKeyhole } from "@lucide/svelte";
  import { onMount, tick } from "svelte";
  import ChatMessage from "./ChatMessage.svelte";
  import ChatComposer from "./ChatComposer.svelte";
  import RichMessage from "./RichMessage.svelte";
  import IconButton from "#lib/components/IconButton.svelte";
  import Modal from "#lib/components/Modal.svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { directRequest, messageFrom, type DirectMessage } from "#lib/connection/client";
  import { decodeDirectContent, directConversation, encodeDirectContent, type DirectCursor, type DirectPacket, type DirectPage, type DirectPeer } from "#lib/chat/direct-crypto";
  import { getIdentity } from "#lib/identity/identity";
  import { preferences } from "#lib/preferences";
  import { getWorkspace } from "#lib/workspace";

  let { accountId, onback }: { accountId: string; onback: () => void } = $props();
  const workspace = getWorkspace();
  const snapshot = $derived(workspace.view.snapshot!);
  const policy = $derived(snapshot.directMessages!);
  const online = $derived(snapshot.presence.some((peer) => peer.accountId === accountId));
  const canSendDirectMessages = $derived(policy.canSend ?? snapshot.serverPermissions.includes("text"));
  const canSend = $derived(canSendDirectMessages && (online || policy.persistent || policy.offlineDelivery === true));
  let peer = $state.raw<DirectPeer>();
  let conversation = $state.raw<Awaited<ReturnType<typeof directConversation>>>();
  let mode = $state<"loading" | "unverified" | "verified" | "error">("loading");
  let pinKey = "";
  let verificationOpen = $state(false);
  let confirmation = $state("");
  let verificationError = $state("");
  let verificationPending = $state(false);
  let connectionId = "";
  let retry: { content: string; packet: DirectPacket } | undefined;
  let externalUrl = $state("");
  let pending = $state(false);
  let error = $state("");
  let historyError = $state("");
  let loadingHistory = $state(false);
  let historyLoaded = $state(false);
  let history = $state.raw<DirectMessage[]>([]);
  let next = $state.raw<DirectCursor | null>(null);
  let list: HTMLDivElement | undefined;
  let lastMessageId: string | undefined;
  const safetyCode = $derived(conversation?.safetyCode.match(/.{4}/g)?.join(" ") ?? "");
  const messages = $derived.by(() => {
    const packets = new Map(history.map((message) => [message.id, message]));
    for (const message of workspace.view.directMessages ?? []) {
      if ((message.senderId === accountId && message.recipientId === snapshot.account.id) ||
          (message.recipientId === accountId && message.senderId === snapshot.account.id)) {
        const known = packets.get(message.id);
        // A live edit replaces the copy loaded from history.
        if (!known || (message.editedAt ?? 0) > (known.editedAt ?? 0)) {
          packets.set(message.id, known ? { ...known, ...message, createdAt: known.createdAt } : message);
        }
      }
    }
    for (const id of workspace.view.directDeleted ?? []) packets.delete(id);
    return [...packets.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  });

  onMount(() => {
    connectionId = snapshot.connectionId;
    void open();
  });

  $effect.pre(() => {
    const latest = messages.at(-1)?.id;
    if (latest && latest !== lastMessageId && list && list.scrollHeight - list.scrollTop - list.clientHeight < 90) {
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
    const serverId = workspace.serverId;
    const { account } = snapshot;
    try {
      const [identity, contact] = await Promise.all([
        getIdentity(),
        directRequest<DirectPeer & { ownPublicKey: string }>(connectionId, "direct.peer", { accountId }),
      ]);
      if (!identity || contact.accountId !== accountId) throw new Error("The conversation identity is unavailable.");
      if (identity.publicKey !== contact.ownPublicKey) throw new Error("Reconnect with this account’s identity to open direct messages.");
      peer = contact;
      const candidate = await directConversation(serverId, account.id, identity, contact);
      pinKey = `direct-safety-code:${JSON.stringify([serverId, identity.publicKey, account.id, accountId])}`;
      const pinned = await preferences.local.get(pinKey);
      if (pinned && pinned.value !== candidate.safetyCode) {
        throw new Error("This contact’s identity differs from the verified identity on this device.");
      }
      conversation = candidate;
      mode = pinned ? "verified" : "unverified";
      await loadHistory();
    } catch (cause) {
      error = messageFrom(cause);
      mode = "error";
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

  async function loadHistory(before?: DirectCursor) {
    if (loadingHistory || !policy.persistent) return;
    loadingHistory = true;
    historyError = "";
    const oldHeight = list?.scrollHeight;
    const oldTop = list?.scrollTop ?? 0;
    try {
      const page = await directRequest<DirectPage>(connectionId, "direct.history", { accountId, before });
      history = [...history, ...page.messages];
      next = page.next;
      historyLoaded = true;
      if (before && oldHeight !== undefined) {
        await tick();
        if (list) list.scrollTop = oldTop + list.scrollHeight - oldHeight;
      } else await scrollToBottom();
    } catch (cause) {
      historyError = messageFrom(cause);
    } finally {
      loadingHistory = false;
    }
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

  async function edit(message: DirectMessage, text: string) {
    if (!conversation) throw new Error("The conversation is unavailable.");
    const content = encodeDirectContent(text);
    if (!fits(content)) throw new Error(`Messages can use up to ${policy.maxBytes} bytes on this server.`);
    const packet = await conversation.encrypt(content, message.id);
    await directRequest(connectionId, "direct.edit", packet);
  }

  async function remove(message: DirectMessage) {
    await directRequest(connectionId, "direct.delete", { accountId, id: message.id });
    history = history.filter(({ id }) => id !== message.id);
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
      await directRequest(connectionId, "direct.send", packet);
      retry = undefined;
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
      {#if next || historyError}
        <div class="px-3 pt-3">
          {#if historyError}<p class="form-error" role="alert">{historyError}</p>{/if}
          <Button variant="outline" disabled={loadingHistory} onclick={() => loadHistory(next ?? undefined)}>
            {loadingHistory ? "Loading…" : historyError ? "Retry history" : "Load older messages"}
          </Button>
        </div>
      {/if}
      {#each messages as message, index (message.id)}
        {@const name = message.senderId === snapshot.account.id ? snapshot.account.displayName : peer?.displayName ?? "Contact"}
        {@const own = message.senderId === snapshot.account.id}
        {#await conversation.decrypt(message)}
          <ChatMessage {message} previous={messages[index - 1]} {name}>
            <p class="text-muted-foreground">Decrypting…</p>
          </ChatMessage>
        {:then content}
          {@const decoded = decodeDirectContent(content)}
          <ChatMessage {message} previous={messages[index - 1]} {name}
            editText={own && canSendDirectMessages ? decoded.text : undefined} editLimit={policy.maxBytes}
            onedit={own ? (text) => edit(message, text) : undefined}
            ondelete={own ? () => remove(message) : undefined}>
            <RichMessage {...decoded} onlink={confirmLink} />
          </ChatMessage>
        {:catch}
          <ChatMessage {message} previous={messages[index - 1]} {name} ondelete={own ? () => remove(message) : undefined}>
            <p class="form-error">Message could not be verified or decrypted.</p>
          </ChatMessage>
        {/await}
      {:else}
        <div class="chat-empty">
          <LockKeyhole size={23} />
          <p>{policy.persistent && !historyLoaded && !historyError ? "Loading messages…" : "No messages yet."}</p>
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
