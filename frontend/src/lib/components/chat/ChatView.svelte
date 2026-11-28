<script lang="ts">
  import { CircleAlert, Download, Headphones, MessageCircle, Pencil, PhoneOff } from "@lucide/svelte";
  import { tick } from "svelte";
  import ChatComposer from "#lib/components/chat/ChatComposer.svelte";
  import ChatMessage from "#lib/components/chat/ChatMessage.svelte";
  import RichMessage from "#lib/components/chat/RichMessage.svelte";
  import IconButton from "#lib/components/IconButton.svelte";
  import ScreenSharing from "#lib/components/media/ScreenSharing.svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import { downloadAttachment } from "#lib/chat/chat-attachments";
  import { maxChatTextLength } from "#lib/chat/rich-chat";
  import type { Channel } from "#lib/connection/client";
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
    if (messages.length && messageList &&
      (channelChanged || messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 90)) {
      void scrollMessages();
    }
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

  async function leaveChannel() {
    if (await run("leave", "leave_channel")) playUiSound("disconnect");
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
    <div class="chat-log" {@attach attachMessageList} role="log" aria-label="Channel messages">
      {#if canRead && messages.length}
        {#each messages as entry, index (entry.id)}
          {@const own = entry.senderId === me?.id}
          <ChatMessage message={entry} previous={messages[index - 1]} name={senderName(entry.senderId)}
            editText={own && canChat ? entry.text : undefined} editLimit={maxChatTextLength}
            onedit={own && canChat ? (text) => changeMessage("message-edit", "edit_message", { messageId: entry.id, text }) : undefined}
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
