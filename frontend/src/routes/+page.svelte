<script lang="ts">
  import { DropdownMenu } from "bits-ui";
  import {
    ChevronDown, CircleAlert, DoorOpen, Headphones,
    HeadphoneOff, ImageIcon, ListTree, LockKeyhole, MessageCircle, Mic, MicOff, Plus, Search,
    Send, Server,
  } from "lucide-svelte";
  import { tick } from "svelte";
  import Avatar from "$lib/Avatar.svelte";
  import ChannelMember from "$lib/ChannelMember.svelte";
  import ContextActions from "$lib/ContextActions.svelte";
  import IconButton from "$lib/IconButton.svelte";
  import Modal from "$lib/Modal.svelte";
  import PaneDivider from "$lib/PaneDivider.svelte";
  import { messageTime, nativeApp, type Channel } from "$lib/client";
  import { getWorkspace } from "$lib/workspace";

  const workspace = getWorkspace();
  const voiceAvailable = nativeApp();
  const { run } = workspace;
  const view = $derived(workspace.view);
  const serverTitle = $derived(workspace.serverTitle);
  const pending = $derived(workspace.pending);
  const actionError = $derived(workspace.actionError);
  let channelFormOpen = $state(false);
  let editingChannel = $state.raw<Channel | null>(null);
  let newChannelName = $state("");
  let channelDescription = $state("");
  let channelCapacity = $state<number | undefined>();
  let parentChannelId = $state("");
  let newChannelPassword = $state("");
  let removeChannelPassword = $state(false);
  let channelFormOrigin = "";
  let backgroundImageUrl = $state("");
  let passwordOpen = $state(false);
  let channelPassword = $state("");
  let joining = $state.raw<Channel | null>(null);
  let search = $state("");
  let collapsed = $state<string[]>([]);
  let message = $state("");
  let afkFormOpen = $state(false);
  let afkMessage = $state("");
  let afkFormOrigin = $state("");
  let messageList: HTMLDivElement | undefined;
  let lastChatChannel: string | null | undefined;
  type Placement = "before" | "after";
  let draggedChannel = $state<{ id: string; origin: string } | null>(null);
  let dropTarget = $state<{ id: string; placement: Placement } | null>(null);

  let snapshot = $derived(view.snapshot);
  let me = $derived(snapshot?.account);
  let ownMember = $derived(snapshot?.members.find((member) => member.connectionId === snapshot?.connectionId));
  let online = $derived(view.phase === "online");
  let activeChannel = $derived(snapshot?.channels.find((channel) => channel.id === snapshot?.channelId));
  let currentChannel = $derived(snapshot?.channels.find((channel) => channel.id === workspace.selectedChannelId) ?? activeChannel ?? snapshot?.channels[0]);
  let isInRoom = $derived(Boolean(currentChannel && activeChannel?.id === currentChannel.id));
  let filteredChannels = $derived(
    search.trim() ? (snapshot?.channels ?? []).filter((channel) => channel.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) : [],
  );
  let canCreate = $derived(online && Boolean(snapshot?.serverPermissions.includes("createChannels")));
  let canReorder = $derived(online && Boolean(snapshot?.canReorderChannels) && !search.trim() && !pending);
  let canChat = $derived(online && isInRoom);
  let canVoice = $derived(voiceAvailable && online && Boolean(activeChannel));
  let canSetAfk = $derived(canVoice && ownMember?.afk !== undefined && !pending);
  let canSetChannelAccess = $derived(editingChannel?.canSetPassword !== false);
  let possibleParents = $derived((snapshot?.channels ?? []).filter((parent, _, all) => {
    for (let candidate: Channel | undefined = parent; candidate; candidate = all.find(({ id }) => id === candidate?.parentId)) {
      if (candidate.temporary || candidate.id === editingChannel?.id) return false;
    }
    return true;
  }));
  let voiceLabel = $derived(
    ownMember?.afk ? "AFK" : view.voice === "active" ? "Voice active" : view.voice === "muted" ? "Microphone muted" :
      view.voice === "deafened" ? "Deafened" : view.voice === "error" ? "Audio unavailable" : isInRoom ? "Voice connecting" : "Ready to join",
  );

  $effect.pre(() => {
    // Measure the old viewport before Svelte inserts messages.
    const channel = view.snapshot?.channelId;
    const channelChanged = channel !== lastChatChannel;
    lastChatChannel = channel;
    if (view.messages.length && messageList &&
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

  function selectChannel(channel: Channel) {
    workspace.selectedChannelId = channel.id;
    workspace.mobilePane = "room";
    workspace.actionError = "";
  }

  async function joinChannel(channel: Channel) {
    selectChannel(channel);
    if (!voiceAvailable) return;
    if (activeChannel?.id === channel.id) return;
    if (channel.passwordRequired) {
      joining = channel;
      channelPassword = "";
      passwordOpen = true;
    } else {
      await run("join", "join_channel", { channelId: channel.id, password: null });
    }
  }

  async function submitPassword(event: SubmitEvent) {
    event.preventDefault();
    if (!joining) return;
    if (await run("join", "join_channel", { channelId: joining.id, password: channelPassword })) {
      passwordOpen = false;
      channelPassword = "";
      joining = null;
    }
  }

  function showChannelForm(channel: Channel | null = null) {
    workspace.actionError = "";
    channelFormOrigin = workspace.serverOrigin;
    editingChannel = channel;
    newChannelName = channel?.name ?? "";
    channelDescription = channel?.description ?? "";
    channelCapacity = channel?.capacity ?? undefined;
    parentChannelId = channel?.parentId ?? "";
    newChannelPassword = "";
    removeChannelPassword = false;
    backgroundImageUrl = channel?.backgroundImageUrl ?? "";
    channelFormOpen = true;
  }

  async function saveChannel(event: SubmitEvent) {
    event.preventDefault();
    if (!online || channelFormOrigin !== workspace.serverOrigin) {
      workspace.actionError = "Reconnect to this server to save the channel.";
      return;
    }
    const payload: Record<string, unknown> = { name: newChannelName.trim(), description: channelDescription };
    if (editingChannel) payload.channelId = editingChannel.id;
    if (workspace.channelBackgrounds) payload.backgroundImageUrl = backgroundImageUrl.trim() || null;
    if (canSetChannelAccess) {
      if (parentChannelId !== (editingChannel?.parentId ?? "")) payload.parentId = parentChannelId || null;
      if (channelCapacity !== (editingChannel?.capacity ?? undefined)) payload.capacity = channelCapacity ?? null;
      if (removeChannelPassword) payload.password = null;
      else if (newChannelPassword) payload.password = newChannelPassword;
    }
    if (await run("channel-save", "save_channel", { payload })) {
      channelFormOpen = false;
      newChannelPassword = "";
    }
  }

  async function sendMessage(event: SubmitEvent) {
    event.preventDefault();
    const text = message.trim();
    if (!text || !canChat || pending) return;
    message = "";
    if (!(await run("message", "send_message", { text })) && !message) message = text;
  }

  function toggleAfk() {
    if (!canSetAfk) return;
    void run("afk", "set_presence", { afk: !ownMember?.afk, afkMessage: "" });
  }

  function showAfkForm() {
    workspace.actionError = "";
    afkFormOrigin = workspace.serverOrigin;
    afkMessage = ownMember?.afkMessage ?? "";
    afkFormOpen = true;
  }

  async function saveAfkMessage(event: SubmitEvent) {
    event.preventDefault();
    if (!canSetAfk || afkFormOrigin !== workspace.serverOrigin) return;
    if (await run("afk", "set_presence", { afk: true, afkMessage: afkMessage.trim() })) afkFormOpen = false;
  }

  function toggleGroup(id: string) {
    collapsed = collapsed.includes(id) ? collapsed.filter((item) => item !== id) : [...collapsed, id];
  }

  function channelActions(channel: Channel) {
    if (!channel.canEdit) return [];
    const actions = [{ label: "Edit channel", select: () => showChannelForm(channel) }];
    if (!canReorder) return actions;
    const siblings = snapshot?.channels.filter((item) => item.parentId === channel.parentId) ?? [];
    const index = siblings.findIndex(({ id }) => id === channel.id);
    const previous = siblings[index - 1];
    const next = siblings[index + 1];
    if (previous?.canEdit) actions.push({ label: "Move up", select: () => { void workspace.reorderChannel(channel.id, previous.id, "before"); } });
    if (next?.canEdit) actions.push({ label: "Move down", select: () => { void workspace.reorderChannel(channel.id, next.id, "after"); } });
    return actions;
  }

  function startDrag(event: DragEvent, channel: Channel) {
    if (!canReorder || !channel.canEdit || !event.dataTransfer) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", channel.id);
    draggedChannel = { id: channel.id, origin: workspace.serverOrigin };
  }

  function dragPlacement(event: DragEvent & { currentTarget: HTMLButtonElement }, channel: Channel): Placement | null {
    if (!canReorder || !channel.canEdit || draggedChannel?.origin !== workspace.serverOrigin) return null;
    const source = snapshot?.channels.find(({ id }) => id === draggedChannel?.id);
    if (!source?.canEdit || source.id === channel.id || source.parentId !== channel.parentId) return null;
    const bounds = event.currentTarget.getBoundingClientRect();
    return event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
  }

  function dragOver(event: DragEvent & { currentTarget: HTMLButtonElement }, channel: Channel) {
    const placement = dragPlacement(event, channel);
    if (!placement) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    if (dropTarget?.id !== channel.id || dropTarget.placement !== placement) dropTarget = { id: channel.id, placement };
  }

  function endDrag() {
    draggedChannel = null;
    dropTarget = null;
  }

  function dropChannel(event: DragEvent & { currentTarget: HTMLButtonElement }, channel: Channel) {
    const placement = dragPlacement(event, channel);
    if (!placement || !draggedChannel) return;
    event.preventDefault();
    const { id } = draggedChannel;
    endDrag();
    void workspace.reorderChannel(id, channel.id, placement);
  }

  function senderName(id: string) {
    if (id === me?.id) return me.displayName;
    return snapshot?.presence.find((person) => person.accountId === id)?.displayName
      ?? snapshot?.members.find((person) => person.accountId === id)?.displayName ?? "Channel member";
  }
</script>

{#snippet channelRow(channel: Channel, depth: number, nested: boolean)}
  {@const children = nested ? (snapshot?.channels ?? []).filter((item) => item.parentId === channel.id) : []}
  {@const members = snapshot?.channelMembers?.[channel.id] ?? (snapshot?.channelId === channel.id ? snapshot?.members ?? [] : [])}
  {@const isActive = activeChannel?.id === channel.id}
  {@const isSelected = currentChannel?.id === channel.id}
  {@const image = channel.backgroundImageUrl?.startsWith("https://") ? channel.backgroundImageUrl : null}
  <li>
    <ContextActions disabled={!online || Boolean(pending)} actions={channelActions(channel)}>
      {#snippet trigger({ props })}
    <div {...props} class="channel-row" data-selected={isSelected} data-drop={dropTarget?.id === channel.id ? dropTarget.placement : undefined}
      style:--depth={Math.min(depth, 6)}>
      {#if image}
        {#key image}
          <img class="channel-background" src={image} alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer"
            onerror={(event) => { event.currentTarget.setAttribute("hidden", ""); }} />
        {/key}
      {/if}
      {#if children.length || members.length}
        <button class="tree-expander" onclick={() => toggleGroup(channel.id)} aria-label={collapsed.includes(channel.id) ? `Expand ${channel.name}` : `Collapse ${channel.name}`} aria-expanded={!collapsed.includes(channel.id)}>
          <ChevronDown size={13} class={collapsed.includes(channel.id) ? "-rotate-90" : ""} />
        </button>
      {:else}
        <span class="tree-spacer"></span>
      {/if}
      <button class="channel-target" aria-current={isSelected ? "true" : undefined} aria-describedby={isActive ? "joined-channel-description" : undefined}
        onclick={() => selectChannel(channel)} ondblclick={() => joinChannel(channel)} draggable={canReorder && channel.canEdit === true}
        ondragstart={(event) => startDrag(event, channel)} ondragend={endDrag}
        ondragover={(event) => dragOver(event, channel)}
        ondragleave={(event) => {
          if (dropTarget?.id === channel.id && !(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) dropTarget = null;
        }}
        ondrop={(event) => dropChannel(event, channel)}>
        <span class="truncate" title={channel.name}>{channel.name}</span>
        {#if channel.passwordRequired}<small class="channel-access">Locked</small>{/if}
        {#if isActive}<span class="joined-dot" title="Joined" aria-hidden="true"></span>{/if}
      </button>
    </div>
      {/snippet}
    </ContextActions>
    {#if members.length && !collapsed.includes(channel.id)}
      <ul class="member-list" aria-label={`Members in ${channel.name}`} style:--depth={Math.min(depth, 6)}>
        {#each members as member (member.connectionId)}
          <ChannelMember {channel} {member} />
        {/each}
      </ul>
    {/if}
    {#if children.length && !collapsed.includes(channel.id)}
      <ul>
        {#each children as child (child.id)}
          {@render channelRow(child, depth + 1, true)}
        {/each}
      </ul>
    {/if}
  </li>
{/snippet}

<aside id="channel-pane" class="channel-pane" aria-label="Channels">
  <div class="channel-top">
    {#if workspace.bannerImageUrl}
      {#key workspace.bannerImageUrl}
        <img class="server-banner" src={workspace.bannerImageUrl} alt="" decoding="async" referrerpolicy="no-referrer"
          onerror={(event) => { event.currentTarget.setAttribute("hidden", ""); }} />
      {/key}
    {/if}
    <div class="server-tile"><Server size={22} strokeWidth={1.75} /></div>
    <div class="min-w-0">
      <h1 class="truncate">{serverTitle}</h1>
    </div>
  </div>
    <div class="voice-toolbar" aria-label="Voice controls">
      <IconButton label={ownMember?.muted ? "Unmute microphone" : "Mute microphone"} disabled={!canVoice || Boolean(pending) || ownMember?.adminMuted || ownMember?.afk} active={Boolean(ownMember?.muted || ownMember?.adminMuted)} onclick={() => run("mute", "set_presence", { muted: !ownMember?.muted, deafened: null })}>
        {#if ownMember?.muted || ownMember?.adminMuted}<MicOff size={18} />{:else}<Mic size={18} />{/if}
      </IconButton>
      <IconButton label={ownMember?.adminDeafened ? "Server deafened" : ownMember?.deafened ? "Undeafen" : "Deafen"}
        disabled={!canVoice || Boolean(pending) || ownMember?.afk || ownMember?.adminDeafened}
        active={Boolean(ownMember?.deafened || ownMember?.adminDeafened)}
        onclick={() => run("deafen", "set_presence", { muted: null, deafened: !ownMember?.deafened })}>
        {#if ownMember?.deafened || ownMember?.adminDeafened}<HeadphoneOff size={18} />{:else}<Headphones size={18} />{/if}
      </IconButton>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger class="icon-button afk-button" data-afk={ownMember?.afk} aria-label={ownMember?.afk ? "AFK status (away)" : "AFK status"} disabled={!canSetAfk}>
          AFK <ChevronDown size={12} aria-hidden="true" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content class="context-menu" align="start" sideOffset={4}
            onCloseAutoFocus={(event) => { if (afkFormOpen) event.preventDefault(); }}>
            <DropdownMenu.Item class="context-menu-item" onSelect={toggleAfk}>{ownMember?.afk ? "Return from AFK" : "Mark as AFK"}</DropdownMenu.Item>
            <DropdownMenu.Item class="context-menu-item" onSelect={showAfkForm}>Set AFK message</DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {#if activeChannel}
        <span class="toolbar-separator"></span>
        <IconButton label="Leave voice channel" disabled={!canVoice || Boolean(pending)} onclick={() => run("leave", "leave_channel")} class="leave-icon"><DoorOpen size={18} /></IconButton>
      {/if}
    </div>
  <div class="channel-search">
    <Search size={16} strokeWidth={1.8} />
    <input aria-label="Find a channel" placeholder="Find a channel" bind:value={search} disabled={!snapshot?.channels.length} />
  </div>
  <div class="channel-scroll">
    <span id="joined-channel-description" class="sr-only">Joined</span>
    <div class="section-label"><span><ListTree size={15} /> Channels</span>{#if snapshot}<small>{snapshot.channels.length}</small>{/if}</div>
    {#if snapshot?.channels.length}
      <ul class="channel-list">
        {#if search.trim()}
          {#each filteredChannels as channel (channel.id)}
            {@render channelRow(channel, 0, false)}
          {:else}
            <li class="channel-empty">No matching channels.</li>
          {/each}
        {:else}
          {#each snapshot.channels.filter((channel) => channel.parentId === null) as channel (channel.id)}
            {@render channelRow(channel, 0, true)}
          {/each}
        {/if}
      </ul>
    {:else}
      <div class="channel-empty"><p>{snapshot ? "No channels are available." : "Connect to view channels."}</p></div>
    {/if}
  </div>
  <div class="channel-footer">
    <button class="secondary-button" disabled={!canCreate || Boolean(pending)} onclick={() => showChannelForm()}><Plus size={18} /> Create channel</button>
    {#if activeChannel}<span>{voiceLabel}</span>{/if}
    <span>{snapshot ? `${snapshot.presence.length} online` : "No one online"}</span>
  </div>
</aside>

<PaneDivider label="Resize channel tree" controls="channel-pane" value={workspace.channelWidth} min={222} max={workspace.channelMax} resize={workspace.resizeChannel} />

<main class="room-pane">
  <header class="workspace-header">
    <div class="heading-icon"><MessageCircle size={19} /></div>
    <div class="min-w-0 grow">
      <div class="breadcrumb">Channel chat</div>
      <h2 class="truncate">{currentChannel?.name ?? "Chats"}</h2>
    </div>
    {#if currentChannel?.canEdit}
      <IconButton label="Edit channel" disabled={!online || Boolean(pending)} onclick={() => showChannelForm(currentChannel)}><ImageIcon size={19} /></IconButton>
    {/if}
    {#if currentChannel && !isInRoom}
      <button class="secondary-button" onclick={() => joinChannel(currentChannel!)} disabled={!online || Boolean(pending)}><Headphones size={16} /> Join voice</button>
    {/if}
  </header>

  <div class="workspace chat-workspace">
    {#if actionError || view.error || view.voiceError}
      <div class="notice" role="status"><CircleAlert size={17} /><span>{actionError || view.error || view.voiceError}</span></div>
    {/if}
    <section class="chat-pane" aria-label="Channel chat">
      <div class="chat-log" {@attach attachMessageList} role="log" aria-label="Channel messages">
        {#if isInRoom && view.messages.length}
          {#each view.messages as entry (entry.id)}
            {@const name = senderName(entry.senderId)}
            <article class="chat-message">
              <Avatar {name} />
              <div class="min-w-0 flex-1">
                <div class="chat-meta"><strong>{name}</strong><time datetime={new Date(entry.createdAt).toISOString()}>{messageTime.format(entry.createdAt)}</time></div>
                <p>{entry.text}</p>
              </div>
            </article>
          {/each}
        {:else}
          <div class="chat-empty">
            <MessageCircle size={23} strokeWidth={1.5} />
            <div><strong>{isInRoom ? "No messages yet" : "Channel messages appear here"}</strong><p>{isInRoom ? "Send a message to start the conversation." : "Join a voice channel to read and send messages."}</p></div>
          </div>
        {/if}
      </div>
      <form class="composer" onsubmit={sendMessage}>
        <input aria-label="Channel message" placeholder={canChat ? `Message #${currentChannel?.name}` : "Join a channel to send a message"} disabled={!canChat} maxlength={2000} bind:value={message} />
        <button type="submit" class="send-button" aria-label="Send message" disabled={!canChat || !message.trim() || Boolean(pending)}><Send size={17} /></button>
      </form>
    </section>
  </div>
</main>

<Modal bind:open={afkFormOpen} title="AFK message" description="People who can see your voice channel can read this message while you’re AFK." dismissible={pending !== "afk"}>
  {#if actionError}<p class="form-error" role="alert">{actionError}</p>{/if}
  <form class="dialog-form" onsubmit={saveAfkMessage}>
    <label>Message <input type="text" maxlength={120} placeholder="Optional" bind:value={afkMessage} /></label>
    <button class="primary-button justify-center" type="submit" disabled={!canSetAfk || afkFormOrigin !== workspace.serverOrigin}>
      {ownMember?.afk ? "Save message" : "Go AFK"}
    </button>
  </form>
</Modal>

<Modal bind:open={passwordOpen} title={joining ? `Join ${joining.name}` : "Join channel"} description="Enter the password for this channel." dismissible={pending !== "join"}>
  {#snippet icon()}<LockKeyhole size={21} />{/snippet}
  {#if actionError}<p class="form-error" role="alert">{actionError}</p>{/if}
  <form class="dialog-form" onsubmit={submitPassword}>
    <label>Channel password<input type="password" required bind:value={channelPassword} /></label>
    <button class="primary-button justify-center" type="submit" disabled={Boolean(pending)}>{pending === "join" ? "Joining…" : "Join voice"}</button>
  </form>
</Modal>

<Modal bind:open={channelFormOpen} title={editingChannel ? "Edit channel" : "Create a channel"}
  description={editingChannel ? editingChannel.name : "Add a voice channel to this server."} dismissible={pending !== "channel-save"}>
  {#if actionError}<p class="form-error" role="alert">{actionError}</p>{/if}
  <form class="dialog-form" onsubmit={saveChannel}>
    <label>Channel name<input required maxlength={80} bind:value={newChannelName} /></label>
    <label>Description<textarea rows="2" maxlength={1000} bind:value={channelDescription}></textarea></label>
    {#if canSetChannelAccess}
      <label>Parent channel
        <select bind:value={parentChannelId}>
          <option value="">Top level</option>
          {#each possibleParents as parent (parent.id)}<option value={parent.id}>{parent.name}</option>{/each}
        </select>
      </label>
      <label>Capacity<input type="number" min="1" max="1024" placeholder="Server default" bind:value={channelCapacity} /></label>
      <label>{editingChannel?.passwordRequired ? "New password" : "Channel password"}
        <input type="password" autocomplete="new-password" maxlength="128" disabled={removeChannelPassword} bind:value={newChannelPassword}
          placeholder={editingChannel?.passwordRequired ? "Leave blank to keep current password" : "Optional"} />
      </label>
      {#if editingChannel?.passwordRequired}
        <label class="checkbox-label"><input type="checkbox" bind:checked={removeChannelPassword} /> Remove channel password</label>
      {/if}
    {/if}
    {#if workspace.channelBackgrounds}
      <label>Background image URL <input type="url" pattern="https://.+" maxlength={512} placeholder="https://example.com/channel.jpg"
        autocomplete="off" spellcheck="false" title="Use an HTTPS image URL" bind:value={backgroundImageUrl} /></label>
      {#if editingChannel}<p class="field-hint">Clear the URL to remove the background.</p>{/if}
    {/if}
    <button class="primary-button justify-center" type="submit" disabled={Boolean(pending)}>{editingChannel ? "Save changes" : "Create channel"}</button>
  </form>
</Modal>
