<script lang="ts">
  import { LockKeyhole, Pencil, X } from "@lucide/svelte";
  import DirectMessages from "#lib/components/chat/DirectMessages.svelte";
  import ChatView from "#lib/components/chat/ChatView.svelte";
  import IconButton from "#lib/components/IconButton.svelte";
  import Modal from "#lib/components/Modal.svelte";
  import PaneDivider from "#lib/components/PaneDivider.svelte";
  import ChannelForm from "#lib/components/server/ChannelForm.svelte";
  import ChannelPane from "#lib/components/server/ChannelPane.svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import type { Channel } from "#lib/connection/client";
  import { voiceApp } from "#lib/connection/platform";
  import { forgetPassword, getSavedPassword, savePassword } from "#lib/preferences";
  import { playUiSound } from "#lib/ui-sounds";
  import { getWorkspace } from "#lib/workspace";

  const workspace = getWorkspace();
  const voiceAvailable = voiceApp();
  const { run } = workspace;
  const view = $derived(workspace.view);
  const pending = $derived(workspace.pending);
  const actionError = $derived(workspace.actionError);
  let createChannelOpen = $state(false);
  let editingChannel = $state.raw<Channel | null>(null);
  let channelFooter = $state<HTMLDivElement>();
  let passwordOpen = $state(false);
  let channelPassword = $state("");
  let joining = $state.raw<{ channel: Channel; connectionId: string } | null>(null);
  let deleteChannelOpen = $state(false);
  let deletingChannel = $state.raw<{ channel: Channel; connectionId: string } | null>(null);

  let snapshot = $derived(view.snapshot);
  let online = $derived(view.phase === "online");
  let activeChannel = $derived(snapshot?.channels.find((channel) => channel.id === snapshot?.channelId));
  let channelsById = $derived(new Map(snapshot?.channels.map((channel) => [channel.id, channel])));

  function attachFooter(element: HTMLDivElement) {
    channelFooter = element;
    return () => {
      if (channelFooter === element) channelFooter = undefined;
    };
  }

  async function joinChannel(channel: Channel) {
    workspace.roomView = "chat";
    workspace.selectedChannelId = channel.id;
    workspace.mobilePane = "room";
    workspace.actionError = "";
    const connectionId = snapshot?.connectionId;
    if (!online || !connectionId || pending || activeChannel?.id === channel.id) return;
    if (!channel.passwordRequired) {
      if (await run("join", "join_channel", { channelId: channel.id, password: null })) playUiSound("channel");
      return;
    }

    const { serverOrigin, serverId } = workspace;
    const saved = await getSavedPassword(serverOrigin, serverId, channel.id).catch(() => undefined);
    if (connectionId !== snapshot?.connectionId || workspace.selectedChannelId !== channel.id || !online || pending) return;
    if (saved) {
      if (await run("join", "join_channel", { channelId: channel.id, password: saved })) {
        playUiSound("channel");
        return;
      }
      // Older servers use the generic FORBIDDEN message for a rejected password.
      const message = actionError.replace(/^FORBIDDEN: /, "");
      if (message !== "Incorrect channel password." && message !== "Operation not permitted") return;
      void forgetPassword(serverOrigin, serverId, channel.id, saved).catch(() => {});
    }

    if (connectionId !== snapshot?.connectionId) return;
    joining = { channel, connectionId };
    channelPassword = "";
    passwordOpen = true;
  }

  async function submitPassword(event: SubmitEvent) {
    event.preventDefault();
    if (!joining || joining.connectionId !== snapshot?.connectionId || !online) return;
    const { serverOrigin, serverId } = workspace;
    const { id } = joining.channel;
    const password = channelPassword;
    if (await run("join", "join_channel", { channelId: id, password })) {
      playUiSound("channel");
      passwordOpen = false;
      channelPassword = "";
      joining = null;
      void savePassword(serverOrigin, serverId, password, id).catch(() => {
        if (serverOrigin === workspace.serverOrigin) workspace.actionError = "This device could not save the channel password.";
      });
    }
  }

  function showChannelForm(channel: Channel | null = null) {
    if (channel) {
      workspace.roomView = "chat";
      workspace.selectedChannelId = channel.id;
      workspace.mobilePane = "room";
      workspace.actionError = "";
    } else {
      if (workspace.roomView === "channelSettings") workspace.roomView = "chat";
      workspace.actionError = "";
    }
    editingChannel = channel;
    if (channel) workspace.roomView = "channelSettings";
    else createChannelOpen = true;
  }

  function closeChannelSettings() {
    if (workspace.roomView === "channelSettings") workspace.roomView = "chat";
  }

  function channelSaved() {
    createChannelOpen = false;
    closeChannelSettings();
  }

  function confirmChannelDeletion(channel: Channel) {
    if (!snapshot) return;
    workspace.actionError = "";
    deletingChannel = { channel, connectionId: snapshot.connectionId };
    deleteChannelOpen = true;
  }

  async function deleteChannel() {
    if (!online || !deletingChannel || deletingChannel.connectionId !== snapshot?.connectionId) return;
    const { id } = deletingChannel.channel;
    if (!channelsById.get(id)?.canDelete) return;
    const { serverOrigin, serverId } = workspace;
    if (await run("channel-delete", "delete_channel", { channelId: id })) {
      deleteChannelOpen = false;
      deletingChannel = null;
      void forgetPassword(serverOrigin, serverId, id).catch(() => {});
    }
  }
