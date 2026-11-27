<script lang="ts">
  import { playUiSound } from "#lib/ui-sounds";
  import { Button } from "#lib/components/ui/button/index.js";
  import Checkbox from "#lib/components/fields/LabeledCheckbox.svelte";
  import { Input } from "#lib/components/ui/input/index.js";
  import "../app.css";

  import { goto } from "$app/navigation";
  import { asset, resolve } from "$app/paths";
  import { page } from "$app/state";
  import { ArrowRight, AudioLines, BellRing, Bookmark, Cable, ListTree, LockKeyhole, Plus, Server, Settings2, X } from "@lucide/svelte";
  import { onMount } from "svelte";
  import { AudioSettings, setAudioSettings } from "#lib/media/audio.svelte";
  import PaneDivider from "#lib/components/PaneDivider.svelte";
  import { defaultMemberVolume, forgetPassword, getMemberVolumes, getSavedPassword, preferences, saveMemberVolumes, savePassword, type SavedServer } from "#lib/preferences";
  import Avatar from "#lib/components/Avatar.svelte";
  import ContextActions from "#lib/components/ContextActions.svelte";
  import AccountSetup from "#lib/components/AccountSetup.svelte";
  import LocalIdentitySetup from "#lib/components/LocalIdentitySetup.svelte";
  import IconButton from "#lib/components/IconButton.svelte";
  import Modal from "#lib/components/Modal.svelte";
  import ConnectionInfo from "#lib/components/server/ConnectionInfo.svelte";
  import ScreenSharing from "#lib/components/media/ScreenSharing.svelte";
  import ServerAdministration from "#lib/components/server/ServerAdministration.svelte";
  import {
    apiFor, call, directRequest, messageFrom, desktopApp, offline, requestError, shortHost, watchVoice,
    type Member, type MemberRequest, type Poke, type ServerInfo, type VoiceState,
  } from "#lib/connection/client";
  import { authenticateIdentity, getIdentity, identityError, setIdentity } from "#lib/identity/identity";
  import { HostedAccount } from "#lib/identity/hosted-account";
  import { identityModeKey, readLocalIdentity, rememberIdentityMode, type LocalProfile } from "#lib/identity/local-identity";
  import { createProfilePictureCache } from "#lib/identity/profile-picture";
  import { browserServerOrigin, browserSession } from "#lib/connection/browser-session";
  import { applyAppearance, readAppearance } from "#lib/theme";
  import { readChatDisplay, saveChatDisplay, setChatDisplay, type ChatDisplay } from "#lib/chat/chat-display";
  import { setWorkspace, type ChannelPlacement, type MobilePane, type RoomView } from "#lib/workspace";

  let { children } = $props();
  const audio = setAudioSettings(new AudioSettings());
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
  let savedServers = $state.raw<SavedServer[]>([]);
  let hostedAccount = $state.raw<HostedAccount>();
  let username = $state("");
  let identityReady = $derived(Boolean(username));
  let setup = $state<"hosted" | "local" | "transfer" | null>(null);
  let bookmarkUpdate = Promise.resolve();
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
  let savedServerPassword = $state<string>();
  let removingServer = $state.raw<SavedServer | null>(null);
  let removeServerOpen = $state(false);
  let removing = $state(false);
  let removeError = $state("");
  let remembered = $state(true);
  let pending = $state("");
  let memberVolumes = $state.raw<Record<string, number>>({});
  let memberVolumeUpdate = Promise.resolve(true);
  let actionError = $state("");
  let selectedChannelId = $state<string | null>(null);
  let mobilePane = $state<MobilePane>("room");
  let roomView = $state<RoomView>("chat");
  let screenShareViewerTarget = $state<HTMLElement>();
  let screenShareControlsTarget = $state<HTMLElement>();
  let directAccountId = $state<string | null>(null);
  let connectionInfo = $state.raw<{ origin: string; viewerId: string; connectionId: string } | null>(null);
  let unreadDirectCounts = $state.raw<ReadonlyMap<string, number>>(new Map());
  const unreadDirectCount = $derived([...unreadDirectCounts.values()].reduce((total, count) => total + count, 0));
  let poke = $state.raw<Poke | null>(null);
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
    signOut,
    get view() { return view; },
    get serverOrigin() { return serverOrigin; },
    get serverId() { return serverInfo?.serverId ?? ""; },
    get serverTitle() { return serverTitle; },
    get bannerImageUrl() { return bannerImageUrl; },
    get canAdminister() { return canAdminister; },
    get serverSettings() { return roomView === "serverSettings" && canAdminister ? serverSettings : undefined; },
    get channelBackgrounds() { return Boolean(serverInfo?.channelBackgrounds); },
    get profilePictures() { return serverInfo?.profilePictures === true; },
    avatarId(accountId) { return accountId === me?.id ? me.avatarId : avatarIds.get(accountId); },
    profilePicture: profilePictureCache,
    get maxAttachmentBytes() { return view.snapshot?.maxAttachmentBytes ?? serverInfo?.maxAttachmentBytes ?? 0; },
    get richChat() { return serverInfo?.richChat === true; },
    get maxWebSocketBytes() { return serverInfo?.maxWebSocketBytes; },
    get screenSharing() { return Boolean(serverInfo?.screenSharing); },
    get screenShareViewerTarget() { return screenShareViewerTarget; },
    set screenShareViewerTarget(value) { screenShareViewerTarget = value; },
    get screenShareControlsTarget() { return screenShareControlsTarget; },
    set screenShareControlsTarget(value) { screenShareControlsTarget = value; },
    get channelAudioQuality() { return Boolean(serverInfo?.channelAudioQuality); },
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
    get directAccountId() { return directAccountId; },
    get unreadDirectCounts() { return unreadDirectCounts; },
    get unreadDirectCount() { return unreadDirectCount; },
    showDirectMessages,
    showPoke,
    showConnectionInfo,
    showConnect,
    showServerSettings,
    run,
    runAction,
    memberAction,
    memberVolume(accountId) { return memberVolumes[accountId] ?? defaultMemberVolume; },
    setMemberVolume,
    reorderChannel,
    disconnect,
  });

  onMount(() => {
    applyAppearance(readAppearance());
    void audio.load();
    void restoreIdentityMode();
    void preferences.local.bulkGet(["rail", "channel"])
      .then(([rail, channel]) => {
        if (typeof rail?.value === "number") savedRailWidth = Math.max(180, Math.min(340, rail.value));
        if (typeof channel?.value === "number") savedChannelWidth = Math.max(222, Math.min(500, channel.value));
      }).catch((error) => { actionError = messageFrom(error); });
    if (!desktopApp()) {
      const stop = browserSession.watch(applyView);
      return () => { stop(); audio.dispose(); setIdentity(); };
    }
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
      if (!receivedEvent) applyView(state, false);
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
      audio.dispose();
      setIdentity();
    };
  });

  async function restoreIdentityMode() {
    try {
      const hosted = await HostedAccount.restore();
      if (hosted) {
        useHostedIdentity(hosted);
        void updateSavedServers("", (servers) => servers).catch(() => {});
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
  }

  async function continueLocally() {
    const profile = await readLocalIdentity();
    if (profile) useLocalIdentity(profile);
    else setup = "local";
  }

  async function transferIdentity(provider: string, name: string, password: string) {
    await bookmarkUpdate;
    if (hostedAccount) return hostedAccount.transfer(provider, name, password);
    const profile = await readLocalIdentity();
    if (!profile) throw new Error("The local identity could not be loaded.");
    return HostedAccount.open(provider, name, password, {
      privateKey: async () => profile.identity.privateKey,
      servers: profile.servers,
    });
  }

  function useHostedIdentity({ account, identity, servers }: Awaited<ReturnType<typeof HostedAccount.open>>) {
    setIdentity(identity);
    username = account.username;
    savedServers = servers;
    hostedAccount = account;
    setup = null;
    rememberIdentityMode("hosted");
  }

  async function signOut() {
    const account = hostedAccount;
    if (!account || connectBusy || pending || removing) return false;
    if (serverOrigin && !await disconnect()) return false;
    return runAction("sign-out", async () => {
      await account.signOut();
      setIdentity();
      username = "";
      savedServers = [];
      hostedAccount = undefined;
      setup = "hosted";
    });
  }

  function updateSavedServers(origin: string, edit: (servers: SavedServer[]) => SavedServer[]) {
    const account = hostedAccount;
    const work = bookmarkUpdate.then(async () => {
      const servers = account ? await account.updateServers(edit) : await preferences.transaction("rw", preferences.servers, async () => {
        const entries = edit(await preferences.servers.toArray());
        const entry = entries.find((server) => server.origin === origin);
        if (entry) await preferences.servers.put(entry);
        else await preferences.servers.delete(origin);
        return entries;
      });
      if (hostedAccount === account) savedServers = servers;
    });
    bookmarkUpdate = work.catch(() => {});
    return work;
  }

  function applyView(state: VoiceState, notify = true) {
    const channel = state.snapshot?.channelId;
    const connection = state.snapshot?.connectionId;
    const member = state.snapshot?.members.find(({ connectionId }) => connectionId === connection);
    audio.setTalkContext(state.phase === "online" && state.voice === "active" && !state.whisperChannelId && connection && channel && member &&
      !member.muted && !member.adminMuted && !member.deafened && !member.adminDeafened && !member.afk
      ? { channelId: channel, connectionId: connection } : undefined);
    if (channel && channel !== view.snapshot?.channelId) selectedChannelId = channel;
    if (connection !== view.snapshot?.connectionId) {
      unreadDirectCounts = new Map();
      poke = null;
      pokeTarget = null;
    }
    if (notify && state.lastPoke && state.lastPoke.id !== view.lastPoke?.id) {
      poke = state.lastPoke;
      playUiSound("poke");
    }
    if (state.directMessages?.at(-1)?.id !== view.directMessages?.at(-1)?.id) {
      const previous = new Set(view.directMessages?.map(({ id }) => id));
      const incoming = state.directMessages?.filter((message) =>
        message.recipientId === state.snapshot?.account.id && !previous.has(message.id)) ?? [];
      if (incoming.length) {
        if (notify) playUiSound("directMessage");
        const unread = new Map(unreadDirectCounts);
        const viewingDirect = onWorkspace && roomView === "directMessages" &&
          (mobilePane === "room" || viewport > 760);
        for (const message of incoming) {
          if (viewingDirect && directAccountId === message.senderId) continue;
          unread.set(message.senderId, (unread.get(message.senderId) ?? 0) + 1);
        }
        unreadDirectCounts = unread;
      }
    }
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
    savedServerPassword = undefined;
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
    directAccountId = null;
    serverInfo = null;
    serverOrigin = "";
    selectedChannelId = null;
    const target = { origin, info: await getServerInfo(origin) };
    discovery = target;
    if (!target.info.identityAuthentication || !target.info.identityEnrollment) {
      throw new Error("Update this server to a Korero.chat version that supports identity sign-in.");
    }
    if (target.info.passwordRequired) {
      savedServerPassword = await getSavedPassword(origin, target.info.serverId).catch(() => undefined);
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
    if (!result.data || !("serverId" in result.data)) throw new Error("This server did not return Korero.chat server details.");
    return result.data;
  }

  function promptServerPassword(target: Target, rejectedPassword?: string) {
    if (rejectedPassword && rejectedPassword === savedServerPassword) {
      savedServerPassword = undefined;
      void forgetPassword(target.origin, target.info.serverId, "", rejectedPassword).catch(() => {});
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
      promptServerPassword(target, password);
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
      if (!desktopApp()) {
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
        if (!needsPassword) await signIn(updated);
        return;
      }
    }
    if (!bootstrap && result.status === 409) {
      if (code && target.info.passwordRequired && !serverPassword && !savedServerPassword) {
        serverCode = "";
        promptServerPassword(target);
        connectError = "This identity already has an account. Enter the server password to sign in.";
        return;
      }
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
    serverInfo = target.info;
    serverOrigin = target.origin;
    try {
      await audio.load();
      memberVolumes = await getMemberVolumes(target.info.serverId).catch(() => ({}));
      if (desktopApp()) await call("start_session", { memberVolumes });
      else await browserSession.start(memberVolumes);
    } catch (error) {
      actionError = messageFrom(error);
    }
    if (view.phase === "online") playUiSound("connect");
    if (password && password !== savedServerPassword) {
      await savePassword(target.origin, target.info.serverId, password).catch(() => {
        actionError = "This device could not save the server password.";
      });
    }
    if (remembered) {
      const entry = { name: target.info.name, origin: target.origin, passwordRequired: target.info.passwordRequired };
      try {
        await updateSavedServers(entry.origin, (servers) => [entry, ...servers.filter(({ origin }) => origin !== entry.origin)]);
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

  function run(action: string, command: string, args?: Record<string, unknown>) {
    return runAction(action, () => {
      if (desktopApp()) return call(command, args);
      if (command === "disconnect") return browserSession.disconnect();
      if (command === "save_channel") return browserSession.saveChannel(args?.payload as Record<string, unknown>);
      if (command === "delete_channel") return browserSession.deleteChannel(args?.channelId as string);
      if (command === "join_channel") return browserSession.joinChannel(args?.channelId as string, (args?.password as string | null) ?? undefined);
      if (command === "leave_channel") return browserSession.leaveChannel();
      if (command === "set_presence") return browserSession.setPresence(args);
      if (command === "send_message") return browserSession.sendMessage(args?.channelId as string, args?.text as string, args?.html as string | undefined);
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
    return runAction(request.kind, () => desktopApp() ? call("member_action", request) : browserSession.memberAction(request));
  }

  function setMemberVolume(accountId: string, level: number) {
    const origin = serverOrigin;
    const serverId = serverInfo?.serverId;
    const isCurrentServer = () => serverOrigin === origin && serverInfo?.serverId === serverId;
    memberVolumeUpdate = memberVolumeUpdate.then(async () => {
      if (!isCurrentServer() || view.phase !== "online" || pending === "disconnect") return false;
      actionError = "";
      try {
        if (desktopApp()) await call("set_member_volume", { accountId, level });
        else browserSession.setMemberVolume(accountId, level);
        if (!isCurrentServer()) return false;
        const next = { ...memberVolumes };
        if (level === defaultMemberVolume) delete next[accountId];
        else next[accountId] = level;
        memberVolumes = next;
        if (serverId) await saveMemberVolumes(serverId, next);
        return true;
      } catch (error) {
        if (isCurrentServer()) actionError = messageFrom(error);
        return false;
      }
    });
    return memberVolumeUpdate;
  }

  async function disconnect() {
    if (connectBusy) return false;
    if (!await run("disconnect", "disconnect")) return false;
    playUiSound("disconnect");
    roomView = "chat";
    serverInfo = null;
    serverOrigin = "";
    selectedChannelId = null;
    directAccountId = null;
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

  function showDirectMessages(accountId?: string) {
    if (!online || !view.snapshot?.directMessages || !serverInfo?.serverId) return;
    directAccountId = accountId ?? null;
    if (accountId && unreadDirectCounts.has(accountId)) {
      const unread = new Map(unreadDirectCounts);
      unread.delete(accountId);
      unreadDirectCounts = unread;
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
    if (!poke || !online || !serverInfo?.serverId) return;
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
      if (canAdminister) actions.push({ label: "Server administration", onSelect: showServerSettings });
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
      await updateSavedServers(origin, (servers) => servers.filter((server) => server.origin !== origin));
      await preferences.passwords.where("origin").equals(origin).delete();
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

<svelte:window bind:innerWidth={viewport} onkeydown={audio.talkKeyDown} onkeyup={audio.talkKeyUp} onblur={audio.talkWindowBlur} />

<div class="shell" data-pane={onWorkspace ? mobilePane : "room"} data-workspace={onWorkspace} style:--rail-width={railWidth + "px"} style:--channel-width={channelWidth + "px"}>
  <aside id="server-rail" class="server-rail" aria-label="Servers">
    <div class="rail-top">
      <svg class="brand" viewBox="2 0 126 29" role="img" aria-label="Kōrero.">
        <use href={asset("/korero-logo.svg") + "#wordmark"} />
      </svg>
      <Button variant="outline" class="rail-connect" disabled={!identityReady || connectBusy || Boolean(pending)} onclick={() => showConnect()}><Plus size={18} /> Connect to server</Button>
      <section class="rail-section">
        <div class="rail-section-label"><span>Servers</span></div>
        {#if serverOrigin}
          <div class="active-server">
            <ContextActions actions={serverActions({ origin: serverOrigin, name: serverTitle })} disabled={connectBusy || Boolean(pending)}>
              {#snippet trigger(props)}
                <button {...props} type="button" class="rail-server" onclick={() => openWorkspace("channels")}>
                  <span class="shrinkable"><strong class="truncate">{serverTitle}</strong></span>
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
        <Avatar name={me?.displayName ?? username} accountId={me?.id} />
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
  {#if online && view.snapshot}
    {#key view.snapshot.connectionId}
      <ScreenSharing snapshot={view.snapshot} controlsTarget={screenShareControlsTarget}
        inlineTarget={screenShareViewerTarget} visible={Boolean(screenShareViewerTarget)} />
    {/key}
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
  <div class="fixed inset-x-3 top-[max(0.75rem,env(safe-area-inset-top))] z-50 mx-auto flex max-w-md items-start gap-1 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg">
    <button type="button" class="flex min-w-0 flex-1 items-start gap-3 rounded-md p-2 text-left hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
      onclick={replyToPoke}>
      <BellRing size={20} class="mt-0.5 shrink-0 text-(--info)" aria-hidden="true" />
      <span class="min-w-0 flex-1 wrap-anywhere">
        <strong class="block text-sm">{poke.senderName} poked you</strong>
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
  <AccountSetup open={true} onlocal={continueLocally} oncomplete={useHostedIdentity} />
{/if}
{#if setup === "local"}
  <LocalIdentitySetup open={true} onback={() => { setup = "hosted"; }} oncomplete={useLocalIdentity} />
{/if}

<Modal bind:open={connectOpen} title={trustPrompt ? (trustPrompt.previous ? "Server certificate changed" : "Trust this server?") : discovery ? discovery.info.name : "Connect to a server"} description={discovery ? shortHost(discovery.origin) : "Paste an invitation link or enter a server address."} dismissible={!connectBusy}>
  {#snippet icon()}{#if discovery?.info.passwordRequired}<LockKeyhole size={21} />{:else}<Cable size={21} />{/if}{/snippet}
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
        <Button variant="outline" disabled={connectBusy} onclick={() => { trustPrompt = null; }}>Back</Button>
        <Button variant="default" disabled={connectBusy} onclick={approveTrust}>Trust and continue</Button>
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
      {#if needsPassword}
        <label>Server password<Input type="password" autocomplete="current-password" required maxlength={128} bind:value={serverPassword} /></label>
      {/if}
      {#if invitationRequired && !claimOwnership}
        <label>Invitation code
          <Input type="password" required autocomplete="off" spellcheck="false" bind:value={serverCode} />
        </label>
      {/if}
      <div class="dialog-actions">
        <Button variant="outline" type="button" disabled={connectBusy} onclick={() => resetConnect(discoverAddress)}>Back</Button>
        <Button type="submit" variant="default" disabled={connectBusy}>{connectBusy ? "Connecting…" : claimOwnership ? "Set up server" : "Connect"} <ArrowRight size={16} /></Button>
      </div>
    </form>
  {:else}
    <form class="dialog-form" onsubmit={discover}>
      <label>Server address or invitation link<Input required autocomplete="off" inputmode="url" placeholder="example.com:8443" spellcheck="false" disabled={connectBusy} bind:value={discoverAddress} /></label>
      <Checkbox label="Save this server address" bind:checked={remembered} />
      <Button variant="default" type="submit" disabled={connectBusy}>{connectBusy ? "Connecting…" : "Connect"} <ArrowRight size={16} /></Button>
    </form>
  {/if}
</Modal>

{#snippet serverLock()}
  <span class="access-lock" title="Password protected">
    <LockKeyhole size={14} aria-hidden="true" /><span class="sr-only">Password protected</span>
  </span>
{/snippet}

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
