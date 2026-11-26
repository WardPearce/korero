<script lang="ts">
  import { playUiSound } from "$lib/ui-sounds";
  import { Button, Checkbox, Input, Root } from "gridworkdesign";
  import "../app.css";

  import { goto } from "$app/navigation";
  import { asset, resolve } from "$app/paths";
  import { page } from "$app/state";
  import { ArrowRight, AudioLines, Bookmark, Cable, ListTree, Plus, Server, Settings2, X } from "@lucide/svelte";
  import { onMount } from "svelte";
  import { AudioSettings, setAudioSettings } from "$lib/audio.svelte";
  import PaneDivider from "$lib/PaneDivider.svelte";
  import { getMemberVolumes, getUsername, migrateSavedServers, preferences, saveMemberVolumes, type SavedServer } from "$lib/preferences";
  import Avatar from "$lib/Avatar.svelte";
  import ContextActions from "$lib/ContextActions.svelte";
  import IdentitySetup from "$lib/IdentitySetup.svelte";
  import IconButton from "$lib/IconButton.svelte";
  import Modal from "$lib/Modal.svelte";
  import ServerAdministration from "$lib/ServerAdministration.svelte";
  import {
    apiFor, call, messageFrom, nativeApp, offline, requestError, shortHost, watchVoice,
    type MemberRequest, type ServerInfo, type VoiceState,
  } from "$lib/client";
  import { authenticateIdentity, identityError, loadIdentity } from "$lib/identity";
  import { browserServerOrigin, browserSession } from "$lib/browser-session";
  import { applyTheme, readTheme } from "$lib/theme";
  import { setWorkspace, type MobilePane, type RoomView } from "$lib/workspace";

  let { children } = $props();
  const audio = setAudioSettings(new AudioSettings());

  type Target = { origin: string; info: ServerInfo };
  const deviceName = "VNX.chat";

  let viewport = $state(1200);
  let savedRailWidth = $state(230);
  let savedChannelWidth = $state(366);
  let railMax = $derived(Math.max(180, Math.min(340, viewport - 530)));
  let railWidth = $derived(Math.min(savedRailWidth, railMax));
  let channelMax = $derived(Math.max(222, Math.min(500, viewport - railWidth - 298)));
  let channelWidth = $derived(Math.min(savedChannelWidth, channelMax));

  function resizePane(pane: "rail" | "channel", value: number, commit: boolean) {
    if (pane === "rail") savedRailWidth = value;
    else savedChannelWidth = value;
    if (commit) void preferences.local.put({ key: pane, value }).catch((error) => { actionError = messageFrom(error); });
  }

  let view = $state.raw<VoiceState>(offline);
  let serverInfo = $state.raw<ServerInfo | null>(null);
  let serverOrigin = $state("");
  let savedServers = $state<SavedServer[]>([]);
  let username = $state("");
  let hasIdentity = $state(false);
  let identityReady = $state(false);
  let identitySetupOpen = $state(false);
  let identityLoadError = $state("");
  let connectOpen = $state(false);
  let connectBusy = $state(false);
  let connectError = $state("");
  let bookmarkOrigin = $state("");
  let discoverAddress = $state(import.meta.env.VITE_DEFAULT_SERVER || "");
  interface CertificateContact { origin: string; fingerprint: string; publiclyTrusted: boolean }
  let trustPrompt = $state<(CertificateContact & { previous?: string }) | null>(null);
  let discovery = $state.raw<Target | null>(null);
  let accessPrompt = $state(false);
  let invitationRequired = $state(false);
  let setupToken = $state("");
  let serverCode = $state("");
  let serverPassword = $state("");
  let removingServer = $state.raw<SavedServer | null>(null);
  let removeServerOpen = $state(false);
  let removing = $state(false);
  let removeError = $state("");
  let remembered = $state(true);
  let pending = $state("");
  let memberVolumes = $state.raw<Record<string, number>>({});
  let actionError = $state("");
  let selectedChannelId = $state<string | null>(null);
  let mobilePane = $state<MobilePane>("room");
  let roomView = $state<RoomView>("chat");

  let me = $derived(view.snapshot?.account);
  let online = $derived(view.phase === "online");
  let serverPermissions = $derived(view.snapshot?.serverPermissions ?? []);
  let canAdminister = $derived(online && Boolean(serverInfo?.serverAdministration) &&
    ["manageRoles", "manageSettings", "manageInvitations"].some((permission) => serverPermissions.includes(permission)));
  let onWorkspace = $derived(page.route.id === "/");
  let serverTitle = $derived(serverInfo?.name ?? (serverOrigin ? shortHost(serverOrigin) : online ? "Connected server" : "No server connected"));
  let bannerImageUrl = $derived(view.snapshot?.bannerImageUrl === undefined ? serverInfo?.bannerImageUrl ?? null : view.snapshot.bannerImageUrl);
  let claimOwnership = $derived(Boolean(discovery?.info.setupRequired && setupToken.trim()));
  let needsPassword = $derived(Boolean(discovery?.info.passwordRequired &&
    !(discovery.info.invitationPasswordBypass && serverCode.trim())));
  let status = $derived(
    view.phase === "online" ? "Connected" : view.phase === "connecting" ? "Connecting" :
      view.phase === "reconnecting" ? "Reconnecting" : view.phase === "error" ? "Connection lost" : "Offline",
  );

  setWorkspace({
    get view() { return view; },
    get serverOrigin() { return serverOrigin; },
    get serverTitle() { return serverTitle; },
    get bannerImageUrl() { return bannerImageUrl; },
    get canAdminister() { return canAdminister; },
    get serverSettings() { return roomView === "serverSettings" && canAdminister ? serverSettings : undefined; },
    get channelBackgrounds() { return Boolean(serverInfo?.channelBackgrounds); },
    get channelWidth() { return channelWidth; },
    get channelMax() { return channelMax; },
    resizeChannel(value, commit) { resizePane("channel", value, commit); },
    get pending() { return pending; },
    get actionError() { return actionError; },
    set actionError(value) { actionError = value; },
    get selectedChannelId() { return selectedChannelId; },
    set selectedChannelId(value) { selectedChannelId = value; },
    get mobilePane() { return mobilePane; },
    set mobilePane(value) { mobilePane = value; },
    get roomView() { return roomView; },
    set roomView(value) { roomView = value; },
    showConnect,
    showServerSettings,
    run,
    memberAction,
    memberVolume(accountId) { return memberVolumes[accountId] ?? 100; },
    setMemberVolume,
    reorderChannel,
    disconnect,
  });

  onMount(() => {
    applyTheme(readTheme());
    void audio.load();
    void Promise.all([migrateSavedServers().then(() => preferences.servers.toArray()), preferences.local.bulkGet(["rail", "channel"])])
      .then(([servers, [rail, channel]]) => {
        savedServers = servers;
        if (typeof rail?.value === "number") savedRailWidth = Math.max(180, Math.min(340, rail.value));
        if (typeof channel?.value === "number") savedChannelWidth = Math.max(222, Math.min(500, channel.value));
      }).catch((error) => { actionError = messageFrom(error); });
    void Promise.all([loadIdentity(), getUsername()]).then(([identity, name]) => {
      hasIdentity = Boolean(identity);
      username = name;
      identityReady = hasIdentity && Boolean(username);
      identitySetupOpen = !identityReady;
    }).catch((error: unknown) => {
      identityLoadError = messageFrom(error);
      identitySetupOpen = true;
    });
    if (!nativeApp()) return browserSession.watch(applyView);
    let mounted = true;
    let receivedEvent = false;
    let unlisten: (() => void) | undefined;
    watchVoice((state) => {
      receivedEvent = true;
      if (mounted) applyView(state);
    }).then(async (stop) => {
      if (!mounted) return stop();
      unlisten = stop;
      const state = await call<VoiceState & { serverOrigin?: string | null }>("voice_state");
      if (!mounted) return;
      if (!receivedEvent) applyView(state);
      const origin = state.serverOrigin;
      if (!origin || serverOrigin || connectBusy || view.phase === "offline") return;
      serverOrigin = origin;
      const info = await getServerInfo(origin);
      if (mounted && serverOrigin === origin && !serverInfo) serverInfo = info;
    }).catch((error: unknown) => {
      if (mounted) actionError = messageFrom(error);
    });
    return () => {
      mounted = false;
      unlisten?.();
      audio.stopTalking();
    };
  });

  function applyView(state: VoiceState) {
    const channel = state.snapshot?.channelId;
    if (channel && channel !== view.snapshot?.channelId) selectedChannelId = channel;
    view = state;
  }

  function openWorkspace(pane: MobilePane) {
    mobilePane = pane;
    if (!onWorkspace) void goto(resolve("/"));
  }

  function resetConnect(address: string) {
    discoverAddress = address || serverOrigin;
    discovery = null;
    trustPrompt = null;
    connectError = "";
    accessPrompt = false;
    invitationRequired = false;
    setupToken = "";
    serverCode = "";
    serverPassword = "";
    remembered = true;
    bookmarkOrigin = "";
  }

  function showConnect(address = "") {
    if (!identityReady || connectBusy || pending) return;
    resetConnect(address);
    connectOpen = true;
  }

  function selectBookmark(origin: string) {
    if (!identityReady || connectBusy || pending) return;
    if (origin === serverOrigin && (online || view.phase === "connecting" || view.phase === "reconnecting")) {
      openWorkspace("channels");
      return;
    }
    resetConnect(origin);
    bookmarkOrigin = origin;
    void discoverServer();
  }

  async function loadServer(contact: CertificateContact, fingerprint: string | null, rememberTrust = false) {
    const origin = await call<string>("prepare_server", { origin: contact.origin, fingerprint });
    if (rememberTrust) await preferences.trust.put({ origin, fingerprint: contact.fingerprint });
    await discoverServerInfo(origin);
  }

  async function discoverServerInfo(origin: string) {
    roomView = "chat";
    serverInfo = null;
    serverOrigin = "";
    selectedChannelId = null;
    const target = { origin, info: await getServerInfo(origin) };
    discovery = target;
    if (!target.info.identityAuthentication || !target.info.identityEnrollment) {
      throw new Error("Update this server to a VNX.chat version that supports identity sign-in.");
    }
    if (target.info.setupRequired || needsPassword) {
      accessPrompt = true;
      connectOpen = true;
      return;
    }
    if (serverCode) await enroll(target);
    else await signIn(target);
  }

  async function getServerInfo(origin: string): Promise<ServerInfo> {
    const result = await apiFor(origin).server.info.get();
    if (result.error) throw requestError(result.error);
    if (!result.data || !("serverId" in result.data)) throw new Error("This server did not return VNX.chat server details.");
    return result.data;
  }

  async function signIn(target: Target) {
    const password = serverPassword || undefined;
    const login = await authenticateIdentity(target.origin, target.info.serverId, deviceName, { operation: "login", password });
    if (login.status === 200) {
      await finishConnection(target);
      return;
    }
    if (login.status !== 404) throw identityError(login);
    if (target.info.registration === "disabled") {
      throw new Error("This server has closed registration for new identities.");
    }
    if (target.info.registration !== "open" && !serverCode.trim()) {
      accessPrompt = true;
      invitationRequired = true;
      connectOpen = true;
      return;
    }
    await enroll(target);
  }

  function discover(event: SubmitEvent) {
    event.preventDefault();
    void discoverServer();
  }

  async function discoverServer() {
    if (connectBusy) return;
    connectBusy = true;
    connectError = "";
    try {
      const [address, invitation, ...extra] = discoverAddress.trim().split("#");
      if (extra.length || (invitation !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(invitation))) {
        throw new Error("Enter the full invitation link, including the code after #.");
      }
      serverCode = invitation ?? "";
      if (!nativeApp()) {
        const origin = browserServerOrigin(address);
        await browserSession.select(origin);
        await discoverServerInfo(origin);
        return;
      }
      const contact = await call<CertificateContact>("inspect_server", { address });
      const previous = (await preferences.trust.get(contact.origin))?.fingerprint;
      if (previous === contact.fingerprint) await loadServer(contact, previous);
      else if (!previous && contact.publiclyTrusted) await loadServer(contact, null);
      else {
        trustPrompt = { ...contact, previous };
        connectOpen = true;
      }
    } catch (error) {
      connectError = messageFrom(error);
      connectOpen = true;
    } finally {
      connectBusy = false;
    }
  }

  async function approveTrust() {
    if (!trustPrompt || connectBusy) return;
    const contact = trustPrompt;
    connectBusy = true;
    connectError = "";
    trustPrompt = null;
    try {
      await loadServer(contact, contact.fingerprint, true);
    } catch (error) {
      connectError = messageFrom(error);
      connectOpen = true;
    } finally {
      connectBusy = false;
    }
  }

  async function submitServerCode(event: SubmitEvent) {
    event.preventDefault();
    if (!discovery || connectBusy) return;
    connectBusy = true;
    connectError = "";
    try {
      if (claimOwnership || serverCode.trim()) await enroll(discovery);
      else await signIn(discovery);
    } catch (error) {
      connectError = messageFrom(error);
    } finally {
      connectBusy = false;
    }
  }

  async function enroll(target: Target) {
    const code = serverCode.trim();
    const password = serverPassword || undefined;
    const bootstrap = claimOwnership;
    if (!bootstrap && target.info.registration === "disabled") {
      throw new Error("This server has closed registration for new identities.");
    }
    const result = await authenticateIdentity(target.origin, target.info.serverId, deviceName,
      bootstrap
        ? { operation: "bootstrap", displayName: username, token: setupToken.trim() }
        : { operation: "register", displayName: username, invitation: code || undefined, password });
    if (bootstrap && result.status === 404) {
      const response = await apiFor(target.origin).server.info.get();
      if (!response.error && response.data && "serverId" in response.data && !response.data.setupRequired) {
        const updated = { ...target, info: response.data };
        setupToken = "";
        discovery = updated;
        if (!updated.info.passwordRequired || serverPassword) await signIn(updated);
        return;
      }
    }
    if (result.status === 409) {
      if (code && target.info.passwordRequired && !password) {
        serverCode = "";
        accessPrompt = true;
        connectOpen = true;
        connectError = "This identity already has an account. Enter the server password to sign in.";
        return;
      }
      const login = await authenticateIdentity(target.origin, target.info.serverId, deviceName, { operation: "login", password });
      if (login.status === 200) {
        await finishConnection(target);
        return;
      }
    }
    if (!bootstrap && code && result.status === 401 && !needsPassword) {
      throw new Error("This invitation is invalid, expired, or out of uses.");
    }
    if (result.status !== 201) throw identityError(result);
    const account = result.body;
    if (!account || typeof account !== "object" || !("account" in account)) {
      throw new Error("This server did not return an account.");
    }
    if (bootstrap) {
      target = { ...target, info: { ...target.info, setupRequired: false } };
      discovery = target;
      setupToken = "";
    }
    await finishConnection(target);
  }

  async function finishConnection(target: Target) {
    serverInfo = target.info;
    serverOrigin = target.origin;
    try {
      await audio.load();
      if (nativeApp()) {
        memberVolumes = await getMemberVolumes(target.info.serverId).catch(() => ({}));
        await call("start_session", { memberVolumes });
      }
      else await browserSession.start();
    } catch (error) {
      actionError = messageFrom(error);
    }
    if (view.phase === "online") playUiSound("connect");
    if (remembered) {
      const entry = { name: target.info.name, origin: target.origin };
      savedServers = [entry, ...savedServers.filter(({ origin }) => origin !== target.origin)];
      await preferences.servers.put(entry).catch((error) => { actionError = messageFrom(error); });
    }
    connectOpen = false;
    openWorkspace("channels");
    connectError = "";
    discoverAddress = target.origin;
    serverCode = "";
    setupToken = "";
    serverPassword = "";
  }

  async function runAction(action: string, work: () => Promise<unknown>) {
    if (pending) return false;
    pending = action;
    actionError = "";
    try {
      await work();
      return true;
    } catch (error) {
      actionError = messageFrom(error);
      return false;
    } finally {
      pending = "";
    }
  }

  function run(action: string, command: string, args?: Record<string, unknown>) {
    return runAction(action, () => {
      if (nativeApp()) return call(command, args);
      if (command === "disconnect") return browserSession.disconnect();
      if (command === "save_channel") return browserSession.saveChannel(args?.payload as Record<string, unknown>);
      throw new Error("Open VNX.chat in the desktop app to use voice.");
    });
  }

  function reorderChannel(channelId: string, targetId: string, placement: "before" | "after") {
    return runAction("channel-order", async () => {
      const response = await apiFor(serverOrigin).channels.order.patch({ channelId, targetId, placement });
      if (response.error) throw requestError(response.error);
    });
  }

  function memberAction(request: MemberRequest) {
    return runAction(request.kind, () => nativeApp() ? call("member_action", request) : browserSession.memberAction(request));
  }

  function setMemberVolume(accountId: string, level: number) {
    return runAction("member-volume", async () => {
      const serverId = serverInfo?.serverId;
      await call("set_member_volume", { accountId, level });
      const next = { ...memberVolumes };
      if (level === 100) delete next[accountId];
      else next[accountId] = level;
      memberVolumes = next;
      if (serverId) await saveMemberVolumes(serverId, next);
    });
  }

  async function disconnect() {
    if (connectBusy) return false;
    if (!await run("disconnect", "disconnect")) return false;
    playUiSound("disconnect");
    roomView = "chat";
    serverInfo = null;
    serverOrigin = "";
    selectedChannelId = null;
    openWorkspace("room");
    return true;
  }

  function showServerSettings() {
    if (!canAdminister || connectBusy || pending) return;
    roomView = "serverSettings";
    openWorkspace("room");
  }

  function showChat() {
    roomView = "chat";
    openWorkspace("room");
  }

  function serverActions(entry: SavedServer) {
    const actions = [];
    if (entry.origin === serverOrigin && canAdminister) {
      actions.push({ label: "Server administration", onSelect: showServerSettings });
    }
    actions.push({ label: "Remove server", onSelect: () => {
      removingServer = entry;
      removeError = "";
      removeServerOpen = true;
    } });
    return actions;
  }

  async function removeServer() {
    if (!removingServer || removing || pending || connectBusy) return;
    const { origin } = removingServer;
    removing = true;
    removeError = "";
    try {
      if (origin === serverOrigin && !await disconnect()) throw new Error(actionError || "Could not disconnect from the server.");
      await preferences.servers.delete(origin);
      savedServers = savedServers.filter((server) => server.origin !== origin);
      removeServerOpen = false;
    } catch (error) {
      removeError = messageFrom(error);
    } finally {
      removing = false;
    }
  }
