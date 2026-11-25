<script lang="ts">
  import { Tooltip } from "bits-ui";
  import {
    ArrowDownLeft, ArrowRight, AudioLines, Bookmark, Cable, Check, ChevronDown,
    CircleAlert, Copy, DoorOpen, Hash, Headphones, HeadphoneOff, Home, KeyRound, ListTree,
    LockKeyhole, MessageCircle, Mic, MicOff, Plus, Radio, Search, Send, Server, Settings2,
    UsersRound, Volume2,
  } from "lucide-svelte";
  import { onMount, tick } from "svelte";
  import Avatar from "./lib/Avatar.svelte";
  import IconButton from "./lib/IconButton.svelte";
  import Modal from "./lib/Modal.svelte";
  import SignalArt from "./lib/SignalArt.svelte";
  import {
    apiFor, call, messageFrom, messageTime, nativeApp, offline, requestError, shortHost, watchVoice,
    type Channel, type ServerInfo, type VoiceState,
  } from "./lib/client";

  type BookmarkEntry = { name: string; origin: string };
  type AuthMode = "register" | "recover" | "bootstrap";
  type MobilePane = "servers" | "channels" | "room";

  let view = $state.raw<VoiceState>(offline);
  let serverInfo = $state.raw<ServerInfo | null>(null);
  let serverOrigin = $state("");
  let savedServers = $state<BookmarkEntry[]>([]);
  let connectOpen = $state(false);
  let connectBusy = $state(false);
  let connectError = $state("");
  let discoverAddress = $state("");
  let discoverCertificate = $state<string | null>(null);
  let certificateName = $state("");
  let discovery = $state.raw<{ origin: string; info: ServerInfo } | null>(null);
  let authMode = $state<AuthMode>("register");
  let displayName = $state("");
  let deviceName = $state("Kōrero");
  let invitation = $state("");
  let recovery = $state("");
  let setupToken = $state("");
  let remembered = $state(true);
  let recoveryCode = $state("");
  let recoveryOpen = $state(false);
  let copied = $state(false);
  let settingsOpen = $state(false);
  let accountName = $state("");
  let settingsStatus = $state("");
  let channelCreateOpen = $state(false);
  let newChannelName = $state("");
  let passwordOpen = $state(false);
  let channelPassword = $state("");
  let joining = $state.raw<Channel | null>(null);
  let pending = $state("");
  let actionError = $state("");
  let search = $state("");
  let selectedChannelId = $state<string | null>(null);
  let collapsed = $state<string[]>([]);
  let message = $state("");
  let messageList: HTMLDivElement | undefined;
  let mobilePane = $state<MobilePane>("room");

  let snapshot = $derived(view.snapshot);
  let me = $derived(snapshot?.account);
  let ownMember = $derived(snapshot?.members.find((member) => member.connectionId === snapshot?.connectionId));
  let online = $derived(view.phase === "online");
  let activeChannel = $derived(snapshot?.channels.find((channel) => channel.id === snapshot?.channelId));
  let currentChannel = $derived(snapshot?.channels.find((channel) => channel.id === selectedChannelId) ?? activeChannel ?? snapshot?.channels[0]);
  let isInRoom = $derived(Boolean(currentChannel && activeChannel?.id === currentChannel.id));
  let roomMembers = $derived(isInRoom ? (snapshot?.members ?? []) : []);
  let filteredChannels = $derived(
    search.trim() ? (snapshot?.channels ?? []).filter((channel) => channel.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) : [],
  );
  let canCreate = $derived(online && Boolean(snapshot?.serverPermissions.includes("createChannels")));
  let canChat = $derived(online && isInRoom);
  let canVoice = $derived(online && Boolean(activeChannel));
  let serverTitle = $derived(serverInfo?.name ?? (serverOrigin ? shortHost(serverOrigin) : "No server connected"));
  let status = $derived(
    view.phase === "online" ? "Connected" : view.phase === "connecting" ? "Connecting" :
      view.phase === "reconnecting" ? "Reconnecting" : view.phase === "error" ? "Connection lost" : "Offline",
  );
  let voiceLabel = $derived(
    view.voice === "active" ? "Voice active" : view.voice === "muted" ? "Microphone muted" :
      view.voice === "deafened" ? "Deafened" : view.voice === "error" ? "Audio unavailable" : isInRoom ? "Voice connecting" : "Ready to join",
  );

  onMount(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem("korero:servers") ?? "[]");
      if (Array.isArray(stored)) {
        savedServers = stored.filter((entry): entry is BookmarkEntry =>
          entry && typeof entry.name === "string" && typeof entry.origin === "string");
      }
    } catch {
      savedServers = [];
    }
    if (!nativeApp()) return;
    let mounted = true;
    let receivedEvent = false;
    let unlisten: (() => void) | undefined;
    watchVoice((state) => {
      receivedEvent = true;
      if (mounted) applyView(state);
    }).then(async (stop) => {
      if (!mounted) return stop();
      unlisten = stop;
      const state = await call<VoiceState>("voice_state");
      if (mounted && !receivedEvent) applyView(state);
    }).catch((error: unknown) => {
      if (mounted) actionError = messageFrom(error);
    });
    return () => {
      mounted = false;
      unlisten?.();
    };
  });

  function applyView(state: VoiceState) {
    const previousChannel = view.snapshot?.channelId;
    const previousLength = view.messages.length;
    const wasNearBottom = !messageList || messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 90;
    view = state;
    if (state.snapshot?.channelId && previousChannel !== state.snapshot.channelId) {
      selectedChannelId = state.snapshot.channelId;
    }
    if (wasNearBottom && (state.messages.length !== previousLength || previousChannel !== state.snapshot?.channelId)) {
      void scrollMessages();
    }
  }

  function attachMessageList(element: HTMLDivElement) {
    messageList = element;
    return () => {
      if (messageList === element) messageList = undefined;
    };
  }

  async function scrollMessages() {
    await tick();
    if (messageList) messageList.scrollTop = messageList.scrollHeight;
  }

  function showConnect(address = "") {
    discoverAddress = address || serverOrigin;
    discovery = null;
    discoverCertificate = null;
    certificateName = "";
    connectError = "";
    invitation = "";
    recovery = "";
    setupToken = "";
    connectOpen = true;
  }

  async function selectCertificate(event: Event) {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) return;
    const file = input.files?.[0];
    if (!file) {
      discoverCertificate = null;
      certificateName = "";
      return;
    }
    try {
      discoverCertificate = await file.text();
      certificateName = file.name;
      connectError = "";
    } catch (error) {
      connectError = messageFrom(error);
    }
  }

  async function discover(event: SubmitEvent) {
    event.preventDefault();
    if (connectBusy) return;
    connectBusy = true;
    connectError = "";
    try {
      const origin = await call<string>("prepare_server", { address: discoverAddress.trim(), certificate: discoverCertificate });
      const result = await apiFor(origin).server.info.get();
      if (result.error) throw requestError(result.error);
      if (!result.data || !("serverId" in result.data)) throw new Error("This server did not return Kōrero server details.");
      discovery = { origin, info: result.data };
      authMode = result.data.setupRequired ? "bootstrap" :
        result.data.registration === "open" || result.data.registration === "invitation" ? "register" : "recover";
    } catch (error) {
      connectError = messageFrom(error);
    } finally {
      connectBusy = false;
    }
  }

  async function authenticate(event: SubmitEvent) {
    event.preventDefault();
    if (!discovery || connectBusy) return;
    const target = discovery;
    connectBusy = true;
    connectError = "";
    try {
      const api = apiFor(target.origin);
      const device = { deviceName: deviceName.trim() };
      const result = authMode === "recover"
        ? await api.auth.recover.post({ ...device, recoveryCode: recovery.trim() })
        : authMode === "bootstrap"
          ? await api.admin.bootstrap.post({ ...device, displayName: displayName.trim(), token: setupToken.trim() })
          : await api.auth.register.post({ ...device, displayName: displayName.trim(), invitation: invitation.trim() || undefined });
      if (result.error) throw requestError(result.error);
      if (!result.data || !("account" in result.data)) throw new Error("This server did not return an account.");
      const newCode = "recoveryCode" in result.data && typeof result.data.recoveryCode === "string" ? result.data.recoveryCode : "";
      serverInfo = target.info;
      serverOrigin = target.origin;
      selectedChannelId = null;
      try {
        await call("start_session");
      } catch (error) {
        actionError = messageFrom(error);
      }
      if (remembered) {
        savedServers = [{ name: target.info.name, origin: target.origin }, ...savedServers.filter((entry) => entry.origin !== target.origin)];
        try {
          localStorage.setItem("korero:servers", JSON.stringify(savedServers));
        } catch {
          // Keep the bookmark in the current app session if storage is unavailable.
        }
      }
      connectOpen = false;
      mobilePane = "channels";
      connectError = "";
      displayName = "";
      recovery = "";
      setupToken = "";
      invitation = "";
      if (newCode) {
        recoveryCode = newCode;
        copied = false;
        recoveryOpen = true;
      }
    } catch (error) {
      connectError = messageFrom(error);
    } finally {
      connectBusy = false;
    }
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(recoveryCode);
      copied = true;
    } catch {
      copied = false;
    }
  }

  function closeRecovery() {
    recoveryOpen = false;
    recoveryCode = "";
  }

  async function run(action: string, command: string, args?: Record<string, unknown>) {
    if (pending) return false;
    pending = action;
    actionError = "";
    try {
      await call(command, args);
      return true;
    } catch (error) {
      actionError = messageFrom(error);
      return false;
    } finally {
      pending = "";
    }
  }

  function selectChannel(channel: Channel) {
    selectedChannelId = channel.id;
    mobilePane = "room";
    actionError = "";
  }

  async function joinChannel(channel: Channel) {
    selectChannel(channel);
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

  async function createChannel(event: SubmitEvent) {
    event.preventDefault();
    if (await run("create", "create_channel", { name: newChannelName.trim() })) {
      channelCreateOpen = false;
      newChannelName = "";
    }
  }

  async function sendMessage(event: SubmitEvent) {
    event.preventDefault();
    const text = message.trim();
    if (!text || !canChat || pending) return;
    message = "";
    if (!(await run("message", "send_message", { text })) && !message) message = text;
  }

  async function disconnect() {
    if (await run("disconnect", "disconnect")) {
      serverInfo = null;
      serverOrigin = "";
      selectedChannelId = null;
      settingsOpen = false;
      mobilePane = "room";
    } else {
      settingsStatus = actionError;
    }
  }

  function showSettings() {
    accountName = me?.displayName ?? "";
    settingsStatus = "";
    settingsOpen = true;
  }

  async function saveSettings(event: SubmitEvent) {
    event.preventDefault();
    if (!serverOrigin || pending) return;
    pending = "account";
    settingsStatus = "";
    try {
      const result = await apiFor(serverOrigin).account.patch({ displayName: accountName.trim() });
      if (result.error) throw requestError(result.error);
      settingsStatus = "Display name updated.";
    } catch (error) {
      settingsStatus = messageFrom(error);
    } finally {
      pending = "";
    }
  }

  function toggleGroup(id: string) {
    collapsed = collapsed.includes(id) ? collapsed.filter((item) => item !== id) : [...collapsed, id];
  }

  function senderName(id: string) {
    if (id === me?.id) return me.displayName;
    return snapshot?.presence.find((person) => person.accountId === id)?.displayName
      ?? snapshot?.members.find((person) => person.accountId === id)?.displayName ?? "Channel member";
  }
</script>

{#snippet brand()}
  <span class="brand-symbol" aria-hidden="true"><AudioLines size={24} strokeWidth={2.35} /></span>
  <span class="brand-name">kōrero<span>.</span></span>
{/snippet}

{#snippet channelRow(channel: Channel, depth: number, nested: boolean)}
  {@const children = nested ? (snapshot?.channels ?? []).filter((item) => item.parentId === channel.id) : []}
  {@const isActive = activeChannel?.id === channel.id}
  {@const isSelected = currentChannel?.id === channel.id}
  <li>
    <div class="channel-row" data-selected={isSelected} style:--depth={Math.min(depth, 6)}>
      {#if children.length}
        <button class="tree-expander" onclick={() => toggleGroup(channel.id)} aria-label={collapsed.includes(channel.id) ? `Expand ${channel.name}` : `Collapse ${channel.name}`} aria-expanded={!collapsed.includes(channel.id)}>
          <ChevronDown size={13} class={collapsed.includes(channel.id) ? "-rotate-90" : ""} />
        </button>
      {:else}
        <span class="tree-spacer"></span>
      {/if}
      <button class="channel-target" aria-current={isSelected ? "true" : undefined} aria-describedby={isActive ? "joined-channel-description" : undefined} onclick={() => selectChannel(channel)} ondblclick={() => joinChannel(channel)}>
        {#if channel.passwordRequired}<LockKeyhole size={15} strokeWidth={1.8} />
        {:else if channel.name === "Lobby"}<Home size={16} strokeWidth={1.8} />
        {:else}<Hash size={16} strokeWidth={1.85} />{/if}
        <span class="truncate">{channel.name}</span>
        {#if isActive}<span class="joined-dot" title="Joined" aria-hidden="true"></span>{/if}
      </button>
    </div>
    {#if isActive && snapshot?.members.length}
      <ul class="member-list" aria-label={`Members in ${channel.name}`} style:--depth={Math.min(depth, 6)}>
        {#each snapshot.members as member (member.connectionId)}
          <li class="tree-member">
            <Avatar name={member.displayName} class="avatar-small" speaking={view.speaking.includes(member.connectionId)} />
            <span class="truncate">{member.displayName}</span>
            {#if member.connectionId === snapshot.connectionId}<small>you</small>{/if}
            {#if member.deafened}<HeadphoneOff size={13} class="member-state" aria-label="Deafened" />
            {:else if member.muted || member.adminMuted}<MicOff size={13} class="member-state" aria-label="Muted" />{/if}
          </li>
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

<Tooltip.Provider delayDuration={350}>
  <div class="shell" data-pane={mobilePane}>
    <aside class="server-rail" aria-label="Servers">
      <div class="rail-top">
        <div class="brand">{@render brand()}</div>
        <button class="rail-connect" onclick={() => showConnect()}><Plus size={17} /> Connect to server</button>
        <section class="rail-section">
          <div class="rail-section-label"><span>Servers</span></div>
          {#if serverOrigin}
            <button class="rail-server current" onclick={() => (mobilePane = "channels")}>
              <span class="rail-tile"><Server size={16} strokeWidth={1.8} /></span>
              <span class="min-w-0"><strong class="truncate">{serverTitle}</strong><small class="truncate">{shortHost(serverOrigin)}</small></span>
              <span class="connection-dot" data-online={online}></span>
            </button>
          {:else}
            <p class="rail-empty">No active connection</p>
          {/if}
        </section>
        <section class="rail-section">
          <div class="rail-section-label"><span>Saved servers</span><Bookmark size={14} strokeWidth={1.6} /></div>
          {#each savedServers as entry (entry.origin)}
            <button class="rail-server" onclick={() => showConnect(entry.origin)}>
              <span class="rail-tile"><Server size={15} strokeWidth={1.8} /></span><span class="truncate">{entry.name}</span>
            </button>
          {:else}
            <p class="rail-empty">Saved servers appear here.</p>
          {/each}
        </section>
      </div>
      <div class="rail-bottom">
        <div class="account-line">
          <Avatar name={me?.displayName ?? ""} />
          <div class="min-w-0 grow">
            <strong class="block truncate">{me?.displayName ?? "Guest"}</strong>
            <span class="account-status"><span class="connection-dot" data-online={online}></span>{status}</span>
          </div>
          {#if me}<IconButton label="Account settings" onclick={showSettings} class="rail-icon"><Settings2 size={17} /></IconButton>{/if}
        </div>
      </div>
    </aside>

    <aside class="channel-pane" aria-label="Channels">
      <div class="channel-top">
        <div class="server-tile"><Server size={22} strokeWidth={1.75} /></div>
        <div class="min-w-0">
          <span class="eyebrow">Voice server</span>
          <h1 class="truncate">{serverTitle}</h1>
        </div>
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
          <div class="channel-empty"><Hash size={20} strokeWidth={1.5} /><p>{snapshot ? "No channels are available." : "Connect to view channels."}</p></div>
        {/if}
      </div>
      <div class="channel-footer">
        <IconButton label="Create channel" disabled={!canCreate} onclick={() => { actionError = ""; newChannelName = ""; channelCreateOpen = true; }}><Plus size={19} /></IconButton>
        <span>{snapshot ? `${snapshot.presence.length} online` : "No one online"}</span>
      </div>
    </aside>

    <main class="room-pane">
      <header class="workspace-header">
        <div class="heading-icon">{#if currentChannel}<Hash size={23} />{:else}<AudioLines size={23} />{/if}</div>
        <div class="min-w-0 grow">
          <div class="breadcrumb">{currentChannel ? serverTitle : "Kōrero"}<span></span>{currentChannel ? "Voice channel" : "Workspace"}</div>
          <h2 class="truncate">{currentChannel?.name ?? "Welcome to Kōrero"}</h2>
        </div>
        <div class="voice-toolbar" aria-label="Voice controls">
          <IconButton label={ownMember?.muted ? "Unmute microphone" : "Mute microphone"} disabled={!canVoice || Boolean(pending) || ownMember?.adminMuted} active={Boolean(ownMember?.muted || ownMember?.adminMuted)} onclick={() => run("mute", "set_presence", { muted: !ownMember?.muted, deafened: null })}>
            {#if ownMember?.muted || ownMember?.adminMuted}<MicOff size={18} />{:else}<Mic size={18} />{/if}
          </IconButton>
          <IconButton label={ownMember?.deafened ? "Undeafen" : "Deafen"} disabled={!canVoice || Boolean(pending)} active={Boolean(ownMember?.deafened)} onclick={() => run("deafen", "set_presence", { muted: null, deafened: !ownMember?.deafened })}>
            {#if ownMember?.deafened}<HeadphoneOff size={18} />{:else}<Headphones size={18} />{/if}
          </IconButton>
          {#if activeChannel}
            <span class="toolbar-separator"></span>
            <IconButton label="Leave voice channel" disabled={!canVoice || Boolean(pending)} onclick={() => run("leave", "leave_channel")} class="leave-icon"><DoorOpen size={18} /></IconButton>
          {/if}
        </div>
      </header>

      <div class="workspace">
        {#if actionError || view.error || view.voiceError}
          <div class="notice" role="status"><CircleAlert size={17} /><span>{actionError || view.error || view.voiceError}</span></div>
        {/if}
        <section class="room-hero" aria-label="Voice room">
          <SignalArt live={isInRoom && view.voice === "active"} />
          <div class="hero-content">
            {#if currentChannel}
              <span class="hero-kicker"><Radio size={15} /> {isInRoom ? voiceLabel : "Voice channel"}</span>
              <h3>{currentChannel.name}</h3>
              {#if currentChannel.description}<p>{currentChannel.description}</p>{/if}
              {#if !isInRoom}
                <button class="primary-button hero-button" onclick={() => joinChannel(currentChannel!)} disabled={!online || Boolean(pending)}><Headphones size={17} /> {pending === "join" ? "Joining…" : "Join voice"}</button>
              {:else}
                <span class="hero-member-count"><UsersRound size={17} /> {roomMembers.length} {roomMembers.length === 1 ? "person" : "people"} in voice</span>
              {/if}
            {:else}
              <span class="hero-kicker"><Radio size={15} /> Voice and chat</span>
              <h3>Good to hear you.</h3>
              <p>Connect to your server to see its channels and join a conversation.</p>
              <button class="primary-button hero-button" onclick={() => showConnect()}><Cable size={16} /> Connect to server <ArrowRight size={16} /></button>
            {/if}
          </div>
        </section>

        {#if isInRoom}
          <section class="room-people" aria-label="In voice">
            <div class="subheading"><UsersRound size={17} /><h3>In voice</h3><span>{roomMembers.length}</span></div>
            <div class="room-member-strip">
              {#each roomMembers as member (member.connectionId)}
                {@const speaking = view.speaking.includes(member.connectionId)}
                <div class="room-member" data-speaking={speaking}>
                  <Avatar name={member.displayName} speaking={speaking} />
                  <span class="truncate">{member.displayName}</span>
                  {#if member.deafened}<HeadphoneOff size={14} aria-label="Deafened" />
                  {:else if member.muted || member.adminMuted}<MicOff size={14} aria-label="Muted" />
                  {:else if speaking}<Volume2 size={14} aria-label="Speaking" />{/if}
                </div>
              {/each}
            </div>
          </section>
        {/if}

        <section class="chat-pane" aria-label="Channel chat">
          <header class="chat-header subheading"><MessageCircle size={17} /><h3>Channel chat</h3></header>
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

    <nav class="mobile-nav" aria-label="Workspace navigation">
      <button aria-current={mobilePane === "servers" ? "page" : undefined} onclick={() => (mobilePane = "servers")}><Server size={18} /> Servers</button>
      <button aria-current={mobilePane === "channels" ? "page" : undefined} onclick={() => (mobilePane = "channels")}><ListTree size={18} /> Channels</button>
      <button aria-current={mobilePane === "room" ? "page" : undefined} onclick={() => (mobilePane = "room")}><AudioLines size={18} /> Room</button>
    </nav>
  </div>
</Tooltip.Provider>

<Modal bind:open={connectOpen} title={discovery ? discovery.info.name : "Connect to a server"} description={discovery ? shortHost(discovery.origin) : "Enter the address of a Kōrero server."} dismissible={!connectBusy}>
  {#snippet icon()}<Cable size={21} />{/snippet}
  {#if connectError}<p class="form-error" role="alert">{connectError}</p>{/if}
  {#if discovery}
    {#if authMode !== "bootstrap"}
      <div class="mode-switch" aria-label="Account action">
        {#if discovery.info.registration === "open" || discovery.info.registration === "invitation"}
          <button type="button" aria-pressed={authMode === "register"} onclick={() => { authMode = "register"; connectError = ""; }}>Create account</button>
        {/if}
        <button type="button" aria-pressed={authMode === "recover"} onclick={() => { authMode = "recover"; connectError = ""; }}>Recover account</button>
      </div>
    {/if}
    <form class="dialog-form" onsubmit={authenticate}>
      {#if authMode === "recover"}
        <label>Recovery code<input required autocomplete="off" spellcheck="false" bind:value={recovery} placeholder="Paste your recovery code" /></label>
      {:else}
        <label>Display name<input required maxlength={80} autocomplete="nickname" bind:value={displayName} /></label>
        {#if authMode === "bootstrap"}
          <label>Server setup token<input type="password" required autocomplete="off" spellcheck="false" bind:value={setupToken} /></label>
        {:else if discovery.info.registration === "invitation"}
          <label>Invitation code<input required autocomplete="off" spellcheck="false" bind:value={invitation} /></label>
        {/if}
      {/if}
      <label>Device name<input required maxlength={80} autocomplete="off" bind:value={deviceName} /></label>
      <label class="checkbox-label"><input type="checkbox" bind:checked={remembered} /> Save this server address</label>
      <div class="dialog-actions"><button class="secondary-button" type="button" disabled={connectBusy} onclick={() => { discovery = null; connectError = ""; }}>Back</button><button type="submit" class="primary-button" disabled={connectBusy}>{connectBusy ? "Connecting…" : authMode === "bootstrap" ? "Set up server" : "Connect"} <ArrowRight size={16} /></button></div>
    </form>
  {:else}
    <form class="dialog-form" onsubmit={discover}>
      <label>Server address<input required autocomplete="off" inputmode="url" placeholder="voice.example.net:8443" spellcheck="false" bind:value={discoverAddress} /></label>
      <details class="certificate-options">
        <summary>Private certificate</summary>
        <p>For a self-hosted server, choose the public PEM certificate from your server operator.</p>
        <label class="certificate-picker"><input type="file" accept=".pem,.crt,.cer" onchange={selectCertificate} /><span>{certificateName || "Choose PEM certificate"}</span></label>
      </details>
      <button class="primary-button justify-center" type="submit" disabled={connectBusy}>{connectBusy ? "Checking server…" : "Continue"} <ArrowRight size={16} /></button>
    </form>
  {/if}
</Modal>

<Modal bind:open={recoveryOpen} title="Save your recovery code" description="You’ll need this code to recover your account or connect from another device." dismissible={false}>
  {#snippet icon()}<KeyRound size={21} />{/snippet}
  <div class="recovery-code"><code>{recoveryCode}</code><button type="button" class="icon-button" aria-label={copied ? "Copied" : "Copy recovery code"} onclick={copyCode}>{#if copied}<Check size={17} />{:else}<Copy size={17} />{/if}</button></div>
  <div class="dialog-actions"><button type="button" class="primary-button" onclick={closeRecovery}>I’ve saved my code <Check size={17} /></button></div>
</Modal>

<Modal bind:open={passwordOpen} title={joining ? `Join ${joining.name}` : "Join channel"} description="Enter the password for this channel." dismissible={pending !== "join"}>
  {#snippet icon()}<LockKeyhole size={21} />{/snippet}
  {#if actionError}<p class="form-error" role="alert">{actionError}</p>{/if}
  <form class="dialog-form" onsubmit={submitPassword}>
    <label>Channel password<input type="password" required bind:value={channelPassword} /></label>
    <button class="primary-button justify-center" type="submit" disabled={Boolean(pending)}>{pending === "join" ? "Joining…" : "Join voice"}</button>
  </form>
</Modal>

<Modal bind:open={channelCreateOpen} title="Create a channel" description="Add a voice channel to this server." dismissible={pending !== "create"}>
  {#snippet icon()}<Hash size={21} />{/snippet}
  {#if actionError}<p class="form-error" role="alert">{actionError}</p>{/if}
  <form class="dialog-form" onsubmit={createChannel}>
    <label>Channel name<input required maxlength={80} bind:value={newChannelName} /></label>
    <button class="primary-button justify-center" type="submit" disabled={Boolean(pending)}>Create channel</button>
  </form>
</Modal>

<Modal bind:open={settingsOpen} title="Account settings" description={serverTitle} dismissible={!pending}>
  {#snippet icon()}<Settings2 size={21} />{/snippet}
  <form class="dialog-form" onsubmit={saveSettings}>
    <label>Display name<input required maxlength={80} bind:value={accountName} /></label>
    {#if settingsStatus}<p class="form-status" role="status">{settingsStatus}</p>{/if}
    <div class="dialog-actions"><button type="button" class="secondary-button" disabled={Boolean(pending)} onclick={disconnect}><ArrowDownLeft size={15} /> Disconnect</button><button type="submit" class="primary-button" disabled={Boolean(pending)}>Save name</button></div>
  </form>
</Modal>
