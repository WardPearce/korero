<script lang="ts">
  import "@fontsource-variable/dm-sans";
  import "@fontsource-variable/manrope";
  import "../app.css";

  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { Tooltip } from "bits-ui";
  import { ArrowRight, AudioLines, Bookmark, Cable, ListTree, Plus, Server, Settings2 } from "lucide-svelte";
  import { onMount } from "svelte";
  import QuickAudio from "$lib/QuickAudio.svelte";
  import { AudioSettings, setAudioSettings } from "$lib/audio.svelte";
  import PaneDivider from "$lib/PaneDivider.svelte";
  import { getUsername, migrateSavedServers, preferences, type SavedServer } from "$lib/preferences";
  import Avatar from "$lib/Avatar.svelte";
  import ContextActions from "$lib/ContextActions.svelte";
  import IdentitySetup from "$lib/IdentitySetup.svelte";
  import Modal from "$lib/Modal.svelte";
  import ServerAdministration from "$lib/ServerAdministration.svelte";
  import {
    apiFor, call, messageFrom, nativeApp, offline, requestError, shortHost, watchVoice,
    type ServerInfo, type VoiceState,
  } from "$lib/client";
  import { authenticateIdentity, identityError, loadIdentity } from "$lib/identity";
  import { browserServerOrigin, browserSession } from "$lib/browser-session";
  import { setWorkspace, type MobilePane } from "$lib/workspace";

  let { children } = $props();
  const audio = setAudioSettings(new AudioSettings());

  type Target = { origin: string; info: ServerInfo };
  const deviceName = "Kōrero";

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
  let discoverAddress = $state("");
  interface CertificateContact { origin: string; fingerprint: string; publiclyTrusted: boolean }
  let trustPrompt = $state<(CertificateContact & { previous?: string }) | null>(null);
  let discovery = $state.raw<Target | null>(null);
  let accessPrompt = $state(false);
  let claimOwnership = $state(false);
  let invitationRequired = $state(false);
  let serverCode = $state("");
  let serverPassword = $state("");
  let administrationOpen = $state(false);
  let removingServer = $state.raw<SavedServer | null>(null);
  let removeServerOpen = $state(false);
  let removing = $state(false);
  let removeError = $state("");
  let remembered = $state(true);
  let pending = $state("");
  let actionError = $state("");
  let selectedChannelId = $state<string | null>(null);
  let mobilePane = $state<MobilePane>("room");

  let me = $derived(view.snapshot?.account);
  let online = $derived(view.phase === "online");
  let serverPermissions = $derived(view.snapshot?.serverPermissions ?? []);
  let canAdminister = $derived(online && Boolean(serverInfo?.serverAdministration) &&
    ["manageRoles", "manageSettings", "manageInvitations"].some((permission) => serverPermissions.includes(permission)));
  let onWorkspace = $derived(page.route.id === "/");
  let serverTitle = $derived(serverInfo?.name ?? (serverOrigin ? shortHost(serverOrigin) : "No server connected"));
  let status = $derived(
    view.phase === "online" ? "Connected" : view.phase === "connecting" ? "Connecting" :
      view.phase === "reconnecting" ? "Reconnecting" : view.phase === "error" ? "Connection lost" : "Offline",
  );

  setWorkspace({
    get view() { return view; },
    get serverOrigin() { return serverOrigin; },
    get serverTitle() { return serverTitle; },
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
    showConnect,
    run,
    disconnect,
  });

  onMount(() => {
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
      const state = await call<VoiceState>("voice_state");
      if (mounted && !receivedEvent) applyView(state);
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
    claimOwnership = false;
    invitationRequired = false;
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
    administrationOpen = false;
    serverInfo = null;
    serverOrigin = "";
    selectedChannelId = null;
    const result = await apiFor(origin).server.info.get();
    if (result.error) throw requestError(result.error);
    if (!result.data || !("serverId" in result.data)) throw new Error("This server did not return Kōrero server details.");
    const target = { origin, info: result.data };
    discovery = target;
    if (!target.info.identityAuthentication || !target.info.identityEnrollment) {
      throw new Error("Update this server to a Kōrero version that supports identity sign-in.");
    }
    if (target.info.setupRequired || target.info.passwordRequired) {
      accessPrompt = true;
      connectOpen = true;
      return;
    }
    await signIn(target);
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
      if (!nativeApp()) {
        const origin = browserServerOrigin(discoverAddress.trim());
        await browserSession.select(origin);
        await discoverServerInfo(origin);
        return;
      }
      const contact = await call<CertificateContact>("inspect_server", { address: discoverAddress.trim() });
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
      if (claimOwnership) await enroll(discovery);
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
    const result = await authenticateIdentity(target.origin, target.info.serverId, deviceName,
      claimOwnership
        ? { operation: "bootstrap", displayName: username, token: code }
        : { operation: "register", displayName: username, invitation: code || undefined, password });
    if (result.status === 409) {
      const login = await authenticateIdentity(target.origin, target.info.serverId, deviceName, { operation: "login", password });
      if (login.status === 200) {
        await finishConnection(target);
        return;
      }
    }
    if (result.status !== 201) throw identityError(result);
    const account = result.body;
    if (!account || typeof account !== "object" || !("account" in account)) {
      throw new Error("This server did not return an account.");
    }
    await finishConnection(target);
  }

  async function finishConnection(target: Target) {
    serverInfo = claimOwnership ? { ...target.info, setupRequired: false } : target.info;
    serverOrigin = target.origin;
    try {
      await audio.load();
      if (nativeApp()) await call("start_session");
      else await browserSession.start();
    } catch (error) {
      actionError = messageFrom(error);
    }
    if (remembered) {
      const entry = { name: target.info.name, origin: target.origin };
      savedServers = [entry, ...savedServers.filter(({ origin }) => origin !== target.origin)];
      await preferences.servers.put(entry).catch((error) => { actionError = messageFrom(error); });
    }
    connectOpen = false;
    openWorkspace("channels");
    connectError = "";
    serverCode = "";
    serverPassword = "";
  }

  async function run(action: string, command: string, args?: Record<string, unknown>) {
    if (pending) return false;
    pending = action;
    actionError = "";
    try {
      if (nativeApp()) await call(command, args);
      else if (command === "disconnect") await browserSession.disconnect();
      else if (command === "save_channel") await browserSession.saveChannel(args?.payload as Record<string, unknown>);
      else throw new Error("Open Kōrero in the desktop app to use voice.");
      return true;
    } catch (error) {
      actionError = messageFrom(error);
      return false;
    } finally {
      pending = "";
    }
  }

  async function disconnect() {
    if (connectBusy) return false;
    if (!await run("disconnect", "disconnect")) return false;
    administrationOpen = false;
    serverInfo = null;
    serverOrigin = "";
    selectedChannelId = null;
    openWorkspace("room");
    return true;
  }

  function serverActions(entry: SavedServer) {
    const actions = [];
    if (entry.origin === serverOrigin && canAdminister) {
      actions.push({ label: "Server administration", select: () => { administrationOpen = true; } });
    }
    actions.push({ label: "Remove server", danger: true, select: () => {
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
  <title>Kōrero</title>
</svelte:head>

{#snippet brand()}
  <span class="brand-symbol" aria-hidden="true"><AudioLines size={24} strokeWidth={2.35} /></span>
  <span class="brand-name">kōrero<span>.</span></span>
{/snippet}

<svelte:window bind:innerWidth={viewport} onkeydown={audio.talkKeyDown} onkeyup={audio.talkKeyUp} onblur={audio.stopTalking} />

<Tooltip.Provider delayDuration={350}>
  <div class="shell" data-pane={onWorkspace ? mobilePane : "room"} data-workspace={onWorkspace} style:--rail-width={railWidth + "px"} style:--channel-width={channelWidth + "px"}>
    <aside id="server-rail" class="server-rail" aria-label="Servers">
      <div class="rail-top">
        <div class="brand">{@render brand()}</div>
        <button class="rail-connect" disabled={!identityReady || connectBusy || Boolean(pending)} onclick={() => showConnect()}><Plus size={18} /> Connect to server</button>
        <section class="rail-section">
          <div class="rail-section-label"><span>Servers</span></div>
          {#if serverOrigin}
            <ContextActions actions={serverActions({ origin: serverOrigin, name: serverTitle })} disabled={connectBusy || Boolean(pending)}>
              {#snippet trigger({ props })}
            <button {...props} tabindex="0" class="rail-server current" onclick={() => openWorkspace("channels")}>
              <span class="rail-tile"><Server size={16} strokeWidth={1.8} /></span>
              <span class="min-w-0"><strong class="truncate">{serverTitle}</strong><small class="truncate">{shortHost(serverOrigin)}</small></span>
              <span class="connection-dot" data-online={online}></span>
            </button>
              {/snippet}
            </ContextActions>
          {:else}
            <p class="rail-empty">No active connection</p>
          {/if}
        </section>
        <section class="rail-section">
          <div class="rail-section-label"><span>Saved servers</span><Bookmark size={14} strokeWidth={1.6} /></div>
          {#each savedServers as entry (entry.origin)}
            <ContextActions actions={serverActions(entry)} disabled={connectBusy || Boolean(pending)}>
              {#snippet trigger({ props })}
            <button {...props} tabindex="0" class="rail-server" onclick={() => selectBookmark(entry.origin)}>
              <span class="rail-tile"><Server size={17} strokeWidth={1.8} /></span>
              <span class="min-w-0"><strong class="truncate">{entry.name}</strong>
                {#if connectBusy && bookmarkOrigin === entry.origin && !connectOpen}<small role="status">Connecting…</small>{/if}
              </span>
            </button>
              {/snippet}
            </ContextActions>
          {:else}
            <p class="rail-empty">Saved servers appear here.</p>
          {/each}
        </section>
      </div>
      <div class="rail-bottom">
        <div class="account-line">
          <Avatar name={me?.displayName ?? username} />
          <div class="min-w-0 grow">
            <strong class="block truncate">{me?.displayName ?? (username || "Guest")}</strong>
            <span class="account-status"><span class="connection-dot" data-online={online}></span>{status}</span>
          </div>

          <QuickAudio />
          <a class="icon-button rail-icon" href={resolve("/settings")} aria-label="Account settings" aria-current={page.route.id === "/settings" ? "page" : undefined} title="Account settings"><Settings2 size={17} /></a>
        </div>
      </div>
    </aside>
    <PaneDivider label="Resize server sidebar" controls="server-rail" value={railWidth} min={180} max={railMax} resize={(value, commit) => resizePane("rail", value, commit)} />


    {@render children()}

    <nav class="mobile-nav" aria-label="Workspace navigation">
      <button aria-current={onWorkspace && mobilePane === "servers" ? "page" : undefined} onclick={() => openWorkspace("servers")}><Server size={18} /> Servers</button>
      <button aria-current={onWorkspace && mobilePane === "channels" ? "page" : undefined} onclick={() => openWorkspace("channels")}><ListTree size={18} /> Channels</button>
      <button aria-current={onWorkspace && mobilePane === "room" ? "page" : undefined} onclick={() => openWorkspace("room")}><AudioLines size={18} /> Chat</button>
      <a href={resolve("/settings")} aria-current={!onWorkspace ? "page" : undefined}><Settings2 size={18} /> Settings</a>
    </nav>
  </div>
</Tooltip.Provider>

<IdentitySetup open={identitySetupOpen} {hasIdentity} migrationError={identityLoadError}
  oncomplete={(name) => { username = name; identityReady = true; identitySetupOpen = false; }} />

<Modal bind:open={connectOpen} title={trustPrompt ? (trustPrompt.previous ? "Server certificate changed" : "Trust this server?") : discovery ? discovery.info.name : "Connect to a server"} description={discovery ? shortHost(discovery.origin) : "Enter the address of a Kōrero server."} dismissible={!connectBusy}>
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
        <button class="secondary-button" disabled={connectBusy} onclick={() => { trustPrompt = null; }}>Back</button>
        <button class="primary-button" disabled={connectBusy} onclick={approveTrust}>Trust and continue</button>
      </div>
    </div>
  {:else if discovery && accessPrompt}
    <form class="dialog-form" onsubmit={submitServerCode}>
      {#if discovery.info.setupRequired}
        <label class="checkbox-label"><input type="checkbox" bind:checked={claimOwnership}
          onchange={() => { serverCode = ""; connectError = ""; }} /> Claim server ownership</label>
      {/if}
      {#if discovery.info.passwordRequired && !claimOwnership}
        <label>Server password<input type="password" autocomplete="current-password" required maxlength="128" bind:value={serverPassword} /></label>
      {/if}
      {#if claimOwnership || invitationRequired}
        <label>{claimOwnership ? "Server setup token" : "Invitation code"}
          <input type="password" required autocomplete="off" spellcheck="false" bind:value={serverCode} />
        </label>
      {/if}
      <div class="dialog-actions">
        <button class="secondary-button" type="button" disabled={connectBusy} onclick={() => resetConnect(discoverAddress)}>Back</button>
        <button type="submit" class="primary-button" disabled={connectBusy}>{connectBusy ? "Connecting…" : claimOwnership ? "Set up server" : "Connect"} <ArrowRight size={16} /></button>
      </div>
    </form>
  {:else}
    <form class="dialog-form" onsubmit={discover}>
      <label>Server address<input required autocomplete="off" inputmode="url" placeholder="voice.example.net:8443" spellcheck="false" bind:value={discoverAddress} /></label>
      <label class="checkbox-label"><input type="checkbox" bind:checked={remembered} /> Save this server address</label>
      <button class="primary-button justify-center" type="submit" disabled={connectBusy}>{connectBusy ? "Connecting…" : "Connect"} <ArrowRight size={16} /></button>
    </form>
  {/if}
</Modal>

<Modal bind:open={removeServerOpen} title="Remove server?" description={removingServer?.name ?? "Remove this server from your list."} dismissible={!removing}>
  {#if removeError}<p class="form-error" role="alert">{removeError}</p>{/if}
  <div class="dialog-actions">
    <button class="secondary-button" onclick={() => { removeServerOpen = false; }} disabled={removing}>Cancel</button>
    <button class="primary-button" onclick={removeServer} disabled={removing}>{removing ? "Removing…" : "Remove server"}</button>
  </div>
</Modal>

{#if administrationOpen && serverInfo && canAdminister}
  <ServerAdministration bind:open={administrationOpen} origin={serverOrigin} title={serverTitle} permissions={serverPermissions}
    passwordRequired={Boolean(serverInfo.passwordRequired)} onPasswordChange={(passwordRequired) => {
      if (serverInfo) serverInfo = { ...serverInfo, passwordRequired };
    }} />
{/if}