</script>

<svelte:head>
  <title>VNX.chat</title>
</svelte:head>

<svelte:window bind:innerWidth={viewport} onkeydown={audio.talkKeyDown} onkeyup={audio.talkKeyUp} onblur={audio.stopTalking} />

<Root>
  <div class="shell" data-pane={onWorkspace ? mobilePane : "room"} data-workspace={onWorkspace} style:--rail-width={railWidth + "px"} style:--channel-width={channelWidth + "px"}>
    <aside id="server-rail" class="server-rail" aria-label="Servers">
      <div class="rail-top">
        <div class="brand" role="img" aria-label="VNX.chat">
          <span class="brand-logo" style:--brand-logo={`url("${asset("/vnx-logo.svg")}")`}></span><span class="brand-domain">.chat</span>
        </div>
        <Button class="rail-connect" disabled={!identityReady || connectBusy || Boolean(pending)} onclick={() => showConnect()}><Plus size={18} /> Connect to server</Button>
        <section class="rail-section">
          <div class="rail-section-label"><span>Servers</span></div>
          {#if serverOrigin}
            <div class="active-server">
              <ContextActions actions={serverActions({ origin: serverOrigin, name: serverTitle })} disabled={connectBusy || Boolean(pending)}>
                {#snippet trigger(props)}
                  <button {...props} type="button" class="rail-server" onclick={() => openWorkspace("channels")}>
                    <span class="shrinkable"><strong class="truncate">{serverTitle}</strong><small class="truncate">{shortHost(serverOrigin)}</small></span>
                    <span class="connection-dot" data-online={online}></span>
                  </button>
                {/snippet}
              </ContextActions>
              <button type="button" class="disconnect-server" aria-label={`Disconnect from ${serverTitle}`} title="Disconnect"
                disabled={connectBusy || Boolean(pending)} onclick={() => { void disconnect(); }}>
                <X size={16} aria-hidden="true" />
              </button>
            </div>
          {/if}
          {#each savedServers.filter((entry) => entry.origin !== serverOrigin) as entry (entry.origin)}
            <ContextActions actions={serverActions(entry)} disabled={connectBusy || Boolean(pending)}>
              {#snippet trigger(props)}
            <button {...props} tabindex="0" class="rail-server" onclick={() => selectBookmark(entry.origin)}>
              <span class="shrinkable"><strong class="truncate">{entry.name}</strong>
                {#if connectBusy && bookmarkOrigin === entry.origin && !connectOpen}<small role="status">Connecting…</small>{/if}
              </span>
            </button>
              {/snippet}
            </ContextActions>
          {:else}
            {#if !serverOrigin}<p class="rail-empty">No saved servers</p>{/if}
          {/each}
        </section>
      </div>
      <div class="rail-bottom">
        <div class="account-line">
          <Avatar name={me?.displayName ?? username} />
          <div class="flex-content">
            <strong class="truncate">{me?.displayName ?? (username || "Guest")}</strong>
            <span class="account-status"><span class="connection-dot" data-online={online}></span>{status}</span>
          </div>

          <a class="icon-button rail-icon" href={resolve("/settings")} aria-label="Account settings" aria-current={page.route.id === "/settings" ? "page" : undefined} title="Account settings"><Settings2 size={17} /></a>
        </div>
      </div>
    </aside>
    <PaneDivider label="Resize server sidebar" controls="server-rail" value={railWidth} min={180} max={railMax} resize={(value, commit) => resizePane("rail", value, commit)} />


    {@render children()}

    <nav class="mobile-nav" aria-label="Workspace navigation">
      <button aria-current={onWorkspace && mobilePane === "servers" ? "page" : undefined} onclick={() => openWorkspace("servers")}><Server size={18} /> Servers</button>
      <button aria-current={onWorkspace && mobilePane === "channels" ? "page" : undefined} onclick={() => openWorkspace("channels")}><ListTree size={18} /> Channels</button>
      <button aria-current={onWorkspace && mobilePane === "room" && roomView === "chat" ? "page" : undefined} onclick={showChat}><AudioLines size={18} /> Chat</button>
      <a href={resolve("/settings")} aria-current={!onWorkspace ? "page" : undefined}><Settings2 size={18} /> Settings</a>
    </nav>
  </div>

  <IdentitySetup open={identitySetupOpen} {hasIdentity} migrationError={identityLoadError}
    oncomplete={(name) => { username = name; identityReady = true; identitySetupOpen = false; }} />

  <Modal bind:open={connectOpen} title={trustPrompt ? (trustPrompt.previous ? "Server certificate changed" : "Trust this server?") : discovery ? discovery.info.name : "Connect to a server"} description={discovery ? shortHost(discovery.origin) : "Paste an invitation link or enter a server address."} dismissible={!connectBusy}>
    {#snippet icon()}<Cable size={21} />{/snippet}
    {#if connectError}<p class="form-error" role="alert">{connectError}</p>{/if}
    {#if trustPrompt}
      <div class="dialog-form">
        <p>{trustPrompt.origin}</p>
        <p>Compare the certificate fingerprint with the one provided by your server operator.</p>
        {#if trustPrompt.previous}
          <div><small>Previously trusted SHA-256</small><div class="key-display"><code>{trustPrompt.previous}</code></div></div>
        {/if}
        <div><small>Presented SHA-256</small><div class="key-display"><code>{trustPrompt.fingerprint}</code></div></div>
        <div class="dialog-actions">
          <Button disabled={connectBusy} onclick={() => { trustPrompt = null; }}>Back</Button>
          <Button variant="alternate" disabled={connectBusy} onclick={approveTrust}>Trust and continue</Button>
        </div>
      </div>
    {:else if discovery && accessPrompt}
      <form class="dialog-form" onsubmit={submitServerCode}>
        {#if discovery.info.setupRequired}
          <label>Server setup token
            <Input type="password" autocomplete="off" spellcheck="false" bind:value={setupToken} />
          </label>
          <p class="field-hint">Enter the token to claim ownership, or leave it blank to connect as a member.</p>
        {/if}
        {#if needsPassword && !claimOwnership}
          <label>Server password<Input type="password" autocomplete="current-password" required maxlength={128} bind:value={serverPassword} /></label>
        {/if}
        {#if invitationRequired && !claimOwnership}
          <label>Invitation code
            <Input type="password" required autocomplete="off" spellcheck="false" bind:value={serverCode} />
          </label>
        {/if}
        <div class="dialog-actions">
          <Button type="button" disabled={connectBusy} onclick={() => resetConnect(discoverAddress)}>Back</Button>
          <Button type="submit" variant="alternate" disabled={connectBusy}>{connectBusy ? "Connecting…" : claimOwnership ? "Set up server" : "Connect"} <ArrowRight size={16} /></Button>
        </div>
      </form>
    {:else}
      <form class="dialog-form" onsubmit={discover}>
        <label>Server address or invitation link<Input required autocomplete="off" inputmode="url" placeholder="example.com:8443" spellcheck="false" disabled={connectBusy} bind:value={discoverAddress} /></label>
        <Checkbox label="Save this server address" bind:checked={remembered} />
        <Button variant="alternate" type="submit" disabled={connectBusy}>{connectBusy ? "Connecting…" : "Connect"} <ArrowRight size={16} /></Button>
      </form>
    {/if}
  </Modal>

  <Modal bind:open={removeServerOpen} title="Remove server?" description={removingServer?.name ?? "Remove this server from your list."} dismissible={!removing}>
    {#if removeError}<p class="form-error" role="alert">{removeError}</p>{/if}
    <div class="dialog-actions">
      <Button onclick={() => { removeServerOpen = false; }} disabled={removing}>Cancel</Button>
      <Button variant="alternate" onclick={removeServer} disabled={removing}>{removing ? "Removing…" : "Remove server"}</Button>
    </div>
  </Modal>

</Root>

{#snippet serverSettings()}
  {#if serverInfo}
    {#key serverOrigin}
      <ServerAdministration origin={serverOrigin} title={serverTitle} permissions={serverPermissions}
        bannerSupported={serverInfo.bannerImageUrl !== undefined} {bannerImageUrl} onclose={showChat}
        passwordRequired={Boolean(serverInfo.passwordRequired)} onPasswordChange={(origin, passwordRequired) => {
          if (serverInfo && origin === serverOrigin) serverInfo = { ...serverInfo, passwordRequired };
        }} />
    {/key}
  {/if}
{/snippet}
