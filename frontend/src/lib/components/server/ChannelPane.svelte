<script lang="ts">
  import { ChevronDown, LockKeyhole, Mail, Plus, Search, Settings2, X } from "@lucide/svelte";
  import ChannelMember from "#lib/components/server/ChannelMember.svelte";
  import ContextActions from "#lib/components/ContextActions.svelte";
  import IconButton from "#lib/components/IconButton.svelte";
  import VoiceToolbar from "#lib/components/media/VoiceToolbar.svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import type { Channel, Member } from "#lib/connection/client";
  import { getWorkspace, type ChannelPlacement } from "#lib/workspace";

  let { onjoin, oncreate, onedit, ondelete, onfooter }: {
    onjoin: (channel: Channel) => void;
    oncreate: () => void;
    onedit: (channel: Channel) => void;
    ondelete: (channel: Channel) => void;
    onfooter?: (element: HTMLDivElement) => () => void;
  } = $props();

  const workspace = getWorkspace();
  const view = $derived(workspace.view);
  const pending = $derived(workspace.pending);
  let search = $state("");
  let channelSearchOpen = $state(false);
  let collapsed = $state<string[]>([]);
  let collapsedServer = "";
  const collapsedStorageKey = "korero:collapsed-channels";

  function readCollapsed(serverId: string): string[] {
    if (!serverId) return [];
    try {
      const saved = JSON.parse(localStorage.getItem(`${collapsedStorageKey}:${serverId}`) ?? "null") as unknown;
      return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : [];
    } catch {
      return [];
    }
  }

  function persistCollapsed() {
    const serverId = workspace.serverId;
    if (!serverId) return;
    try {
      localStorage.setItem(`${collapsedStorageKey}:${serverId}`, JSON.stringify(collapsed));
    } catch {
      // An unavailable preference store keeps the tree working for this session.
    }
  }

  $effect(() => {
    const serverId = workspace.serverId;
    if (!serverId || serverId === collapsedServer) return;
    collapsedServer = serverId;
    collapsed = readCollapsed(serverId);
  });

  type MemberSelection = { connectionId: string; members: ReadonlyMap<string, string> };
  const memberDragType = "application/x-korero-members";
  let memberSelection = $state.raw<MemberSelection | null>(null);
  let draggedMembers = $state.raw<MemberSelection | null>(null);
  let draggedChannel = $state.raw<{ id: string; origin: string } | null>(null);
  type DropTarget = { id: string; placement: ChannelPlacement };
  let dropTarget = $state.raw<DropTarget | null>(null);
  let expandTimer: { id: string; timeout: ReturnType<typeof setTimeout> } | null = null;
  /** A locally applied channel arrangement shown until the server's snapshot catches up. */
  type Preview = { origin: string; order: { id: string; parentId: string | null }[]; key: string };
  let preview = $state.raw<Preview | null>(null);

  let snapshot = $derived(view.snapshot);
  let channels = $derived.by(() => {
    const live = snapshot?.channels ?? [];
    if (!preview || preview.origin !== workspace.serverOrigin) return live;
    const remaining = new Map(live.map((channel) => [channel.id, channel]));
    const placed = preview.order.flatMap(({ id, parentId }) => {
      const channel = remaining.get(id);
      if (!channel) return [];
      remaining.delete(id);
      return [channel.parentId === parentId ? channel : { ...channel, parentId }];
    });
    return [...placed, ...remaining.values()];
  });
  let channelsById = $derived(new Map(channels.map((channel) => [channel.id, channel])));
  let channelsByParent = $derived.by(() => {
    const groups = new Map<string | null, Channel[]>();
    for (const channel of channels) {
      const siblings = groups.get(channel.parentId);
      if (siblings) siblings.push(channel);
      else groups.set(channel.parentId, [channel]);
    }
    return groups;
  });
  let me = $derived(snapshot?.account);
  let online = $derived(view.phase === "online");
  const movableMembers = $derived(new Map(channels.flatMap((channel) =>
    channel.canMove ? membersIn(channel.id)
      .filter((member) => member.accountId !== me?.id && member.role && snapshot?.lowerRoles?.includes(member.role))
      .map((member) => [member.connectionId, channel.id] as const) : [])));
  const selectedMembers = $derived(new Map(
    memberSelection && online && memberSelection.connectionId === snapshot?.connectionId
      ? [...memberSelection.members].filter(([id, channelId]) => movableMembers.get(id) === channelId)
      : [],
  ));
  let activeChannel = $derived(channels.find((channel) => channel.id === snapshot?.channelId));
  let currentChannel = $derived(channels.find((channel) => channel.id === workspace.selectedChannelId) ?? activeChannel ?? channels[0]);
  let filteredChannels = $derived(
    search.trim() ? channels.filter((channel) => channel.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) : [],
  );
  let canCreate = $derived(online && Boolean(snapshot?.serverPermissions.includes("createChannels")));
  let canReorder = $derived(online && !search.trim() && !pending &&
    Boolean(snapshot?.canReorderChannels || snapshot?.channels.some((channel) => channel.canEdit)));

  function selectChannel(channel: Channel) {
    memberSelection = null;
    workspace.roomView = "chat";
    workspace.selectedChannelId = channel.id;
    workspace.mobilePane = "room";
    workspace.actionError = "";
  }

  function toggleGroup(id: string) {
    collapsed = collapsed.includes(id) ? collapsed.filter((item) => item !== id) : [...collapsed, id];
    persistCollapsed();
  }

  function channelActions(channel: Channel) {
    const actions = [];
    if (channel.canEdit) actions.push({ label: "Edit channel", onSelect: () => onedit(channel) });
    if (channel.canDelete) actions.push({ label: "Delete channel", onSelect: () => ondelete(channel) });
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

  /** Identifies a channel tree by each parent's ordered children, independent of how the flat list is ordered. */
  function arrangementKey(list: readonly { id: string; parentId: string | null }[]) {
    const groups = new Map<string, string[]>();
    for (const { id, parentId } of list) {
      const siblings = groups.get(parentId ?? "");
      if (siblings) siblings.push(id);
      else groups.set(parentId ?? "", [id]);
    }
    return [...groups].map(([parent, ids]) => `${parent}>${ids.join(",")}`).sort().join(";");
  }

  $effect(() => {
    if (preview && snapshot && arrangementKey(snapshot.channels) === preview.key) preview = null;
  });

  function previewPlacement(origin: string, source: Channel, target: Channel, placement: ChannelPlacement): Preview {
    const order = channels.filter(({ id }) => id !== source.id).map(({ id, parentId }) => ({ id, parentId }));
    const parentId = placement === "inside" ? target.id : target.parentId;
    const targetIndex = order.findIndex(({ id }) => id === target.id);
    const index = placement === "inside" ? order.length : targetIndex + (placement === "after" ? 1 : 0);
    order.splice(index, 0, { id: source.id, parentId });
    return { origin, order, key: arrangementKey(order) };
  }

  async function placeChannel(source: Channel, target: Channel, placement: ChannelPlacement) {
    if (!canReorder || !canPlaceChannel(source, target, placement)) return;
    const origin = workspace.serverOrigin;
    const parentId = placement === "inside" ? target.id : target.parentId;
    const shown = previewPlacement(origin, source, target, placement);
    preview = shown;
    if (parentId && collapsed.includes(parentId)) {
      collapsed = collapsed.filter((id) => id !== parentId);
      persistCollapsed();
    }
    const saved = await workspace.reorderChannel(source.id, target.id, placement, parentId === source.parentId ? undefined : parentId);
    if (preview !== shown) return;
    // The snapshot normally confirms the move first; never leave a stale arrangement on screen.
    if (!saved) preview = null;
    else setTimeout(() => { if (preview === shown) preview = null; }, 3000);
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

  function memberDropIds(channel: Channel, dragged = draggedMembers) {
    if (!dragged || dragged.connectionId !== snapshot?.connectionId || !online || pending || !channel.canMove) return [];
    const ids: string[] = [];
    for (const [id, sourceId] of dragged.members) {
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

  /** Resolves where a drop lands; dropping below an expanded parent goes before its first child, where the line is drawn. */
  function resolveDrop(source: Channel, target: Channel, placement: ChannelPlacement): DropTarget | null {
    const first = placement === "after" && !collapsed.includes(target.id) ? channelsByParent.get(target.id)?.[0] : undefined;
    if (first) return first.id !== source.id && canPlaceChannel(source, first, "before") ? { id: first.id, placement: "before" } : null;
    return canPlaceChannel(source, target, placement) ? { id: target.id, placement } : null;
  }

  function dragPlacement(event: DragEvent & { currentTarget: HTMLDivElement }, source: Channel, target: Channel): DropTarget | null {
    const bounds = event.currentTarget.getBoundingClientRect();
    const y = event.clientY - bounds.top;
    const half: ChannelPlacement = y < bounds.height / 2 ? "before" : "after";
    if (source.canReparent === undefined) return resolveDrop(source, target, half);
    // Only a thin band at each edge reorders; the rest of the row nests, and each falls back to the other when not allowed.
    const edge = Math.min(10, bounds.height / 4);
    const zone: ChannelPlacement = y < edge ? "before" : y > bounds.height - edge ? "after" : "inside";
    const order: ChannelPlacement[] = zone === "inside" ? ["inside", half] : [zone, "inside"];
    for (const placement of order) {
      const resolved = resolveDrop(source, target, placement);
      if (resolved) return resolved;
    }
    return null;
  }

  function dragSource() {
    if (canReorder && draggedChannel?.origin === workspace.serverOrigin) return channelsById.get(draggedChannel.id);
  }

  function clearExpandTimer() {
    if (expandTimer) clearTimeout(expandTimer.timeout);
    expandTimer = null;
  }

  /** Opens a collapsed channel after hovering a nesting drop over it, so deeper levels can be reached. */
  function scheduleExpand(target: DropTarget | null) {
    const id = target?.placement === "inside" && collapsed.includes(target.id) ? target.id : null;
    if (expandTimer?.id === id) return;
    clearExpandTimer();
    if (!id) return;
    expandTimer = {
      id,
      timeout: setTimeout(() => {
        expandTimer = null;
        if (!draggedChannel && !draggedMembers) return;
        collapsed = collapsed.filter((item) => item !== id);
        persistCollapsed();
      }, 600),
    };
  }

  function setDropTarget(target: DropTarget | null) {
    if (dropTarget?.id !== target?.id || dropTarget?.placement !== target?.placement) dropTarget = target;
    scheduleExpand(target);
  }

  function dragOver(event: DragEvent & { currentTarget: HTMLDivElement }, channel: Channel) {
    let target: DropTarget | null | undefined;
    if (event.dataTransfer?.types.includes(memberDragType)) {
      target = memberDropIds(channel).length ? { id: channel.id, placement: "inside" } : null;
    } else {
      const source = dragSource();
      target = source && dragPlacement(event, source, channel);
    }
    setDropTarget(target ?? null);
  }

  /** Keeps the last drop target while the pointer crosses the gaps between rows, so the indicator does not flicker. */
  function listDragOver(event: DragEvent) {
    if (!dropTarget || (!draggedChannel && !draggedMembers)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  }

  function listDragLeave(event: DragEvent & { currentTarget: HTMLDivElement }) {
    if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setDropTarget(null);
  }

  function endDrag() {
    clearExpandTimer();
    draggedMembers = null;
    draggedChannel = null;
    dropTarget = null;
  }

  function drop(event: DragEvent) {
    const target = dropTarget;
    const channel = target && channelsById.get(target.id);
    const members = draggedMembers;
    const source = dragSource();
    endDrag();
    if (!target || !channel) return;
    event.preventDefault();
    if (members) {
      const ids = memberDropIds(channel, members);
      if (ids.length) void moveMembers(channel.id, ids);
    } else if (source) {
      void placeChannel(source, channel, target.placement);
    }
  }
</script>

{#snippet channelRow(channel: Channel, depth: number, nested: boolean)}
  {@const children = nested ? channelsByParent.get(channel.id) ?? [] : []}
  {@const members = membersIn(channel.id)}
  {@const expandable = children.length > 0 || members.length > 0}
  {@const isSelected = currentChannel?.id === channel.id}
  {@const image = channel.backgroundImageUrl?.startsWith("https://") ? channel.backgroundImageUrl : null}
  <li>
    <ContextActions disabled={!online || Boolean(pending)} actions={channelActions(channel)}>
      {#snippet trigger(props)}
    <div class="channel-row" role="group" data-selected={isSelected} data-drop={dropTarget?.id === channel.id ? dropTarget.placement : undefined}
      data-dragging={draggedChannel?.id === channel.id ? "" : undefined}
      ondragover={(event) => dragOver(event, channel)}
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
        aria-current={isSelected ? "true" : undefined}
        onclick={() => selectChannel(channel)} ondblclick={() => onjoin(channel)} draggable={canReorder && channel.canEdit === true}
        ondragstart={(event) => startDrag(event, channel)} ondragend={endDrag}>
        {#if channel.icon}<span class="channel-icon" aria-hidden="true">{channel.icon}</span>{/if}
        <span class="truncate" title={channel.name}>{channel.name}</span>
        {#if channel.passwordRequired}
          <span class="channel-access access-lock" title="Password protected">
            <LockKeyhole size={14} aria-hidden="true" /><span class="sr-only">Password protected</span>
          </span>
        {/if}
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
      <h1 class="truncate">{workspace.serverTitle}</h1>
    </div>
    {#if workspace.canAdminister}
      <button type="button" class="server-settings-button" aria-label="Server settings" title="Server settings"
        disabled={Boolean(pending)} onclick={workspace.showServerSettings}>
        <Settings2 size={18} aria-hidden="true" />
      </button>
    {/if}
  </div>
  {#if online && snapshot}
    <div class="server-counts">
      {#if snapshot.totalUsers !== undefined}<span>{snapshot.totalUsers.toLocaleString()} total</span>{/if}
      <span class="online-count">{snapshot.presence.length.toLocaleString()} online</span>
    </div>
  {/if}
  <VoiceToolbar />
  {#if snapshot?.directMessages && workspace.serverId}
    <div class="channel-direct border-b border-border px-3 py-2.5">
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
  <div class="channel-scroll" role="presentation" ondragover={listDragOver} ondragleave={listDragLeave} ondrop={drop}>
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
  <div class="channel-footer" {@attach onfooter}>
    <Button variant="outline" title="Create channel" disabled={!canCreate || Boolean(pending)} onclick={oncreate}>
      <Plus size={18} aria-hidden="true" /> Channel
    </Button>
    <div class="contents" bind:this={workspace.screenShareControlsTarget}></div>
  </div>
</aside>

<style>
  .channel-top { position: relative; }
  .server-settings-button {
    display: inline-grid;
    flex: none;
    place-items: center;
    width: var(--control-height);
    height: var(--control-height);
    margin-inline-start: auto;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--card);
    color: var(--muted-foreground);
    box-shadow: var(--shadow-raised);
    cursor: pointer;
    transition: background-color .15s, border-color .15s, color .15s;
  }
  .server-settings-button:hover { background: var(--control-hover); color: var(--foreground); }
  .server-settings-button:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
  .server-settings-button:disabled { opacity: .5; cursor: default; }
  .channel-top:has(.server-banner:not([hidden])) .server-settings-button {
    position: absolute;
    top: 10px;
    inset-inline-end: 10px;
    z-index: 1;
    border-color: rgb(255 255 255 / 35%);
    background: rgb(0 0 0 / 40%);
    color: #fff;
    box-shadow: 0 1px 6px rgb(0 0 0 / 25%);
    -webkit-backdrop-filter: blur(6px);
    backdrop-filter: blur(6px);
  }
  .channel-top:has(.server-banner:not([hidden])) .server-settings-button:hover {
    border-color: rgb(255 255 255 / 60%);
    background: rgb(0 0 0 / 60%);
  }
  @media (prefers-reduced-transparency: reduce) {
    .channel-top:has(.server-banner:not([hidden])) .server-settings-button { background: rgb(0 0 0 / 70%); }
  }
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
</style>
