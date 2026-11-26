<script lang="ts">
  import { ArrowLeft, LockKeyhole, Send } from "@lucide/svelte";
  import { onMount, tick } from "svelte";
  import ChatMessage from "./ChatMessage.svelte";
  import IconButton from "#lib/components/IconButton.svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Textarea } from "#lib/components/ui/textarea/index.js";
  import { directRequest, messageFrom, type DirectMessage } from "#lib/connection/client";
  import { directConversation, type DirectCursor, type DirectPacket, type DirectPage, type DirectPeer } from "#lib/chat/direct-crypto";
  import { getIdentity } from "#lib/identity/identity";
  import { preferences } from "#lib/preferences";
  import { getWorkspace } from "#lib/workspace";

  let { accountId, onback }: { accountId: string; onback: () => void } = $props();
  const workspace = getWorkspace();
  const snapshot = $derived(workspace.view.snapshot!);
  const policy = $derived(snapshot.directMessages!);
  const online = $derived(snapshot.presence.some((peer) => peer.accountId === accountId));
  const canSendDirectMessages = $derived(policy.canSend ?? snapshot.serverPermissions.includes("text"));
  const canSend = $derived(canSendDirectMessages && (online || policy.persistent));
  let peer = $state.raw<DirectPeer>();
  let conversation = $state.raw<Awaited<ReturnType<typeof directConversation>>>();
  let mode = $state<"loading" | "verify" | "verified" | "error">("loading");
  let pinKey = "";
  let confirmation = $state("");
  let verificationPending = $state(false);
  let draft = $state("");
  let connectionId = "";
  let retry: { text: string; packet: DirectPacket } | undefined;
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
        if (!packets.has(message.id)) packets.set(message.id, message);
      }
    }
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
      mode = pinned ? "verified" : "verify";
      if (pinned) await loadHistory();
    } catch (cause) {
      error = messageFrom(cause);
      mode = "error";
    }
  }

  async function verifyContact(event: SubmitEvent) {
    event.preventDefault();
    if (mode !== "verify" || !conversation || verificationPending) return;
    const code = conversation.safetyCode;
    if (confirmation.replace(/[\s-]/g, "").toLowerCase() !== code) {
      error = "The safety codes differ. Check the code you received from your contact.";
      return;
    }
    verificationPending = true;
    error = "";
    try {
      await preferences.transaction("rw", preferences.local, async () => {
        const pinned = await preferences.local.get(pinKey);
        if (pinned && pinned.value !== code) throw new Error("The verified identity changed on this device.");
        if (!pinned) await preferences.local.add({ key: pinKey, value: code });
      });
      confirmation = "";
      mode = "verified";
      await loadHistory();
    } catch (cause) {
      error = messageFrom(cause);
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

  async function send(event: SubmitEvent) {
    event.preventDefault();
    if (mode !== "verified" || !conversation || !canSend || pending || !draft.trim()) return;
    if (new TextEncoder().encode(draft).length > policy.maxBytes) {
      error = `Messages can use up to ${policy.maxBytes} bytes on this server.`;
      return;
    }
    pending = true;
    error = "";
    const text = draft;
    try {
      const packet = retry?.text === text ? retry.packet : await conversation.encrypt(text);
      retry = { text, packet };
      await directRequest(connectionId, "direct.send", packet);
      retry = undefined;
      if (draft === text) draft = "";
      await scrollToBottom();
    } catch (cause) {
      error = messageFrom(cause);
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
  <LockKeyhole size={18} aria-label="End-to-end encryption" />
</header>

{#if mode === "verified" && conversation}
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
        <ChatMessage {message} previous={messages[index - 1]} {name}>
          {#await conversation.decrypt(message)}
            <p class="text-muted-foreground">Decrypting…</p>
          {:then text}
            <p>{text}</p>
          {:catch}
            <p class="form-error">Message could not be verified or decrypted.</p>
          {/await}
        </ChatMessage>
      {:else}
        <div class="chat-empty">
          <LockKeyhole size={23} />
          <p>{policy.persistent && !historyLoaded && !historyError ? "Loading messages…" : "No messages yet."}</p>
        </div>
      {/each}
    </div>
    {#if error}<p class="form-error px-3" role="alert">{error}</p>{/if}
    {#if !online && !policy.persistent}
      <p class="px-3 text-sm text-muted-foreground">This contact is offline. The server does not retain direct messages.</p>
    {:else if !canSendDirectMessages}
      <p class="px-3 text-sm text-muted-foreground">Your role cannot send direct messages on this server.</p>
    {/if}
    <form class="composer" onsubmit={send}>
      <Textarea rows={2} maxlength={policy.maxBytes} disabled={!canSend || pending}
        aria-label="Encrypted message" placeholder="Write a direct message" bind:value={draft} />
      <Button type="submit" aria-label="Send direct message" disabled={!canSend || pending || !draft.trim()}><Send size={18} /></Button>
    </form>
  </section>
{:else}
  <div class="workspace">
    {#if error}<p class="form-error" role="alert">{error}</p>{/if}
    {#if mode === "loading"}
      <p role="status">Loading conversation…</p>
    {:else if mode === "error"}
      <Button class="self-start" variant="outline" onclick={open}>Retry</Button>
    {:else}
      <form class="dialog-form max-w-xl" onsubmit={verifyContact}>
        <h3 class="font-semibold">Verify this conversation</h3>
        <p class="text-sm">Ask {peer?.displayName} to open this conversation and share their safety code with you in person or through a trusted channel.</p>
        <p class="rounded-lg border p-3 font-mono select-all">{safetyCode}</p>
        <label>Safety code from your contact <Input required bind:value={confirmation} spellcheck={false} autocomplete="off" /></label>
        <Button type="submit" class="justify-self-start" disabled={verificationPending}>Verify safety code</Button>
      </form>
    {/if}
  </div>
{/if}
