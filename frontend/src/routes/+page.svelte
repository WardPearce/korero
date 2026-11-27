<script lang="ts">
  import { BitsConfig } from "bits-ui";
  import { Button } from "#lib/components/ui/button/index.js";
  import Checkbox from "#lib/components/fields/LabeledCheckbox.svelte";
  import { Input } from "#lib/components/ui/input/index.js";
  import SelectField from "#lib/components/fields/SelectField.svelte";
  import VoiceBitrateField from "#lib/components/fields/VoiceBitrateField.svelte";
  import { Textarea } from "#lib/components/ui/textarea/index.js";
  import {
    ChevronDown, CircleAlert, PhoneOff, Headphones,
    ListTree, LockKeyhole, MessageCircle, Pencil, Plus, Search,
    Download, Mail, Server, X,
  } from "@lucide/svelte";
  import { tick } from "svelte";
  import ChannelMember from "#lib/components/server/ChannelMember.svelte";
  import ContextActions from "#lib/components/ContextActions.svelte";
  import IconButton from "#lib/components/IconButton.svelte";
  import Modal from "#lib/components/Modal.svelte";
  import PaneDivider from "#lib/components/PaneDivider.svelte";
  import VoiceToolbar from "#lib/components/media/VoiceToolbar.svelte";
  import { playUiSound } from "#lib/ui-sounds";
  import { forgetPassword, getSavedPassword, savePassword } from "#lib/preferences";
  import type { Channel, Member } from "#lib/connection/client";
  import { voiceApp } from "#lib/connection/platform";
  import ChatComposer from "#lib/components/chat/ChatComposer.svelte";
  import ChatMessage from "#lib/components/chat/ChatMessage.svelte";
  import DirectMessages from "#lib/components/chat/DirectMessages.svelte";
  import RichMessage from "#lib/components/chat/RichMessage.svelte";
  import ScreenSharing from "#lib/components/media/ScreenSharing.svelte";
  import { downloadAttachment } from "#lib/chat/chat-attachments";
  import { getWorkspace, type ChannelPlacement } from "#lib/workspace";
  import { maxChatTextLength } from "#lib/chat/rich-chat";

  const workspace = getWorkspace();
  const voiceAvailable = voiceApp();
  const { run } = workspace;
  const view = $derived(workspace.view);
  const serverTitle = $derived(workspace.serverTitle);
  const pending = $derived(workspace.pending);
  const actionError = $derived(workspace.actionError);
  let createChannelOpen = $state(false);
  let channelForm = $state<HTMLFormElement>();
  let channelFooter = $state<HTMLDivElement>();
  let editingChannel = $state.raw<Channel | null>(null);
  let newChannelName = $state("");
  let channelDescription = $state("");
  let channelCapacity = $state<number | undefined>();
  let parentChannelId = $state("");
  let newChannelPassword = $state("");
  let removeChannelPassword = $state(false);
  let channelFormOrigin = "";
  let backgroundImageUrl = $state("");
  let channelIcon = $state("");
  let passwordOpen = $state(false);
  let channelPassword = $state("");
  let joining = $state.raw<{ channel: Channel; connectionId: string } | null>(null);
  let deleteChannelOpen = $state(false);
  let deletingChannel = $state.raw<{ channel: Channel; connectionId: string } | null>(null);
  let search = $state("");
  let channelSearchOpen = $state(false);
  let collapsed = $state<string[]>([]);
  let channelAudioBitrate = $state<number | null>(null);
  let messageList: HTMLDivElement | undefined;
  let lastChatChannel: string | null | undefined;
  let knownMessageIds = new Set<string>();
  let initializedMessages = false;
  type MemberSelection = { connectionId: string; members: ReadonlyMap<string, string> };
  const memberDragType = "application/x-korero-members";
  let memberSelection = $state.raw<MemberSelection | null>(null);
  let draggedMembers = $state.raw<MemberSelection | null>(null);
  let draggedChannel = $state.raw<{ id: string; origin: string } | null>(null);
  let dropTarget = $state.raw<{ id: string; placement: ChannelPlacement } | null>(null);

  let snapshot = $derived(view.snapshot);
  let channelsById = $derived(new Map(snapshot?.channels.map((channel) => [channel.id, channel])));
  let channelsByParent = $derived.by(() => {
    const groups = new Map<string | null, Channel[]>();
    for (const channel of snapshot?.channels ?? []) {
      const siblings = groups.get(channel.parentId);
      if (siblings) siblings.push(channel);
      else groups.set(channel.parentId, [channel]);
    }
    return groups;
  });
  let me = $derived(snapshot?.account);
  let online = $derived(view.phase === "online");
  const movableMembers = $derived(new Map((snapshot?.channels ?? []).flatMap((channel) =>
    channel.canMove ? membersIn(channel.id)
      .filter((member) => member.accountId !== me?.id && member.role && snapshot?.lowerRoles?.includes(member.role))
      .map((member) => [member.connectionId, channel.id] as const) : [])));
  const selectedMembers = $derived(new Map(
    memberSelection && online && memberSelection.connectionId === snapshot?.connectionId
      ? [...memberSelection.members].filter(([id, channelId]) => movableMembers.get(id) === channelId)
      : [],
  ));
  let activeChannel = $derived(snapshot?.channels.find((channel) => channel.id === snapshot?.channelId));
  let currentChannel = $derived(snapshot?.channels.find((channel) => channel.id === workspace.selectedChannelId) ?? activeChannel ?? snapshot?.channels[0]);
  let isInRoom = $derived(Boolean(currentChannel && activeChannel?.id === currentChannel.id));
  let filteredChannels = $derived(
    search.trim() ? (snapshot?.channels ?? []).filter((channel) => channel.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) : [],
  );
  let canCreate = $derived(online && Boolean(snapshot?.serverPermissions.includes("createChannels")));
  let canReorder = $derived(online && Boolean(snapshot?.canReorderChannels) && !search.trim() && !pending);
  let canChat = $derived(online && isInRoom && snapshot?.canSendText !== false);
  let canSetAudioBitrate = $derived(workspace.channelAudioQuality && (editingChannel
    ? editingChannel.canSetAudioBitrate
    : snapshot?.serverPermissions.includes("manageSettings")));
  let canSetChannelAccess = $derived(editingChannel?.canSetPassword !== false);
  let possibleParents = $derived((snapshot?.channels ?? []).filter((parent, _, all) => {
    for (let candidate: Channel | undefined = parent; candidate; candidate = all.find(({ id }) => id === candidate?.parentId)) {
      if (candidate.temporary || candidate.id === editingChannel?.id) return false;
    }
    return true;
  }));
  const topLevel = "Top level";
  const topLevelValue = "top-level";
  const parentOptions = $derived.by(() => {
    const options = [{ id: "", label: topLevel, value: topLevelValue }];
    const labels = new Set([topLevel]);
    for (const parent of possibleParents) {
      let label = parent.name;
      for (let number = 2; labels.has(label); number++) label = `${parent.name} (${number})`;
      labels.add(label);
      options.push({ id: parent.id, label, value: `channel:${parent.id}` });
    }
    return options;
  });
  const selectedParent = $derived(parentOptions.find(({ id }) => id === parentChannelId)?.value ?? "");

  $effect.pre(() => {
    // Measure the old viewport before Svelte inserts messages.
    const channel = view.snapshot?.channelId;
    const channelChanged = channel !== lastChatChannel;
    lastChatChannel = channel;
    const messages = view.messages;
    const latestId = messages.at(-1)?.id;
    if (!initializedMessages) {
      knownMessageIds = new Set(messages.map(({ id }) => id));
      initializedMessages = true;
    } else if (isInRoom && currentChannel?.id === channel) {
      const newIncoming = messages.some((entry) => entry.id === latestId && !knownMessageIds.has(entry.id) && entry.senderId !== me?.id);
      if (newIncoming) playUiSound("message");
      knownMessageIds = new Set(messages.map(({ id }) => id));
    } else {
      knownMessageIds = new Set(messages.map(({ id }) => id));
    }
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
    memberSelection = null;
    workspace.roomView = "chat";
    workspace.selectedChannelId = channel.id;
    workspace.mobilePane = "room";
    workspace.actionError = "";
  }

  async function joinChannel(channel: Channel) {
    selectChannel(channel);
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

  async function leaveChannel() {
    if (await run("leave", "leave_channel")) playUiSound("disconnect");
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

  function showChannelForm(channel: Channel | null = null) {
    if (channel) selectChannel(channel);
    else {
      if (workspace.roomView === "channelSettings") workspace.roomView = "chat";
      workspace.actionError = "";
    }
    channelFormOrigin = workspace.serverOrigin;
    editingChannel = channel;
    newChannelName = channel?.name ?? "";
    channelDescription = channel?.description ?? "";
    channelCapacity = channel?.capacity ?? undefined;
    channelAudioBitrate = channel?.audioBitrate ?? null;
    parentChannelId = channel?.parentId ?? "";
    newChannelPassword = "";
    removeChannelPassword = false;
    backgroundImageUrl = channel?.backgroundImageUrl ?? "";
    channelIcon = channel?.icon ?? "";
    if (channel) workspace.roomView = "channelSettings";
    else createChannelOpen = true;
  }

  function closeChannelSettings() {
    if (workspace.roomView === "channelSettings") workspace.roomView = "chat";
    newChannelPassword = "";
  }

  function selectParent(value: string) {
    const parent = parentOptions.find((option) => option.value === value);
    if (parent) parentChannelId = parent.id;
  }

  async function saveChannel(event: SubmitEvent) {
    event.preventDefault();
    if (!online || channelFormOrigin !== workspace.serverOrigin) {
      workspace.actionError = "Reconnect to this server to save the channel.";
      return;
    }
    const payload: Record<string, unknown> = { name: newChannelName.trim(), description: channelDescription };
    if (editingChannel) payload.channelId = editingChannel.id;
    if (canSetAudioBitrate && channelAudioBitrate !== (editingChannel?.audioBitrate ?? null)) payload.audioBitrate = channelAudioBitrate;
    if (workspace.channelBackgrounds) payload.backgroundImageUrl = backgroundImageUrl.trim() || null;
    if (workspace.channelIcons) payload.icon = channelIcon.trim() || null;
    if (canSetChannelAccess) {
      if (parentChannelId !== (editingChannel?.parentId ?? "")) payload.parentId = parentChannelId || null;
      if (channelCapacity !== (editingChannel?.capacity ?? undefined)) payload.capacity = channelCapacity ?? null;
      if (removeChannelPassword) payload.password = null;
      else if (newChannelPassword) payload.password = newChannelPassword;
    }
    if (await run("channel-save", "save_channel", { payload })) {
      createChannelOpen = false;
      closeChannelSettings();
    }
  }

  function toggleGroup(id: string) {
    collapsed = collapsed.includes(id) ? collapsed.filter((item) => item !== id) : [...collapsed, id];
  }

  function channelActions(channel: Channel) {
    const actions = [];
    if (channel.canEdit) actions.push({ label: "Edit channel", onSelect: () => showChannelForm(channel) });
    if (channel.canDelete) actions.push({ label: "Delete channel", onSelect: () => confirmChannelDeletion(channel) });
    if (!channel.canEdit || !canReorder) return actions;
    const siblings = channelsByParent.get(channel.parentId) ?? [];
    const index = siblings.findIndex(({ id }) => id === channel.id);
    const previous = siblings[index - 1];
    const next = siblings[index + 1];
    const parent = channel.parentId ? channelsById.get(channel.parentId) : undefined;
    if (previous?.canEdit) actions.push({ label: "Move up", onSelect: () => { void placeChannel(channel, previous, "before"); } });
    if (next?.canEdit) actions.push({ label: "Move down", onSelect: () => { void placeChannel(channel, next, "after"); } });
    if (previous && canPlaceChannel(channel, previous, "inside")) {
      actions.push({ label: "Move into previous channel", onSelect: () => { void placeChannel(channel, previous, "inside"); } });
    }
    if (parent && canPlaceChannel(channel, parent, "after")) {
      actions.push({ label: "Move out of parent", onSelect: () => { void placeChannel(channel, parent, "after"); } });
    }
    return actions;
  }

  function canPlaceChannel(source: Channel, target: Channel, placement: ChannelPlacement) {
    if (!source.canEdit || !target.canEdit || source.id === target.id) return false;
    const parentId = placement === "inside" ? target.id : target.parentId;
    if (placement !== "inside" && source.parentId === parentId) return true;
    if (!source.canReparent) return false;
    if (!parentId) return true;
    const parent = channelsById.get(parentId);
    if (!parent?.canEdit || parent.temporary) return false;
    for (let ancestor: Channel | undefined = parent; ancestor; ancestor = channelsById.get(ancestor.parentId ?? "")) {
      if (ancestor.id === source.id) return false;
    }
    return true;
  }

  async function placeChannel(source: Channel, target: Channel, placement: ChannelPlacement) {
    if (!canReorder || !canPlaceChannel(source, target, placement)) return;
    const origin = workspace.serverOrigin;
    const parentId = placement === "inside" ? target.id : target.parentId;
    if (await workspace.reorderChannel(source.id, target.id, placement, parentId === source.parentId ? undefined : parentId) &&
      parentId && workspace.serverOrigin === origin) {
      collapsed = collapsed.filter((id) => id !== parentId);
    }
  }

  function membersIn(channelId: string) {
    return snapshot?.channelMembers?.[channelId] ?? (snapshot?.channelId === channelId ? snapshot?.members ?? [] : []);
  }

  function toggleMemberSelection(channel: Channel, member: Member) {
    if (!snapshot || !online || pending || movableMembers.get(member.connectionId) !== channel.id) return;
    const members = new Map(selectedMembers);
    if (!members.delete(member.connectionId)) members.set(member.connectionId, channel.id);
    memberSelection = { connectionId: snapshot.connectionId, members };
  }

  function startMemberDrag(event: DragEvent, channel: Channel, member: Member) {
    if (!snapshot || !online || pending || movableMembers.get(member.connectionId) !== channel.id || !event.dataTransfer) {
      event.preventDefault();
      return;
    }
    endDrag();
    const selected = selectedMembers.has(member.connectionId);
    if (!selected) memberSelection = null;
    draggedMembers = {
      connectionId: snapshot.connectionId,
      members: selected ? selectedMembers : new Map([[member.connectionId, channel.id]]),
    };
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(memberDragType, member.connectionId);
  }

  function memberDropIds(channel: Channel) {
    if (!draggedMembers || draggedMembers.connectionId !== snapshot?.connectionId || !online || pending || !channel.canMove) return [];
    const ids: string[] = [];
    for (const [id, sourceId] of draggedMembers.members) {
      if (movableMembers.get(id) !== sourceId) return [];
      if (sourceId !== channel.id) ids.push(id);
    }
    return ids;
  }

  async function moveMembers(channelId: string, connectionIds: string[]) {
    const selection = memberSelection;
    const payload = connectionIds.length === 1 ? { channelId, connectionId: connectionIds[0] } : { channelId, connectionIds };
    if (await workspace.memberAction({ kind: "channel.move", payload }) && memberSelection === selection) memberSelection = null;
  }

  function startDrag(event: DragEvent, channel: Channel) {
    if (!canReorder || !channel.canEdit || !event.dataTransfer) {
      event.preventDefault();
      return;
    }
    endDrag();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-korero-channel", channel.id);
    draggedChannel = { id: channel.id, origin: workspace.serverOrigin };
  }

  function dragPlacement(event: DragEvent & { currentTarget: HTMLDivElement }, source: Channel, target: Channel): ChannelPlacement | null {
    const bounds = event.currentTarget.getBoundingClientRect();
    const offset = (event.clientY - bounds.top) / bounds.height;
    let placement: ChannelPlacement = offset < 0.5 ? "before" : "after";
    if (source.canReparent !== undefined && offset >= 0.25 && offset <= 0.75) placement = "inside";
    return canPlaceChannel(source, target, placement) ? placement : null;
  }

  function dragSource() {
    if (canReorder && draggedChannel?.origin === workspace.serverOrigin) return channelsById.get(draggedChannel.id);
  }

  function dragOver(event: DragEvent & { currentTarget: HTMLDivElement }, channel: Channel) {
    let placement: ChannelPlacement | null | undefined;
    if (event.dataTransfer?.types.includes(memberDragType)) {
      placement = memberDropIds(channel).length ? "inside" : null;
    } else {
      const source = dragSource();
      placement = source && dragPlacement(event, source, channel);
    }
    if (!placement) {
      dropTarget = null;
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    if (dropTarget?.id !== channel.id || dropTarget.placement !== placement) dropTarget = { id: channel.id, placement };
  }

  function endDrag() {
    draggedMembers = null;
    draggedChannel = null;
    dropTarget = null;
  }

  function dropChannel(event: DragEvent & { currentTarget: HTMLDivElement }, channel: Channel) {
    if (event.dataTransfer?.types.includes(memberDragType)) {
      const ids = memberDropIds(channel);
      endDrag();
      if (ids.length) {
        event.preventDefault();
        void moveMembers(channel.id, ids);
      }
      return;
    }
    const source = dragSource();
    if (!source) return;
    const placement = dragPlacement(event, source, channel);
    endDrag();
    if (!placement) return;
    event.preventDefault();
    void placeChannel(source, channel, placement);
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

{#snippet channelRow(channel: Channel, depth: number, nested: boolean)}
  {@const children = nested ? channelsByParent.get(channel.id) ?? [] : []}
  {@const members = membersIn(channel.id)}
  {@const expandable = children.length > 0 || members.length > 0}
  {@const isActive = activeChannel?.id === channel.id}
  {@const isSelected = currentChannel?.id === channel.id}
  {@const image = channel.backgroundImageUrl?.startsWith("https://") ? channel.backgroundImageUrl : null}
  <li>
    <ContextActions disabled={!online || Boolean(pending)} actions={channelActions(channel)}>
      {#snippet trigger(props)}
    <div class="channel-row" role="group" data-selected={isSelected} data-drop={dropTarget?.id === channel.id ? dropTarget.placement : undefined}
      data-dragging={draggedChannel?.id === channel.id ? "" : undefined}
      ondragover={(event) => dragOver(event, channel)}
      ondragleave={(event) => {
        if (dropTarget?.id === channel.id && !(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) dropTarget = null;
      }}
      ondrop={(event) => dropChannel(event, channel)}
      style:--depth={Math.min(depth, 6)}>
      {#if image}
        {#key image}
          <img class="channel-background" src={image} alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer"
            onerror={(event) => { event.currentTarget.setAttribute("hidden", ""); }} />
        {/key}
      {/if}
      {#if expandable}
        <button type="button" class="tree-expander" onclick={() => toggleGroup(channel.id)} aria-label={collapsed.includes(channel.id) ? `Expand ${channel.name}` : `Collapse ${channel.name}`} aria-expanded={!collapsed.includes(channel.id)}>
          <ChevronDown size={13} class={collapsed.includes(channel.id) ? "collapsed-chevron" : ""} />
        </button>
      {/if}
      <button {...props} type="button" class="channel-target" data-leaf={expandable ? undefined : ""}
        aria-current={isSelected ? "true" : undefined} aria-describedby={isActive ? "joined-channel-description" : undefined}
        onclick={() => selectChannel(channel)} ondblclick={() => joinChannel(channel)} draggable={canReorder && channel.canEdit === true}
        ondragstart={(event) => startDrag(event, channel)} ondragend={endDrag}>
        {#if channel.icon}<span class="channel-icon" aria-hidden="true">{channel.icon}</span>{/if}
        <span class="truncate" title={channel.name}>{channel.name}</span>
        {#if channel.passwordRequired}
          <span class="channel-access access-lock" title="Password protected">
            <LockKeyhole size={14} aria-hidden="true" /><span class="sr-only">Password protected</span>
          </span>
        {/if}
        {#if isActive}<span class="joined-dot" title="Joined" aria-hidden="true"></span>{/if}
      </button>
    </div>
      {/snippet}
    </ContextActions>
    {#if members.length && !collapsed.includes(channel.id)}
      <ul class="member-list" aria-label={`Members in ${channel.name}`} style:--depth={Math.min(depth, 6)}>
        {#each members as member (member.connectionId)}
          {@const movable = movableMembers.get(member.connectionId) === channel.id}
          <ChannelMember {channel} {member} selected={selectedMembers.has(member.connectionId)}
            onToggleSelection={movable ? () => toggleMemberSelection(channel, member) : undefined}
            onDragStart={movable ? (event) => startMemberDrag(event, channel, member) : undefined}
            onDragEnd={endDrag} />
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
    <div class="shrinkable">
      <h1 class="truncate">{serverTitle}</h1>
    </div>
  </div>
  {#if online && snapshot}
    <div class="server-counts">
      {#if snapshot.totalUsers !== undefined}<span>{snapshot.totalUsers.toLocaleString()} total</span>{/if}
      <span class="online-count">{snapshot.presence.length.toLocaleString()} online</span>
    </div>
  {/if}
  <VoiceToolbar />
  {#if snapshot?.directMessages && workspace.serverId}
    <div class="border-b border-border px-3 py-2.5">
      <Button variant={workspace.roomView === "directMessages" ? "default" : "secondary"} class="w-full justify-start gap-2.5 font-semibold"
        aria-pressed={workspace.roomView === "directMessages"} onclick={() => workspace.showDirectMessages()}>
        <Mail size={16} aria-hidden="true" /> Direct messages
        {#if workspace.unreadDirectCount}
          <span class="ms-auto min-w-5 rounded-full bg-background px-1.5 text-center text-xs text-foreground">
            {workspace.unreadDirectCount}<span class="sr-only">{workspace.unreadDirectCount === 1 ? " unread message" : " unread messages"}</span>
          </span>
        {/if}
      </Button>
    </div>
  {/if}
  <div class="channel-search flex items-center gap-2">
    {#if channelSearchOpen}
      <Search class="pointer-events-none absolute start-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" size={16} aria-hidden="true" />
      <Input class="ps-8" aria-label="Find a channel" placeholder="Find a channel" bind:value={search} disabled={!snapshot?.channels.length} />
      <IconButton label="Close channel search" onclick={() => { channelSearchOpen = false; search = ""; }}><X size={16} aria-hidden="true" /></IconButton>
    {:else}
      <Button variant="outline" class="w-full justify-start" disabled={!snapshot?.channels.length} onclick={() => { channelSearchOpen = true; }}>
        <Search size={16} aria-hidden="true" /> Search channels
      </Button>
    {/if}
  </div>
  <div class="channel-scroll">
    <span id="joined-channel-description" class="sr-only">Joined</span>
    {#if snapshot?.channels.length}
      <ul class="channel-list">
        {#if search.trim()}
          {#each filteredChannels as channel (channel.id)}
            {@render channelRow(channel, 0, false)}
          {:else}
            <li class="channel-empty">No matching channels.</li>
          {/each}
        {:else}
          {#each channelsByParent.get(null) ?? [] as channel (channel.id)}
            {@render channelRow(channel, 0, true)}
          {/each}
        {/if}
      </ul>
    {:else}
      <div class="channel-empty"><p>{snapshot ? "No channels are available." : "Connect to view channels."}</p></div>
    {/if}
  </div>
  <div class="channel-footer" bind:this={channelFooter}>
    <Button variant="outline" title="Create channel" disabled={!canCreate || Boolean(pending)} onclick={() => showChannelForm()}>
      <Plus size={18} aria-hidden="true" /> Channel
    </Button>
    <div class="contents" bind:this={workspace.screenShareControlsTarget}></div>
  </div>
</aside>

<PaneDivider label="Resize channel tree" controls="channel-pane" value={workspace.channelWidth} min={222} max={workspace.channelMax} resize={workspace.resizeChannel} />

{#snippet chat()}
  <header class="workspace-header">
    <div class="heading-icon"><MessageCircle size={19} /></div>
    <div class="flex-content">
      <div class="breadcrumb">Channel chat</div>
      <h2 class="truncate">{currentChannel?.name ?? "Chats"}</h2>
    </div>
    {#if currentChannel?.canEdit}
      <IconButton label="Edit channel" disabled={!online || Boolean(pending)} onclick={() => showChannelForm(currentChannel)}><Pencil size={19} aria-hidden="true" /></IconButton>
    {/if}
    {#if currentChannel}
      <Button variant="outline" onclick={() => isInRoom ? leaveChannel() : joinChannel(currentChannel!)} disabled={!online || Boolean(pending)}>
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
    {#if online && snapshot?.channelId && channelFooter}
      {#key snapshot.connectionId + "/" + snapshot.channelId}
        <ScreenSharing {snapshot} controlsTarget={channelFooter} visible={Boolean(activeChannel)} source="camera" />
      {/key}
    {/if}
    <div class="contents" bind:this={workspace.screenShareViewerTarget}></div>
    <section class="chat-pane" aria-label="Channel chat">
      <div class="chat-log" {@attach attachMessageList} role="log" aria-label="Channel messages">
        {#if isInRoom && view.messages.length}
          {#each view.messages as entry, index (entry.id)}
            {@const own = entry.senderId === me?.id}
            <ChatMessage message={entry} previous={view.messages[index - 1]} name={senderName(entry.senderId)}
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
              <div><strong>{isInRoom ? "No messages yet" : "Channel messages appear here"}</strong><p>{isInRoom ? "Send a message to start the conversation." : "Join a channel to read and send messages."}</p></div>
            {/if}
          </div>
        {/if}
      </div>
      {#key (snapshot?.connectionId ?? "") + "/" + (currentChannel?.id ?? "")}
        <ChatComposer channelId={currentChannel?.id ?? ""} channelName={currentChannel?.name ?? ""} enabled={canChat} />
      {/key}
    </section>
  </div>
{/snippet}

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
      {@render channelFormFields()}
    </div>
  {:else}
    {@render chat()}
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

{#snippet channelFormFields()}
  <form class="dialog-form" bind:this={channelForm} onsubmit={saveChannel}>
    {#if actionError}<p class="form-error" role="alert">{actionError}</p>{/if}
    <label>Channel name<Input required maxlength={80} bind:value={newChannelName} /></label>
    <label>Description<Textarea rows={2} maxlength={1000} bind:value={channelDescription} /></label>
    {#if canSetChannelAccess}
      {#if channelForm}
        <BitsConfig defaultPortalTo={channelForm}>
          <SelectField label="Parent channel" options={parentOptions} placeholder="Current parent unavailable"
            bind:value={() => selectedParent, selectParent} />
        </BitsConfig>
      {/if}
      <label>Capacity<Input type="number" min="1" max="1024" placeholder="Server default" bind:value={channelCapacity} /></label>
      <label>{editingChannel?.passwordRequired ? "New password" : "Channel password"}
        <Input type="password" autocomplete="new-password" maxlength={128} disabled={removeChannelPassword} bind:value={newChannelPassword}
          placeholder={editingChannel?.passwordRequired ? "Leave blank to keep current password" : "Optional"} />
      </label>
      {#if editingChannel?.passwordRequired}
        <Checkbox label="Remove channel password" bind:checked={removeChannelPassword} />
      {/if}
    {/if}
    {#if canSetAudioBitrate && channelForm}
      <BitsConfig defaultPortalTo={channelForm}>
        <VoiceBitrateField label="Voice bitrate" defaultLabel="Server default"
          defaultBitrate={snapshot?.targetAudioBitrate} savedBitrate={editingChannel?.audioBitrate} bind:value={channelAudioBitrate} />
      </BitsConfig>
    {/if}
    {#if workspace.channelIcons}
      <label>Channel emoji <Input maxlength={16} placeholder="Optional, for example 🎮" autocomplete="off" spellcheck="false" bind:value={channelIcon} /></label>
      {#if editingChannel}<p class="field-hint">Clear the emoji to remove the channel icon.</p>{/if}
    {/if}
    {#if workspace.channelBackgrounds}
      <label>Background image URL <Input type="url" pattern="https://.+" maxlength={512} placeholder="https://example.com/channel.jpg"
        autocomplete="off" spellcheck="false" title="Use an HTTPS image URL" bind:value={backgroundImageUrl} /></label>
      {#if editingChannel}<p class="field-hint">Clear the URL to remove the background.</p>{/if}
    {/if}
    <Button variant="default" type="submit" disabled={Boolean(pending)}>{editingChannel ? "Save changes" : "Create channel"}</Button>
  </form>
{/snippet}

{#if createChannelOpen}
  <Modal bind:open={createChannelOpen} title="Create a channel" description="Add a voice channel to this server." dismissible={pending !== "channel-save"}>
    {@render channelFormFields()}
  </Modal>
{/if}

<style>
  .server-counts {
    display: flex;
    flex-wrap: wrap;
    gap: .25rem 1rem;
    padding: .35rem var(--ui-gap);
    border-bottom: 1px solid var(--border);
    color: var(--muted-foreground);
    font-size: var(--type-small);
  }
  .online-count { display: inline-flex; align-items: center; gap: .35rem; }
  .online-count::before { content: ""; width: .4rem; height: .4rem; border-radius: 50%; background: var(--success); }
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