</script>

<ChannelPane
  onjoin={joinChannel}
  oncreate={() => showChannelForm()}
  onedit={showChannelForm}
  ondelete={confirmChannelDeletion}
  onfooter={attachFooter}
/>

<PaneDivider label="Resize channel tree" controls="channel-pane" value={workspace.channelWidth} min={222} max={workspace.channelMax} resize={workspace.resizeChannel} />

<main class="room-pane">
  {#if workspace.serverSettings}
    {@render workspace.serverSettings()}
  {:else if workspace.roomView === "directMessages" && online && snapshot?.directMessages && workspace.serverId}
    {#key snapshot.connectionId}
      <DirectMessages />
    {/key}
  {:else if workspace.roomView === "channelSettings" && editingChannel}
    <header class="workspace-header">
      <div class="heading-icon"><Pencil size={19} aria-hidden="true" /></div>
      <div class="flex-content">
        <div class="breadcrumb truncate">{editingChannel.name}</div>
        <h2 tabindex="-1" {@attach (heading) => heading.focus()}>Channel settings</h2>
      </div>
      <IconButton label="Back to chat" disabled={pending === "channel-save"} onclick={closeChannelSettings}><X size={18} aria-hidden="true" /></IconButton>
    </header>
    <div class="workspace">
      {#key editingChannel.id}
        <ChannelForm editing={editingChannel} onsaved={channelSaved} />
      {/key}
    </div>
  {:else}
    <ChatView onjoin={joinChannel} onedit={showChannelForm} footer={channelFooter} />
  {/if}
</main>


<Modal bind:open={() => passwordOpen && joining?.connectionId === snapshot?.connectionId, (open) => {
  passwordOpen = open;
  if (!open) { channelPassword = ""; joining = null; }
}} title={joining ? `Join ${joining.channel.name}` : "Join channel"} description="Enter the password for this channel." dismissible={pending !== "join"}>
  {#snippet icon()}<LockKeyhole size={21} />{/snippet}
  {#if actionError}<p class="form-error" role="alert">{actionError}</p>{/if}
  <form class="dialog-form" onsubmit={submitPassword}>
    <label>Channel password<Input type="password" required maxlength={128} bind:value={channelPassword} /></label>
    <Button variant="default" type="submit" disabled={Boolean(pending)}>{pending === "join" ? "Joining…" : voiceAvailable ? "Join voice" : "Join channel"}</Button>
  </form>
</Modal>

<Modal bind:open={() => deleteChannelOpen && deletingChannel?.connectionId === snapshot?.connectionId, (open) => { deleteChannelOpen = open; }}
  title="Delete channel?" description={deletingChannel ? `This permanently deletes ${deletingChannel.channel.name} and its messages.` : "This permanently deletes the channel and its messages."}
  dismissible={pending !== "channel-delete"}>
  {#if actionError}<p class="form-error" role="alert">{actionError}</p>{/if}
  <div class="dialog-actions">
    <Button variant="outline" disabled={pending === "channel-delete"} onclick={() => { deleteChannelOpen = false; }}>Cancel</Button>
    <Button variant="destructive" disabled={Boolean(pending) || !deletingChannel || !channelsById.get(deletingChannel.channel.id)?.canDelete}
      onclick={deleteChannel}>{pending === "channel-delete" ? "Deleting…" : "Delete channel"}</Button>
  </div>
</Modal>

{#if createChannelOpen}
  <Modal bind:open={createChannelOpen} title="Create a channel" description="Add a voice channel to this server." dismissible={pending !== "channel-save"}>
    <ChannelForm editing={null} onsaved={channelSaved} />
  </Modal>
{/if}
