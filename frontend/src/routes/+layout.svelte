<script lang="ts">
  import { playUiSound } from "#lib/ui-sounds";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import "../app.css";

  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { AudioLines, BellRing, ListTree, Server, Settings2, X } from "@lucide/svelte";
  import { onMount } from "svelte";
  import { AudioSettings, setAudioSettings } from "#lib/media/audio.svelte";
  import { ShortcutSettings, setShortcutSettings } from "#lib/media/shortcut-settings.svelte";
  import type { VoicePresence } from "#lib/media/voice-shortcuts";
  import { DesktopVoice, type DesktopMediaEvent } from "#lib/media/desktop-voice";
  import PaneDivider from "#lib/components/PaneDivider.svelte";
  import { defaultMemberVolume, forgetPassword, getLocalBookmarkPasswords, getMemberVolumes, getSavedPassword, preferences, saveMemberVolumes, savePassword, type SavedServer } from "#lib/preferences";
  import AccountSetup from "#lib/components/AccountSetup.svelte";
  import LocalIdentitySetup from "#lib/components/LocalIdentitySetup.svelte";
  import DeviceLinkImport from "#lib/components/DeviceLinkImport.svelte";
  import { createHostedDeviceLink, createLocalDeviceLink } from "#lib/identity/device-link";
  import IconButton from "#lib/components/IconButton.svelte";
  import Modal from "#lib/components/Modal.svelte";
  import WindowTitleBar from "#lib/components/WindowTitleBar.svelte";
  import ConnectServerModal from "#lib/components/server/ConnectServerModal.svelte";
  import ConnectionInfo from "#lib/components/server/ConnectionInfo.svelte";
  import ScreenSharing from "#lib/components/media/ScreenSharing.svelte";
  import CapturePicker from "#lib/components/media/CapturePicker.svelte";
  import VoiceToolbar from "#lib/components/media/VoiceToolbar.svelte";
  import CallPictureInPicture from "#lib/components/media/CallPictureInPicture.svelte";
  import { callPip } from "#lib/media/call-pip";
  import ServerAdministration from "#lib/components/server/ServerAdministration.svelte";
  import ServerRail from "#lib/components/server/ServerRail.svelte";
  import {
    apiFor, call, directRequest, messageFrom, desktopApp, offline, requestError, shortHost, startSession, watchDesktopSession,
    type DesktopSessionState, type DirectMessageChange, type Member, type MemberRequest, type Poke, type ServerInfo, type VoiceState,
  } from "#lib/connection/client";
  import { framelessDesktopWindow, mobileApp, setNativeTitleBar, voiceApp, watchDesktop } from "#lib/connection/platform";
  import { authenticateIdentity, getIdentity, identityError, setIdentity } from "#lib/identity/identity";
  import { HostedAccount, type AccountPreferences, type BookmarkPassword } from "#lib/identity/hosted-account";
  import { identityModeKey, readLocalIdentity, rememberIdentityMode, type LocalProfile } from "#lib/identity/local-identity";
  import { createProfilePictureCache } from "#lib/identity/profile-picture";
  import { browserServerOrigin, browserSessions } from "#lib/connection/browser-session";
  import { certificateApproval, inspectServer, trustServer, type CertificateContact } from "#lib/connection/server-trust";
  import { applyAppearance, readAppearance, saveAppearance, type Appearance } from "#lib/theme";
  import { readChatDisplay, saveChatDisplay, setChatDisplay, type ChatDisplay } from "#lib/chat/chat-display";
  import { mobilePaneSwipe } from "#lib/mobile-pane-swipe";
  import { setWorkspace, type ChannelPlacement, type MobilePane, type RoomView } from "#lib/workspace";

  let { children } = $props();
  const desktopVoice = new DesktopVoice(updateDesktopVoice);
  const audio = setAudioSettings(new AudioSettings(desktopVoice));
  const shortcuts = setShortcutSettings(new ShortcutSettings(audio));
  const voiceAvailable = voiceApp();
  let chatDisplay = $state.raw(readChatDisplay());
  setChatDisplay({
    get value() { return chatDisplay; },
    update(value: ChatDisplay) {
      chatDisplay = value;
      return saveChatDisplay(value);
    },
  });

  type Target = { origin: string; info: ServerInfo };
  const deviceName = "Korero.chat";

  let viewport = $state(1200);
  const mobileVoice = $derived(mobileApp() || viewport <= 760);
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

  /** A signed-in server. The client stays connected to every saved server at once. */
  interface ServerConnection {
    origin: string;
    info: ServerInfo | null;
    view: VoiceState;
    unread: ReadonlyMap<string, number>;
    memberVolumes: Record<string, number>;
    /** Why automatic sign-in stopped. Selecting the server runs the interactive connect flow. */
    attention: string;
  }
  const focusKey = "focusedServer";
  let connections = $state.raw<ReadonlyMap<string, ServerConnection>>(new Map());
  // The server shown in the workspace. Other connections keep running in the background.
  let serverOrigin = $state("");
  const focused = $derived(connections.get(serverOrigin));
  const view = $derived(focused?.view ?? offline);
  // Prefer a voice session on the focused server, otherwise keep showing the one we are joined to.
  const voiceConnection = $derived(focused?.view.phase === "online" && focused.view.snapshot?.channelId
    ? focused
    : [...connections.values()].find((entry) => entry.view.phase === "online" && entry.view.snapshot?.channelId));
  const voiceSnapshot = $derived(voiceConnection?.view.snapshot);
  const ownVoiceMember = $derived(voiceSnapshot?.members.find(({ connectionId }) => connectionId === voiceSnapshot?.connectionId));
  // Android shrinks the app into a picture-in-picture window while in a voice channel.
  let pictureInPicture = $state(false);
  const serverInfo = $derived(focused?.info ?? null);
  const memberVolumes = $derived(focused?.memberVolumes ?? {});
  let resolveRestored = () => {};
  // Desktop sessions survive a renderer reload. Wait for them before connecting saved servers.
  const restored = new Promise<void>((resolve) => { resolveRestored = resolve; });
  let savedServers = $state.raw<SavedServer[]>([]);
  let bookmarkPasswords: BookmarkPassword[] = [];
  let hostedAccount = $state.raw<HostedAccount>();
  let deviceAppearance = readAppearance();
  let appearance = $state.raw(deviceAppearance);
  let username = $state("");
  let identityReady = $derived(Boolean(username));
  let setup = $state<"hosted" | "local" | "link" | "transfer" | null>(null);
  let profileUpdate = Promise.resolve();
  let connectOpen = $state(false);
  let connectBusy = $state(false);
  let connectError = $state("");
  let bookmarkOrigin = $state("");
  let discoverAddress = $state(import.meta.env.VITE_DEFAULT_SERVER || "");
  let trustPrompt = $state<(CertificateContact & { previous?: string }) | null>(null);
  let discovery = $state.raw<Target | null>(null);
  let accessPrompt = $state(false);
  let invitationRequired = $state(false);
  let setupToken = $state("");
  let serverCode = $state("");
  let serverPassword = $state("");
  let savedServerPassword = $state<string>();
  let removingServer = $state.raw<SavedServer | null>(null);
  let removeServerOpen = $state(false);
  let removing = $state(false);
  let removeError = $state("");
  let remembered = $state(true);
  let pending = $state("");
  let memberVolumeUpdate = Promise.resolve(true);
  let actionError = $state("");
  let selectedChannelId = $state<string | null>(null);
  let mobilePane = $state<MobilePane>(typeof window !== "undefined" && mobileApp() ? "servers" : "room");
  const swipePanes = mobilePaneSwipe(() => onWorkspace ? mobilePane : "settings", (pane) => {
    if (pane === "settings") void goto(resolve("/settings"));
    else openWorkspace(pane);
  });
  let roomView = $state<RoomView>("chat");
  let screenShareViewerTarget = $state<HTMLElement>();
  let screenShareControlsTarget = $state<HTMLElement>();
  let directAccountId = $state<string | null>(null);
  const directChangeListeners = new Set<(origin: string, connectionId: string, change: DirectMessageChange) => void>();
  let connectionInfo = $state.raw<{ origin: string; viewerId: string; connectionId: string } | null>(null);
  const unreadDirectCounts = $derived(focused?.unread ?? new Map<string, number>());
  const unreadDirectCount = $derived([...unreadDirectCounts.values()].reduce((total, count) => total + count, 0));
  let poke = $state.raw<(Poke & { origin: string }) | null>(null);
  let pokeTarget = $state.raw<(Pick<Member, "accountId" | "displayName"> & { viewerId: string }) | null>(null);
  let pokeDraft = $state("");
  let pokeError = $state("");
  let sendingPoke = $state(false);

  let me = $derived(view.snapshot?.account);
  let online = $derived(view.phase === "online");
  const profilePictureCache = createProfilePictureCache();
  const avatarIds = $derived(new Map(view.snapshot?.presence.map(({ accountId, avatarId }) => [accountId, avatarId])));
  let serverPermissions = $derived(view.snapshot?.serverPermissions ?? []);
  let canAdminister = $derived(online && Boolean(serverInfo?.serverAdministration) &&
    (["manageRoles", "manageSettings", "manageInvitations"].some((permission) => serverPermissions.includes(permission)) ||
      Boolean(serverInfo?.extendedServerAdministration && serverPermissions.includes("viewAdmin"))));
  let onWorkspace = $derived(page.route.id === "/");
  // Saved servers, plus connections the user chose not to save.
  const railServers = $derived.by(() => {
    const entries = [
      ...[...connections.keys()].filter((origin) => !savedServers.some((entry) => entry.origin === origin))
        .map((origin) => ({ origin, name: serverName(origin) })),
      ...savedServers.map((entry) => ({ ...entry, name: connections.get(entry.origin)?.info?.name ?? entry.name })),
    ];
    return entries.map((entry) => {
      const connection = connections.get(entry.origin);
      return {
        origin: entry.origin,
        name: entry.name,
        connected: Boolean(connection),
        unread: connection ? [...connection.unread.values()].reduce((total, count) => total + count, 0) : 0,
        attention: connection?.attention,
        phase: connection?.view.phase,
        connecting: connectBusy && bookmarkOrigin === entry.origin && !connectOpen,
        focused: entry.origin === serverOrigin,
        actions: serverActions(entry),
      };
    });
  });
  // Keep saved bookmark names in step with a server that has been renamed.
  $effect(() => {
    const renamed = savedServers.flatMap((entry) => {
      const name = connections.get(entry.origin)?.info?.name;
      return name && name !== entry.name ? [{ ...entry, name }] : [];
    });
    if (!renamed.length) return;
    void updateSavedServers((servers) => servers.map((entry) => {
      const renamedEntry = renamed.find(({ origin }) => origin === entry.origin);
      return renamedEntry ? { ...entry, name: renamedEntry.name } : entry;
    })).catch(() => {});
  });
  let serverTitle = $derived(serverInfo?.name ?? (serverOrigin ? shortHost(serverOrigin) : online ? "Connected server" : "No server connected"));
  let bannerImageUrl = $derived(view.snapshot?.bannerImageUrl === undefined ? serverInfo?.bannerImageUrl ?? null : view.snapshot.bannerImageUrl);
  let claimOwnership = $derived(Boolean(discovery?.info.setupRequired && setupToken.trim()));
  let needsPassword = $derived(Boolean(discovery?.info.passwordRequired && !savedServerPassword &&
    (claimOwnership || !discovery.info.invitationPasswordBypass || !serverCode.trim())));
  let status = $derived(
    view.phase === "online" ? "Connected" : view.phase === "connecting" ? "Connecting" :
      view.phase === "reconnecting" ? "Reconnecting" : view.phase === "error" ? "Connection lost" : "Offline",
  );

  setWorkspace({
    get identity() {
      const identity = getIdentity();
      if (username && identity) return { provider: hostedAccount?.origin, username, publicKey: identity.publicKey };
    },
    showAccountSetup() { if (identityReady && !connectBusy && !pending && !removing) setup = "transfer"; },
    async createDeviceLink() {
      if (hostedAccount) return createHostedDeviceLink(hostedAccount);
      const profile = await readLocalIdentity();
      if (!profile) throw new Error("This device has no identity to link.");
      return createLocalDeviceLink(profile);
    },
    signOut,
    get appearance() { return appearance; },
    updateAppearance,
    get view() { return view; },
    get activeVoice() {
      return voiceConnection ? { origin: voiceConnection.origin, view: voiceConnection.view } : undefined;
    },
    get serverOrigin() { return serverOrigin; },
    get serverId() { return serverInfo?.serverId ?? ""; },
    get serverTitle() { return serverTitle; },
    get bannerImageUrl() { return bannerImageUrl; },
    get canAdminister() { return canAdminister; },
    get serverSettings() { return roomView === "serverSettings" && canAdminister ? serverSettings : undefined; },
    get channelBackgrounds() { return Boolean(serverInfo?.channelBackgrounds); },
    get channelIcons() { return Boolean(serverInfo?.channelIcons); },
    get profilePictures() { return serverInfo?.profilePictures === true; },
    avatarId(accountId) { return accountId === me?.id ? me.avatarId : avatarIds.get(accountId); },
    profilePicture: profilePictureCache.get,
    cacheProfilePicture: profilePictureCache.set,
    get maxAttachmentBytes() { return view.snapshot?.maxAttachmentBytes ?? serverInfo?.maxAttachmentBytes ?? 0; },
    get richChat() { return serverInfo?.richChat === true; },
    get maxWebSocketBytes() { return serverInfo?.maxWebSocketBytes; },
    get screenSharing() { return Boolean(serverInfo?.screenSharing); },
    get screenShareViewerTarget() { return screenShareViewerTarget; },
    set screenShareViewerTarget(value) { screenShareViewerTarget = value; },
    get screenShareControlsTarget() { return screenShareControlsTarget; },
    set screenShareControlsTarget(value) { screenShareControlsTarget = value; },
    get channelAudioQuality() { return Boolean(serverInfo?.channelAudioQuality); },
    get mobileVoice() { return mobileVoice; },
    get channelWidth() { return channelWidth; },
    get channelMax() { return channelMax; },
    resizeChannel(value, commit) { resizePane("channel", value, commit); },
    get pending() { return pending; },
    get actionError() { return actionError; },
    set actionError(value) { actionError = value; },
    get selectedChannelId() { return selectedChannelId; },
    set selectedChannelId(value) { selectedChannelId = value; },
    viewChannel(connectionId, channelId) {
      const origin = serverOrigin;
      if (!origin) return;
      const request = desktopApp() ? call("view_channel", { origin, connectionId, channelId })
        : browserSessions.session(origin).viewChannel(connectionId, channelId);
      void request.catch(() => {});
    },
    get mobilePane() { return mobilePane; },
    set mobilePane(value) { mobilePane = value; },
    get roomView() { return roomView; },
    set roomView(value) { roomView = value; },
    get directAccountId() { return directAccountId; },
    get unreadDirectCounts() { return unreadDirectCounts; },
    get unreadDirectCount() { return unreadDirectCount; },
    watchDirectChanges(connectionId, listener) {
      const origin = serverOrigin;
      const receive = (sourceOrigin: string, sourceConnection: string, change: DirectMessageChange) => {
        if (sourceOrigin === origin && sourceConnection === connectionId) listener(change);
      };
      directChangeListeners.add(receive);
      return () => directChangeListeners.delete(receive);
    },
    showDirectMessages,
    showPoke,
    showConnectionInfo,
    showConnect,
    showServerSettings,
    run,
    canSetVoicePresence,
    setVoicePresence,
    runAction,
    memberAction,
    memberVolume(accountId) { return memberVolumes[accountId] ?? defaultMemberVolume; },
    setMemberVolume,
    reorderChannel,
    disconnect,
  });

  // Keep the desktop window's frame in step with the appearance preference.
  $effect(() => {
    if (desktopApp()) void setNativeTitleBar(appearance.nativeTitleBar === true).catch(() => {});
  });

  onMount(() => {
    applyAppearance(appearance);
    void audio.load();
    void shortcuts.load();
    void restoreIdentityMode();
    void preferences.local.bulkGet(["rail", "channel"])
      .then(([rail, channel]) => {
        if (typeof rail?.value === "number") savedRailWidth = Math.max(180, Math.min(340, rail.value));
        if (typeof channel?.value === "number") savedChannelWidth = Math.max(222, Math.min(500, channel.value));
      }).catch((error) => { actionError = messageFrom(error); });
    if (!desktopApp()) {
      resolveRestored();
      const stop = browserSessions.watch(applyView);
      return () => { stop(); audio.dispose(); setIdentity(); };
    }
    let mounted = true;
    let unlisten: (() => void) | undefined;
    let stopMedia: (() => void) | undefined;
    void watchDesktop<DesktopMediaEvent>("korero:media", (event) => desktopVoice.event(event)).then((stop) => {
      if (mounted) stopMedia = stop;
      else stop();
    }).catch((error) => { if (mounted) actionError = messageFrom(error); });
    watchDesktopSession((state) => {
      if (mounted) applyView(state.origin, { ...offline, ...state });
    }).then(async (stop) => {
      if (!mounted) return stop();
      unlisten = stop;
      await audio.load();
      const sessions = await call<(DesktopSessionState & { origin: string })[]>("voice_state");
      if (!mounted) return;
      for (const state of sessions) {
        if (connections.has(state.origin)) continue;
        setConnection(state.origin, {});
        applyView(state.origin, { ...offline, ...state }, false);
        serverOrigin ||= state.origin;
        void getServerInfo(state.origin).then(async (info) => {
          setConnection(state.origin, { info }, false);
          const memberVolumes = await getMemberVolumes(info.serverId).catch(() => ({}));
          if (connections.has(state.origin)) desktopVoice.setVolumes(state.origin, memberVolumes);
          setConnection(state.origin, { memberVolumes }, false);
        }).catch(() => {});
      }
    }).catch((error: unknown) => {
      if (mounted) actionError = messageFrom(error);
    }).finally(resolveRestored);
    return () => {
      mounted = false;
      unlisten?.();
      stopMedia?.();
      audio.dispose();
      setIdentity();
    };
  });

  async function restoreIdentityMode() {
    try {
      const hosted = await HostedAccount.restore();
      if (hosted) {
        useHostedIdentity(hosted, false);
        const { account, data } = hosted;
        const legacy = data.serverPasswords === undefined ? await getLocalBookmarkPasswords(data.servers).catch(() => []) : [];
        try {
          await updateAccount(account, (current) => {
            if (!legacy.length || current.serverPasswords !== undefined) return current;
            const origins = new Set(current.servers.map(({ origin }) => origin));
            return { ...current, serverPasswords: legacy.filter(({ origin }) => origins.has(origin)) };
          });
        } catch {
          if (hostedAccount === account && data.serverPasswords === undefined) bookmarkPasswords = legacy;
        }
        if (hostedAccount === account) void connectSaved();
        return;
      }
      if (localStorage.getItem(identityModeKey) === "local") {
        const profile = await readLocalIdentity();
        if (profile) return useLocalIdentity(profile);
      }
    } catch (error) { actionError = messageFrom(error); }
    setup = "hosted";
  }

  function useLocalIdentity(profile: LocalProfile) {
    setIdentity(profile.identity);
    username = profile.username;
    savedServers = profile.servers;
    setup = null;
    rememberIdentityMode("local");
    void connectSaved();
  }

  async function continueLocally() {
    const profile = await readLocalIdentity();
    if (profile) useLocalIdentity(profile);
    else setup = "local";
  }

  async function transferIdentity(provider: string, name: string, password: string) {
    await profileUpdate;
    if (hostedAccount) return hostedAccount.transfer(provider, name, password);
    const profile = await readLocalIdentity();
    if (!profile) throw new Error("The local identity could not be loaded.");
    return HostedAccount.open(provider, name, password, {
      privateKey: async () => profile.identity.privateKey,
      servers: profile.servers,
      serverPasswords: await getLocalBookmarkPasswords(profile.servers),
      appearance: deviceAppearance,
    });
  }

  function applyAccountPreferences(data: AccountPreferences) {
    savedServers = data.servers;
    bookmarkPasswords = data.serverPasswords ?? [];
    const next = data.appearance ?? deviceAppearance;
    if (JSON.stringify(appearance) !== JSON.stringify(next)) {
      appearance = next;
      applyAppearance(next);
    }
  }

  function useHostedIdentity({ account, identity, data }: Awaited<ReturnType<typeof HostedAccount.open>>, connect = true) {
    setIdentity(identity);
    username = account.username;
    hostedAccount = account;
    applyAccountPreferences(data);
    setup = null;
    rememberIdentityMode("hosted");
    if (connect) void connectSaved();
  }

  async function signOut() {
    const account = hostedAccount;
    if (!account || connectBusy || pending || removing) return false;
    if (!await runAction("disconnect", disconnectAll)) return false;
    return runAction("sign-out", async () => {
      await account.signOut();
      setIdentity();
      username = "";
      savedServers = [];
      bookmarkPasswords = [];
      hostedAccount = undefined;
      appearance = deviceAppearance;
      applyAppearance(appearance);
      resetConnect("");
      connectOpen = false;
      setup = "hosted";
    });
  }

  function queueProfileUpdate(work: () => Promise<void>) {
    const next = profileUpdate.then(work);
    profileUpdate = next.catch(() => {});
    return next;
  }

  function updateAccount(account: HostedAccount, edit: (data: AccountPreferences) => AccountPreferences) {
    return queueProfileUpdate(async () => {
      if (hostedAccount !== account) return;
      const data = await account.updatePreferences(edit);
      if (hostedAccount === account) applyAccountPreferences(data);
    });
  }

  function refreshHostedAccount() {
    const account = hostedAccount;
    if (account) void updateAccount(account, (data) => data).catch(() => {});
  }

  async function updateAppearance(edit: (appearance: Appearance) => Appearance) {
    const account = hostedAccount;
    if (account) {
      await updateAccount(account, (data) => ({ ...data, appearance: edit(data.appearance ?? deviceAppearance) }));
      return true;
    }
    deviceAppearance = edit(deviceAppearance);
    appearance = deviceAppearance;
    return saveAppearance(appearance);
  }

  function updateSavedServers(edit: (servers: SavedServer[]) => SavedServer[], password?: BookmarkPassword) {
    const account = hostedAccount;
    if (account) return updateAccount(account, (data) => {
      const servers = edit(data.servers);
      const origins = new Set(servers.map(({ origin }) => origin));
      const serverPasswords = data.serverPasswords?.filter(({ origin }) => origins.has(origin) && origin !== password?.origin);
      if (password) return { ...data, servers, serverPasswords: [...serverPasswords ?? [], password] };
      return { ...data, servers, serverPasswords };
    });
    return queueProfileUpdate(async () => {
      if (hostedAccount) return;
      const servers = await preferences.transaction("rw", preferences.servers, async () => {
        const previous = await preferences.servers.toArray();
        const entries = edit(previous);
        const origins = new Set(entries.map(({ origin }) => origin));
        await preferences.servers.bulkDelete(previous.filter(({ origin }) => !origins.has(origin)).map(({ origin }) => origin));
        await preferences.servers.bulkPut(entries);
        return entries;
      });
      if (!hostedAccount) savedServers = servers;
    });
  }

  /** Adds or updates a connection. `create` is false for late updates that must not revive a removed server. */
  function setConnection(origin: string, patch: Partial<ServerConnection>, create = true) {
    const current = connections.get(origin);
    if (!current && !create) return;
    const next = new Map(connections);
    next.set(origin, { origin, info: null, view: offline, unread: new Map(), memberVolumes: {}, attention: "", ...current, ...patch });
    connections = next;
  }

  function removeConnection(origin: string) {
    if (!connections.has(origin)) return;
    desktopVoice.leave(origin);
    const next = new Map(connections);
    next.delete(origin);
    connections = next;
  }

  function serverName(origin: string) {
    return connections.get(origin)?.info?.name ?? savedServers.find((entry) => entry.origin === origin)?.name ?? shortHost(origin);
  }

  function applyView(origin: string | undefined, state: VoiceState, notify = true) {
    // The desktop service reports a crash without an origin. It affects every server.
    if (!origin) {
      for (const key of connections.keys()) applyView(key, state, notify);
      return;
    }
    const entry = connections.get(origin);
    if (!entry) return;
    const previous = entry.view;
    const channel = state.snapshot?.channelId;
    if (origin === serverOrigin && channel && channel !== previous.snapshot?.channelId) selectedChannelId = channel;
    if (notify) {
      announceOwnChanges(previous, state);
      announceRoomChanges(previous.snapshot, state.snapshot);
    }
    if (notify && state.lastPoke && state.lastPoke.id !== previous.lastPoke?.id) {
      poke = { ...state.lastPoke, origin };
      playUiSound("poke");
    }
    let unread = entry.unread;
    if (state.directMessages?.at(-1)?.id !== previous.directMessages?.at(-1)?.id) {
      const seen = new Set(previous.directMessages?.map(({ id }) => id));
      const incoming = state.directMessages?.filter((message) =>
        message.recipientId === state.snapshot?.account.id && !seen.has(message.id)) ?? [];
      if (incoming.length) {
        if (notify) playUiSound("directMessage");
        const next = new Map(unread);
        const viewingDirect = origin === serverOrigin && onWorkspace && roomView === "directMessages" &&
          (mobilePane === "room" || viewport > 760);
        for (const message of incoming) {
          if (viewingDirect && directAccountId === message.senderId) continue;
          next.set(message.senderId, (next.get(message.senderId) ?? 0) + 1);
        }
        unread = next;
      }
    }
    const roomChanged = previous.snapshot?.channelId !== channel || previous.snapshot?.connectionId !== state.snapshot?.connectionId;
    const view = desktopApp() ? { ...state, ...desktopVoice.update(origin, state, entry.memberVolumes, roomChanged) } : state;
    setConnection(origin, { view, unread }, false);
    if (state.directChange && state.snapshot) {
      for (const receive of directChangeListeners) receive(origin, state.snapshot.connectionId, state.directChange);
    }
    updateTalkContext();
  }

  /**
   * Cues joining, switching and leaving channels and losing the server from the snapshot, so a
   * move, kick or ban by an admin sounds the same as doing it yourself. Leaving another server's
   * channel to join one here stays silent.
   */
  function announceOwnChanges(before: VoiceState, after: VoiceState) {
    if (before.phase === "online" && after.phase !== "online") {
      playUiSound("disconnect");
      return;
    }
    const was = before.snapshot;
    const now = after.snapshot;
    if (!was || !now || was.connectionId !== now.connectionId || was.channelId === now.channelId) return;
    if (now.channelId) playUiSound("channel");
    else if (pending !== "join") playUiSound("disconnect");
  }

  /**
   * Cues screen share, camera activity and members leaving the channel. Shares that were already
   * live on joining stay silent, as does anything announced while switching channels.
   */
  function announceRoomChanges(before: VoiceState["snapshot"], after: VoiceState["snapshot"]) {
    if (!before || !after || before.channelId !== after.channelId || before.connectionId !== after.connectionId) return;
    const producers = (snapshot: VoiceState["snapshot"], source: "screens" | "cameras") =>
      new Set((snapshot?.[source] ?? []).map(({ producerId }) => producerId));
    const was = { screens: producers(before, "screens"), cameras: producers(before, "cameras") };
    const now = { screens: producers(after, "screens"), cameras: producers(after, "cameras") };
    const appeared = (source: "screens" | "cameras") => [...now[source]].some((id) => !was[source].has(id));
    const disappeared = (source: "screens" | "cameras") => [...was[source]].some((id) => !now[source].has(id));
    if (appeared("screens")) playUiSound("screenShareStart");
    else if (appeared("cameras")) playUiSound("cameraStart");
    if (disappeared("screens")) playUiSound("screenShareStop");
    else if (disappeared("cameras")) playUiSound("cameraStop");
    const present = new Set(after.members.map(({ connectionId }) => connectionId));
    if (before.members.some(({ connectionId }) => connectionId !== after.connectionId && !present.has(connectionId))) playUiSound("memberLeft");
  }

  function updateDesktopVoice(origin: string) {
    const view = connections.get(origin)?.view;
    if (!view) return;
    setConnection(origin, { view: { ...view, ...desktopVoice.status(origin) } }, false);
    updateTalkContext();
  }

  // Push-to-talk follows the server with the active voice channel, which may be in the background.
  function updateTalkContext() {
    const state = [...connections.values()].map((entry) => entry.view).find((entry) => entry.voice === "active" && entry.snapshot?.channelId);
    const channel = state?.snapshot?.channelId;
    const connection = state?.snapshot?.connectionId;
    const member = state?.snapshot?.members.find(({ connectionId }) => connectionId === connection);
    audio.setTalkContext(state?.phase === "online" && state.voice === "active" && !state.whisperChannelId && connection && channel && member &&
      !member.muted && !member.adminMuted && !member.deafened && !member.adminDeafened && !member.afk
      ? { channelId: channel, connectionId: connection } : undefined);
  }

  function focusServer(origin: string) {
    if (origin !== serverOrigin) {
      roomView = "chat";
      directAccountId = null;
      pokeTarget = null;
      connectionInfo = null;
      selectedChannelId = connections.get(origin)?.view.snapshot?.channelId ?? null;
      serverOrigin = origin;
    }
    if (origin) void preferences.local.put({ key: focusKey, value: origin }).catch(() => {});
  }

  /** Connects to every saved server that allows auto-connect and is not already connected. */
  async function connectSaved() {
    await restored;
    if (!identityReady) return;
    if (!serverOrigin) {
      const preferred = await preferences.local.get(focusKey).then((entry) => entry?.value).catch(() => undefined);
      const entry = savedServers.find(({ origin }) => origin === preferred) ?? savedServers.find((saved) => saved.autoConnect !== false) ?? savedServers[0];
      if (entry && !serverOrigin) serverOrigin = entry.origin;
    }
    await Promise.all(savedServers.filter((entry) => entry.autoConnect !== false).map(({ origin }) => autoConnect(origin)));
  }

  /**
   * Signs in without prompting. A server that needs a certificate decision, password or
   * enrollment keeps an `attention` message, and selecting it runs the interactive flow.
   */
  async function autoConnect(origin: string) {
    if (connections.has(origin)) return;
    setConnection(origin, { view: { ...offline, phase: "connecting" } });
    try {
      if (certificateApproval()) {
        const contact = await inspectServer(origin);
        const previous = (await preferences.trust.get(contact.origin))?.fingerprint;
        if (contact.origin !== origin || !(previous === contact.fingerprint || (!previous && contact.publiclyTrusted))) {
          throw new Error("Check this server's certificate to connect.");
        }
        if (!connections.has(origin)) return;
        await trustServer(origin, previous ?? null);
      }
      if (!desktopApp()) await browserSessions.select(origin);
      const info = await getServerInfo(origin);
      setConnection(origin, { info }, false);
      if (!info.identityAuthentication || !info.identityEnrollment || info.setupRequired) {
        throw new Error("Open this server to finish connecting.");
      }
      const password = info.passwordRequired ? await getBookmarkPassword(origin, info.serverId) : undefined;
      if (!connections.has(origin)) return;
      const login = await authenticateIdentity(origin, info.serverId, deviceName, { operation: "login", password });
      if (login.status === 401 && info.passwordRequired && !password) throw new Error("Enter the server password to connect.");
      if (login.status !== 200) throw identityError(login);
      if (!connections.has(origin)) return;
      await beginSession(origin, info);
    } catch (error) {
      const message = messageFrom(error);
      setConnection(origin, { attention: message, view: { ...offline, phase: "error", error: message } }, false);
    }
  }

  async function beginSession(origin: string, info: ServerInfo) {
    await audio.load();
    const volumes = await getMemberVolumes(info.serverId).catch(() => ({}));
    setConnection(origin, { info, memberVolumes: volumes, attention: "",
      view: { ...(connections.get(origin)?.view ?? offline), phase: "connecting", error: null } });
    await startSession(origin, volumes);
  }

  function openWorkspace(pane: MobilePane) {
    mobilePane = pane;
    if (!onWorkspace) void goto(resolve("/"));
  }

  function resetConnect(address: string) {
    discoverAddress = address;
    discovery = null;
    trustPrompt = null;
    connectError = "";
    accessPrompt = false;
    invitationRequired = false;
    setupToken = "";
    serverCode = "";
    serverPassword = "";
    savedServerPassword = undefined;
    remembered = true;
    bookmarkOrigin = "";
  }

  function showConnect(address = "") {
    if (!identityReady || connectBusy || pending) return;
    resetConnect(address);
    connectOpen = true;
  }

  /** A live server becomes the focus. Otherwise this runs the interactive connect flow. */
  function selectServer(origin: string) {
    if (!identityReady || connectBusy || pending) return;
    if (isLive(origin)) {
      focusServer(origin);
      openWorkspace("channels");
      return;
    }
    selectBookmark(origin);
  }

  function isLive(origin: string) {
    const entry = connections.get(origin);
    return Boolean(entry && !entry.attention && ["online", "connecting", "reconnecting"].includes(entry.view.phase));
  }

  function selectBookmark(origin: string) {
    if (!identityReady || connectBusy || pending) return;
    resetConnect(origin);
    bookmarkOrigin = origin;
    void discoverServer();
  }

  async function loadServer(contact: CertificateContact, fingerprint: string | null, rememberTrust = false) {
    const origin = await trustServer(contact.origin, fingerprint);
    if (!desktopApp()) await browserSessions.select(origin);
    if (rememberTrust) await preferences.trust.put({ origin, fingerprint: contact.fingerprint });
    await discoverServerInfo(origin);
  }

  async function discoverServerInfo(origin: string) {
    const target = { origin, info: await getServerInfo(origin) };
    discovery = target;
    if (!target.info.identityAuthentication || !target.info.identityEnrollment) {
      throw new Error("Update this server to a Korero.chat version that supports identity sign-in.");
    }
    if (target.info.passwordRequired) {
      savedServerPassword = await getBookmarkPassword(origin, target.info.serverId);
    }
    if (target.info.setupRequired) {
      accessPrompt = true;
      connectOpen = true;
      return;
    }
    await signIn(target);
  }

  async function getServerInfo(origin: string): Promise<ServerInfo> {
    const result = await apiFor(origin).server.info.get();
    if (result.error) throw requestError(result.error);
    if (!result.data || !("serverId" in result.data)) throw new Error("This server did not return Korero.chat server details.");
    return result.data;
  }

  async function getBookmarkPassword(origin: string, serverId: string) {
    if (hostedAccount) return bookmarkPasswords.find((entry) => entry.origin === origin && entry.serverId === serverId)?.password;
    return getSavedPassword(origin, serverId).catch(() => undefined);
  }

  function promptServerPassword(target: Target, rejectedPassword?: string) {
    if (rejectedPassword && rejectedPassword === savedServerPassword) {
      savedServerPassword = undefined;
      const { origin, info: { serverId } } = target;
      const account = hostedAccount;
      const forget = account ? updateAccount(account, (data) => ({
        ...data,
        serverPasswords: data.serverPasswords?.filter((entry) =>
          entry.origin !== origin || entry.serverId !== serverId || entry.password !== rejectedPassword),
      })) : forgetPassword(origin, serverId, "", rejectedPassword);
      void forget.catch(() => {});
    }
    accessPrompt = true;
    connectOpen = true;
  }

  async function loginIdentity(target: Target) {
    const password = target.info.passwordRequired ? serverPassword || savedServerPassword : undefined;
    const login = await authenticateIdentity(target.origin, target.info.serverId, deviceName, { operation: "login", password });
    if (login.status === 200) await finishConnection(target, password);
    else if (login.status === 401 && target.info.passwordRequired) {
      serverCode = "";
      invitationRequired = false;
      promptServerPassword(target, password);
      if (!password) throw new Error("Enter the server password to connect.");
      throw identityError(login);
    }
    return login;
  }

  async function signIn(target: Target) {
    const login = await loginIdentity(target);
    if (login.status === 200) return;
    if (login.status !== 404) throw identityError(login);
    if (target.info.registration === "disabled") {
      throw new Error("This server has closed registration for new identities.");
    }
    const needsInvitation = target.info.registration !== "open" && !serverCode.trim();
    if (needsInvitation || (needsPassword && !serverPassword)) {
      invitationRequired ||= needsInvitation;
      accessPrompt = true;
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
      if (!certificateApproval()) {
        const origin = browserServerOrigin(address);
        if (focusLive(origin)) return;
        await browserSessions.select(origin);
        await discoverServerInfo(origin);
        return;
      }
      const contact = await inspectServer(address);
      if (focusLive(contact.origin)) return;
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

  // Entering the address of a server that is already connected shows it.
  function focusLive(origin: string) {
    if (!isLive(origin)) return false;
    focusServer(origin);
    connectOpen = false;
    openWorkspace("channels");
    return true;
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
    const bootstrap = claimOwnership;
    const password = target.info.passwordRequired && (bootstrap || !code || !target.info.invitationPasswordBypass)
      ? serverPassword || savedServerPassword : undefined;
    if (!bootstrap && target.info.registration === "disabled") {
      throw new Error("This server has closed registration for new identities.");
    }
    const result = await authenticateIdentity(target.origin, target.info.serverId, deviceName,
      bootstrap
        ? { operation: "bootstrap", displayName: username, token: setupToken.trim(), password }
        : { operation: "register", displayName: username, invitation: code || undefined, password });
    if (bootstrap && result.status === 404) {
      const response = await apiFor(target.origin).server.info.get();
      if (!response.error && response.data && "serverId" in response.data && !response.data.setupRequired) {
        const updated = { ...target, info: response.data };
        setupToken = "";
        discovery = updated;
        await signIn(updated);
        return;
      }
    }
    if (!bootstrap && result.status === 409) {
      const login = await loginIdentity(target);
      if (login.status === 200) return;
    }
    if (bootstrap && result.status === 401 && target.info.passwordRequired) {
      promptServerPassword(target, password);
      throw new Error("Check the server setup token and server password, then try again.");
    }
    if (!bootstrap && result.status === 401) {
      if (code && !needsPassword) throw new Error("This invitation is invalid, expired, or out of uses.");
      if (!code && target.info.passwordRequired) promptServerPassword(target, password);
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
    await finishConnection(target, password);
  }

  async function finishConnection(target: Target, password?: string) {
    focusServer(target.origin);
    try {
      await beginSession(target.origin, target.info);
    } catch (error) {
      actionError = messageFrom(error);
    }
    if (connections.get(target.origin)?.view.phase === "online") playUiSound("connect");
    if (!hostedAccount && password && password !== savedServerPassword) {
      await savePassword(target.origin, target.info.serverId, password).catch(() => {
        actionError = "This device could not save the server password.";
      });
    }
    if (remembered) {
      const previous = savedServers.find(({ origin }) => origin === target.origin);
      const entry: SavedServer = { name: target.info.name, origin: target.origin, passwordRequired: target.info.passwordRequired };
      if (previous?.autoConnect === false) entry.autoConnect = false;
      const credential = password && password !== savedServerPassword
        ? { origin: entry.origin, serverId: target.info.serverId, password }
        : undefined;
      try {
        await updateSavedServers((servers) => [entry, ...servers.filter(({ origin }) => origin !== entry.origin)], credential);
      } catch (error) { actionError = messageFrom(error); }
    }
    connectOpen = false;
    openWorkspace("channels");
    connectError = "";
    discoverAddress = target.origin;
    serverCode = "";
    setupToken = "";
    serverPassword = "";
    savedServerPassword = undefined;
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

  /** Runs a session command on the focused server. */
  function run(action: string, command: string, args?: Record<string, unknown>) {
    return runFor(serverOrigin, action, command, args);
  }

  function canSetVoicePresence(field: VoicePresence) {
    if (!voiceAvailable || pending || !voiceSnapshot?.channels.some(({ id }) => id === voiceSnapshot.channelId) || !ownVoiceMember) return false;
    if (field === "afk") return ownVoiceMember.afk !== undefined;
    return !ownVoiceMember.afk && (field === "muted" ? !ownVoiceMember.adminMuted : !ownVoiceMember.adminDeafened);
  }

  async function setVoicePresence(field: VoicePresence, value?: boolean, afkMessage?: string) {
    if (!voiceConnection || !ownVoiceMember || !canSetVoicePresence(field)) return false;
    const current = ownVoiceMember[field];
    const next = value ?? !current;
    if (next === current && afkMessage === undefined) return true;
    const [action, sound] = field === "muted" ? ["mute", next ? "mute" : "unmute"] as const
      : field === "deafened" ? ["deafen", next ? "deafen" : "undeafen"] as const
      : ["afk", next ? "afk" : "back"] as const;
    const args = field === "afk" ? { afk: next, afkMessage: afkMessage ?? "" } : { [field]: next };
    const success = await runFor(voiceConnection.origin, action, "set_presence", args);
    if (success && current !== next) playUiSound(sound);
    return success;
  }

  $effect(() => callPip.watch((active) => { pictureInPicture = active; }, (action) => {
    if (action === "leave") void leaveVoice();
    else void setVoicePresence(action === "mute" ? "muted" : "deafened");
  }));

  $effect(() => {
    const member = voiceAvailable && voiceConnection ? ownVoiceMember : undefined;
    void callPip.update(member ? {
      active: true,
      muted: member.muted || member.adminMuted,
      deafened: Boolean(member.deafened || member.adminDeafened),
      canMute: canSetVoicePresence("muted"),
      canDeafen: canSetVoicePresence("deafened"),
    } : { active: false });
  });

  async function leaveVoice() {
    if (!voiceConnection) return;
    await runFor(voiceConnection.origin, "leave", "leave_channel");
  }

  function handleShortcut(event: KeyboardEvent) {
    audio.talkKeyDown(event);
    const action = shortcuts.matchVoiceAction(event);
    if (!action || !canSetVoicePresence(action.field)) return;
    event.preventDefault();
    void setVoicePresence(action.field, action.value);
  }

  /** Runs a session command on a specific server connection. */
  function runFor(origin: string, action: string, command: string, args?: Record<string, unknown>) {
    return runAction(action, () => {
      if (!origin) throw new Error("Connect to a server first.");
      if (desktopApp()) return call(command, { ...args, origin });
      if (command === "join_channel") return browserSessions.joinChannel(origin, args?.channelId as string, (args?.password as string | null) ?? undefined);
      const session = browserSessions.session(origin);
      if (command === "save_channel") return session.saveChannel(args?.payload as Record<string, unknown>);
      if (command === "delete_channel") return session.deleteChannel(args?.channelId as string);
      if (command === "leave_channel") return session.leaveChannel();
      if (command === "set_presence") return session.setPresence(args);
      if (command === "send_message") return session.channel(args?.channelId as string).send({ text: args?.text as string, html: args?.html as string | undefined });
      if (command === "edit_message") return session.editMessage(args?.messageId as string, args?.text as string);
      if (command === "delete_message") return session.deleteMessage(args?.messageId as string);
      if (command === "pin_message") return session.setMessagePin(args?.channelId as string, args?.messageId as string, args?.pinned === true);
      throw new Error("Open Korero.chat in the desktop app to use voice.");
    });
  }

  function reorderChannel(channelId: string, targetId: string, placement: ChannelPlacement, parentId?: string | null) {
    return runAction("channel-order", async () => {
      const response = await apiFor(serverOrigin).channels.order.patch({ channelId, targetId, placement, parentId });
      if (response.error) throw requestError(response.error);
    });
  }

  function memberAction(request: MemberRequest) {
    const origin = serverOrigin;
    return runAction(request.kind, () => desktopApp() ? call("member_action", { ...request, origin })
      : browserSessions.session(origin).memberAction(request));
  }

  function setMemberVolume(accountId: string, level: number) {
    const origin = serverOrigin;
    const serverId = serverInfo?.serverId;
    const isCurrentServer = () => serverOrigin === origin && serverInfo?.serverId === serverId;
    memberVolumeUpdate = memberVolumeUpdate.then(async () => {
      if (!isCurrentServer() || view.phase !== "online" || pending === "disconnect") return false;
      actionError = "";
      try {
        if (!desktopApp()) browserSessions.session(origin).setMemberVolume(accountId, level);
        if (!isCurrentServer()) return false;
        const next = { ...memberVolumes };
        if (level === defaultMemberVolume) delete next[accountId];
        else next[accountId] = level;
        desktopVoice.setVolumes(origin, next);
        setConnection(origin, { memberVolumes: next }, false);
        if (serverId) await saveMemberVolumes(serverId, next);
        return true;
      } catch (error) {
        if (isCurrentServer()) actionError = messageFrom(error);
        return false;
      }
    });
    return memberVolumeUpdate;
  }

  async function disconnect(origin = serverOrigin) {
    if (connectBusy || !origin) return false;
    if (!await runAction("disconnect", () => disconnectServer(origin))) return false;
    playUiSound("disconnect");
    return true;
  }

  async function disconnectServer(origin: string) {
    removeConnection(origin);
    if (origin === serverOrigin) {
      const next = [...connections.keys()].find(isLive) ?? "";
      focusServer(next);
      openWorkspace("room");
    }
    updateTalkContext();
    if (desktopApp()) await call("disconnect", { origin });
    else await browserSessions.disconnect(origin);
  }

  async function disconnectAll() {
    await Promise.all([...connections.keys()].map(disconnectServer));
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

  function showDirectMessages(accountId?: string) {
    if (!online || !view.snapshot?.directMessages || !serverInfo?.serverId) return;
    directAccountId = accountId ?? null;
    if (accountId && unreadDirectCounts.has(accountId)) {
      const unread = new Map(unreadDirectCounts);
      unread.delete(accountId);
      setConnection(serverOrigin, { unread }, false);
    }
    roomView = "directMessages";
    openWorkspace("room");
  }

  function showPoke({ accountId, displayName }: Pick<Member, "accountId" | "displayName">) {
    const snapshot = view.snapshot;
    if (!online || !snapshot?.pokeMaxLength || !snapshot.directMessages?.canSend || sendingPoke) return;
    pokeDraft = "";
    pokeError = "";
    pokeTarget = { accountId, displayName, viewerId: snapshot.connectionId };
  }

  async function sendPoke(event: SubmitEvent) {
    event.preventDefault();
    const target = pokeTarget;
    if (!target || sendingPoke) return;
    sendingPoke = true;
    pokeError = "";
    try {
      await directRequest(target.viewerId, "direct.poke", { accountId: target.accountId, message: pokeDraft.trim() || undefined });
      pokeTarget = null;
    } catch (error) {
      pokeError = messageFrom(error);
    } finally {
      sendingPoke = false;
    }
  }

  function replyToPoke() {
    if (!poke || connections.get(poke.origin)?.view.phase !== "online") return;
    focusServer(poke.origin);
    showDirectMessages(poke.senderId);
    poke = null;
  }

  function showConnectionInfo(connectionId: string) {
    if (!online || !serverOrigin || !view.snapshot) return;
    connectionInfo = { origin: serverOrigin, viewerId: view.snapshot.connectionId, connectionId };
  }

  function serverActions(entry: SavedServer) {
    const actions = [];
    if (entry.origin === serverOrigin && online && view.snapshot) {
      const { connectionId } = view.snapshot;
      actions.push({ label: "Connection info", onSelect: () => showConnectionInfo(connectionId) });
      if (canAdminister) actions.push({ label: "Server settings", onSelect: showServerSettings });
    }
    const saved = savedServers.find(({ origin }) => origin === entry.origin);
    if (!saved) return actions;
    const autoConnect = saved.autoConnect !== false;
    actions.push({ label: autoConnect ? "Disable auto-connect" : "Enable auto-connect", onSelect: () => setAutoConnect(entry.origin, !autoConnect) });
    actions.push({ label: "Remove server", onSelect: () => {
      removingServer = entry;
      removeError = "";
      removeServerOpen = true;
    } });
    return actions;
  }

  function setAutoConnect(origin: string, enabled: boolean) {
    void updateSavedServers((servers) => servers.map((server) => {
      if (server.origin !== origin) return server;
      const { autoConnect: _, ...rest } = server;
      return enabled ? rest : { ...rest, autoConnect: false };
    })).catch((error) => { actionError = messageFrom(error); });
  }

  async function removeServer() {
    if (!removingServer || removing || pending || connectBusy) return;
    const { origin } = removingServer;
    removing = true;
    removeError = "";
    try {
      if (connections.has(origin) && !await disconnect(origin)) throw new Error(actionError || "Could not disconnect from the server.");
      await updateSavedServers((servers) => servers.filter((server) => server.origin !== origin));
      if (!hostedAccount) await preferences.passwords.where("origin").equals(origin).delete();
      removeServerOpen = false;
    } catch (error) {
      removeError = messageFrom(error);
    } finally {
      removing = false;
    }
  }
</script>

<svelte:head>
  <title>Korero.chat</title>
</svelte:head>

<svelte:window bind:innerWidth={viewport} onkeydown={handleShortcut} onkeyup={audio.talkKeyUp} onblur={audio.talkWindowBlur}
  onfocus={refreshHostedAccount} />

{#if import.meta.env.DEV && !(pictureInPicture && voiceConnection)}
  <div class="dev-banner" role="note">Development build — not for production use</div>
{/if}

{#if pictureInPicture && voiceConnection}
  <CallPictureInPicture origin={voiceConnection.origin} view={voiceConnection.view} />
{/if}

{#if desktopApp() && framelessDesktopWindow() && !appearance.nativeTitleBar && !(pictureInPicture && Boolean(voiceConnection))}
  <WindowTitleBar />
{/if}

<div class="shell" hidden={pictureInPicture && Boolean(voiceConnection)} data-pane={onWorkspace ? mobilePane : "room"} data-workspace={onWorkspace} data-mobile-voice={mobileVoice}
  style:--rail-width={railWidth + "px"} style:--channel-width={channelWidth + "px"}
  {@attach viewport <= 760 ? swipePanes : undefined}>
  <ServerRail servers={railServers} {identityReady} {connectBusy} {pending} {username} {me} {online} {status}
    onconnect={() => showConnect()} onselect={selectServer} ondisconnect={(origin) => { void disconnect(origin); }} />
  <PaneDivider label="Resize server sidebar" controls="server-rail" value={railWidth} min={180} max={railMax} resize={(value, commit) => resizePane("rail", value, commit)} />


  {@render children()}
  {#if desktopApp()}<CapturePicker />{/if}
  {#if online && view.snapshot?.channelId}
    {#key view.snapshot.connectionId + "/" + view.snapshot.channelId}
      <ScreenSharing snapshot={view.snapshot} controlsTarget={screenShareControlsTarget}
        inlineTarget={screenShareViewerTarget} visible={Boolean(screenShareViewerTarget)} />
    {/key}
  {/if}

  {#if mobileVoice}
    <div class="mobile-voice">
      <VoiceToolbar onleave={voiceConnection ? leaveVoice : undefined} />
    </div>
  {/if}
  <nav class="mobile-nav" aria-label="Workspace navigation">
    <button aria-current={onWorkspace && mobilePane === "servers" ? "page" : undefined} onclick={() => openWorkspace("servers")}><Server size={18} /> Servers</button>
    <button aria-current={onWorkspace && mobilePane === "channels" ? "page" : undefined} onclick={() => openWorkspace("channels")}><ListTree size={18} /> Channels</button>
    <button aria-current={onWorkspace && mobilePane === "room" && roomView === "chat" ? "page" : undefined} onclick={showChat}><AudioLines size={18} /> Chat</button>
    <a href={resolve("/settings")} aria-current={!onWorkspace ? "page" : undefined}><Settings2 size={18} /> Settings</a>
  </nav>
</div>

<div class="sr-only" role="status">
  {#if poke}{poke.senderName} poked you. {poke.message}{/if}
</div>
{#if poke}
  <div class="fixed inset-x-3 top-[max(0.75rem,var(--safe-area-inset-top))] z-50 mx-auto flex max-w-md items-start gap-1 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg">
    <button type="button" class="flex min-w-0 flex-1 items-start gap-3 rounded-md p-2 text-left hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
      onclick={replyToPoke}>
      <BellRing size={20} class="mt-0.5 shrink-0 text-(--info)" aria-hidden="true" />
      <span class="min-w-0 flex-1 wrap-anywhere">
        <strong class="block text-sm">{poke.senderName} poked you</strong>
        {#if connections.size > 1}<span class="block text-xs text-muted-foreground">{serverName(poke.origin)}</span>{/if}
        {#if poke.message}<span class="block text-sm">{poke.message}</span>{/if}
        <span class="block text-xs text-muted-foreground">Reply in direct messages</span>
      </span>
    </button>
    <IconButton label="Dismiss poke" onclick={() => { poke = null; }}><X size={16} aria-hidden="true" /></IconButton>
  </div>
{/if}

{#if pokeTarget}
  <Modal bind:open={() => true, (open) => { if (!open) pokeTarget = null; }}
    title={`Poke ${pokeTarget.displayName}`} description="Send a sound and a pop-up to get their attention." dismissible={!sendingPoke}>
    {#snippet icon()}<BellRing size={21} aria-hidden="true" />{/snippet}
    <form class="dialog-form" onsubmit={sendPoke}>
      <label>Message (optional)<Input autofocus maxlength={view.snapshot?.pokeMaxLength} bind:value={pokeDraft} /></label>
      {#if pokeError}<p class="form-error" role="alert">{pokeError}</p>{/if}
      <div class="dialog-actions">
        <Button type="button" variant="outline" disabled={sendingPoke} onclick={() => { pokeTarget = null; }}>Cancel</Button>
        <Button type="submit" disabled={sendingPoke}>{sendingPoke ? "Sending…" : "Send poke"}</Button>
      </div>
    </form>
  </Modal>
{/if}

{#if setup === "transfer"}
  <AccountSetup open={true} migration={{ username, origin: hostedAccount?.origin, submit: transferIdentity }}
    onlocal={async () => { setup = null; }} oncomplete={useHostedIdentity} />
{:else if setup === "hosted"}
  <AccountSetup open={true} onlocal={continueLocally} onlink={() => { setup = "link"; }} oncomplete={useHostedIdentity} />
{/if}
{#if setup === "local"}
  <LocalIdentitySetup open={true} onback={() => { setup = "hosted"; }} oncomplete={useLocalIdentity} />
{:else if setup === "link"}
  <DeviceLinkImport open={true} onback={() => { setup = "hosted"; }}
    oncomplete={(linked) => linked.kind === "local" ? useLocalIdentity(linked.profile) : useHostedIdentity(linked.result)} />
{/if}

<ConnectServerModal bind:open={connectOpen} {connectBusy} {connectError} {trustPrompt} {discovery} {accessPrompt}
  {needsPassword} {claimOwnership} {invitationRequired}
  bind:setupToken bind:serverPassword bind:serverCode bind:discoverAddress bind:remembered
  onapprove={approveTrust} onsubmitcode={submitServerCode} ondiscover={discover}
  onreset={() => resetConnect(discoverAddress)} onbacktrust={() => { trustPrompt = null; }} />

{#if connectionInfo && online && connectionInfo.origin === serverOrigin && connectionInfo.viewerId === view.snapshot?.connectionId}
  {#key connectionInfo}
    <Modal bind:open={() => true, (open) => { if (!open) connectionInfo = null; }}
      title="Connection info" description="Latency measures the round trip to the server.">
      <ConnectionInfo origin={connectionInfo.origin} connectionId={connectionInfo.connectionId} />
    </Modal>
  {/key}
{/if}

<Modal bind:open={removeServerOpen} title="Remove server?" description={removingServer?.name ?? "Remove this server from your list."} dismissible={!removing}>
  {#if removeError}<p class="form-error" role="alert">{removeError}</p>{/if}
  <div class="dialog-actions">
    <Button variant="outline" onclick={() => { removeServerOpen = false; }} disabled={removing}>Cancel</Button>
    <Button variant="default" onclick={removeServer} disabled={removing}>{removing ? "Removing…" : "Remove server"}</Button>
  </div>
</Modal>

{#snippet serverSettings()}
  {#if serverInfo}
    {#key serverOrigin}
      <ServerAdministration origin={serverOrigin} title={serverTitle} permissions={serverPermissions}
        extended={Boolean(serverInfo.extendedServerAdministration)}
        bannerSupported={serverInfo.bannerImageUrl !== undefined} {bannerImageUrl} onclose={showChat} />
    {/key}
  {/if}
{/snippet}
