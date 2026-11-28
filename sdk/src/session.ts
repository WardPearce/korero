import { offline, isSameDirectMessage, type DirectMessage, type DirectMessageChange, type DirectMessageReference, type DirectOperation, type Member, type MemberRequest, type Message, type MessageMention, type MessageMentions, type MessageReaction, type PinCursor, type ReactionChange, type PinnedMessagePage, type MessageSearchPage, type SearchCursor, type Poke, type RelayResponse, type ScreenShare, type Snapshot, type VoiceState } from "./types.js";
import { messageFrom, requestError } from "./errors.js";
import { authenticateIdentity, type IdentityAuthentication } from "./auth.js";
import { createApi } from "./http.js";
import { Channel, ChannelMessage, type ChannelOptions } from "./channel.js";
import type { DirectCursor, DirectPacket, DirectPage, DirectPeer } from "./direct-crypto.js";
import { webTransport, type ServerSocket, type Transport } from "./transport.js";

type Credentials = { accessToken: string; refreshToken: string; accessExpiresAt: number };
type Frame = { version: 1; type: string; id: number; success: boolean; payload: unknown; error?: unknown };

export interface SessionMedia {
  readonly channelId: string;
  readonly voice: VoiceState["voice"];
  readonly error: string | null;
  update(snapshot: Snapshot): void;
  event(type: string, payload: unknown): void;
  setVolume(accountId: string, level: number): void;
  close(): void;
}

export interface SessionMediaAdapter {
  resume(): void;
  open(
    channelId: string,
    connectionId: string,
    request: <T>(type: string, payload: unknown) => Promise<T>,
    onChange: () => void,
    volumes: Record<string, number>,
  ): SessionMedia;
  stop(): void;
}

export interface SessionOptions {
  transport?: Transport;
  media?: SessionMediaAdapter;
}

export interface ClientEvents {
  state: VoiceState;
  ready: Snapshot;
  messageCreate: ChannelMessage;
  messageUpdate: { id: string; text: string; html?: string; editedAt: number };
  messageDelete: { id: string };
  /** Another member mentioned this account or one of its roles. */
  mention: MessageMention;
  reaction: ReactionChange;
  directMessage: DirectMessage;
  directMessageChange: DirectMessageChange;
  poke: Poke;
  raw: { type: string; payload: unknown };
}

export type ConnectOptions = Omit<IdentityAuthentication, "serverId" | "action"> &
  Partial<Pick<IdentityAuthentication, "serverId" | "action">>;

/** Applies a live reaction change; `me` only changes when the reacting account is this one. */
function applyReaction(reactions: MessageReaction[] = [], change: ReactionChange, mine: boolean) {
  const current = reactions.find(({ emoji }) => emoji === change.emoji);
  const me = mine ? change.reacted : current?.me ?? false;
  const next = current ? reactions.map((entry) => entry === current ? { ...entry, count: change.count, me } : entry)
    : [...reactions, { emoji: change.emoji, count: change.count, me }];
  return next.filter(({ count }) => count > 0);
}

/** Direct messages kept in the view while connected. Older ones remain in server history. */
const directMessageLimit = 200;
const channelMessageLimit = 200;
/** A signed-in connection to one server. */
export class KoreroClient {
  readonly origin: string;
  readonly api: ReturnType<typeof createApi>;
  private readonly transport: Transport;
  private readonly media?: SessionMediaAdapter;
  private readonly listeners = new Map<keyof ClientEvents, Set<(value: never) => void>>();
  private currentState: VoiceState = offline;
  private credentials?: Credentials;
  private authenticating = false;
  private starting?: Promise<void>;
  private refresh?: Promise<void>;
  private socket?: ServerSocket;
  private heartbeat?: ReturnType<typeof setInterval>;
  private nextId = 0;
  private voice?: SessionMedia;
  private volumes: Record<string, number> = {};
  private pending = new Map<number, (reply: Frame | null) => void>();
  private snapshot: Snapshot | null = null;
  private messages: Message[] = [];
  private messageRevisions: Record<string, number> = {};
  private directMessages: DirectMessage[] = [];
  private lastPoke?: Poke;
  private lastMention?: MessageMention;
  /** A channel whose chat is followed without joining it. */
  private viewedChannelId: string | null = null;
  private viewRequest?: { channelId: string | null };
  /** Maps history requests to deletions received during the request, or null once settled. */
  private loadedHistory = new Map<string, Set<string> | null>();

  private closed = false;

  constructor(origin: string, options: SessionOptions = {}) {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("A Korero server origin must be an HTTPS origin.");
    }
    this.origin = url.origin;
    this.transport = options.transport ?? webTransport;
    this.media = options.media;
    this.api = createApi(this.origin, (request) => this.fetch(request));
  }

  get state() { return this.currentState; }

  on<K extends keyof ClientEvents>(event: K, listener: (value: ClientEvents[K]) => void): this {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  off<K extends keyof ClientEvents>(event: K, listener: (value: ClientEvents[K]) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  once<K extends keyof ClientEvents>(event: K, listener: (value: ClientEvents[K]) => void): this {
    const handle = (value: ClientEvents[K]) => {
      this.off(event, handle);
      listener(value);
    };
    return this.on(event, handle);
  }

  private emit<K extends keyof ClientEvents>(event: K, value: ClientEvents[K]) {
    for (const listener of [...this.listeners.get(event) ?? []]) listener(value as never);
  }

  private update(state: VoiceState) {
    this.currentState = state;
    this.emit("state", state);
  }

  channel(id: string) {
    return new Channel(id, this);
  }

  /** Signs in and opens signaling. Pass a known server ID to pin the identity challenge to it. */
  async connect({ serverId, action = { operation: "login" }, ...options }: ConnectOptions) {
    if (!serverId) {
      const result = await this.api.server.info.get();
      if (result.error) throw requestError(result.error);
      serverId = result.data?.serverId;
      if (!serverId) throw new Error("The server did not provide its identity.");
    }
    const response = await this.authenticate({ ...options, action, serverId });
    if (response.status < 200 || response.status >= 300) throw requestError({ value: response.body });
    await this.start();
    if (!this.snapshot) throw new Error("The server connection closed.");
    return this.snapshot;
  }

  get connectionId() { return this.snapshot?.connectionId; }
  get channelId() { return this.snapshot?.channelId ?? null; }

  resumeAudio() {
    if (this.voice) this.media?.resume();
  }

  async authenticate(options: IdentityAuthentication) {
    if (this.authenticating || this.starting || this.socket) throw new Error("Disconnect before signing in again.");
    this.authenticating = true;
    try {
      return await authenticateIdentity((path, body) => this.identityRequest(path, body), this.origin, options);
    } finally {
      this.authenticating = false;
    }
  }

  private async identityRequest(path: string, body: unknown): Promise<RelayResponse> {
    if (this.closed) throw new Error("The selected server changed.");
    const response = await this.post(path, body);
    const result = await response.json();
    if (response.ok && path !== "/api/v1/auth/identity/challenge") {
      if (this.closed) throw new Error("The selected server changed.");
      const { accessToken, refreshToken, accessExpiresAt, account } = result;
      if (!accessToken || !refreshToken || !accessExpiresAt) throw new Error("The server did not create a session.");
      this.credentials = { accessToken, refreshToken, accessExpiresAt };
      return { status: response.status, body: { account } };
    }
    return { status: response.status, body: result };
  }

  private post(path: string, body?: unknown, accessToken?: string) {
    return this.transport.fetch(this.origin + path, {
      method: "POST", timeout: 8000,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  private async accessToken() {
    const credentials = this.credentials;
    if (!credentials) throw new Error("Connect to a server first.");
    if (credentials.accessExpiresAt <= Date.now() + 15000) {
      this.refresh ??= (async () => {
        const response = await this.post("/api/v1/auth/refresh", { refreshToken: credentials.refreshToken });
        const result = await response.json();
        if (!response.ok) throw requestError({ value: result });
        if (this.credentials === credentials) this.credentials = result;
      })().finally(() => { this.refresh = undefined; });
      await this.refresh;
    }
    if (!this.credentials) throw new Error("The selected server changed.");
    return this.credentials.accessToken;
  }

  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.origin !== this.origin || !url.pathname.startsWith("/api/v1/")) {
      throw new Error("Invalid API path for this server.");
    }
    if (this.closed) throw new Error("The selected server changed.");
    const headers = new Headers(request.headers);
    const path = url.pathname;
    if (path !== "/api/v1/server/info" && path !== "/api/v1/server/capabilities") {
      const token = await this.accessToken();
      if (this.closed) throw new Error("The selected server changed.");
      headers.set("authorization", `Bearer ${token}`);
    }
    const attachment = path === "/api/v1/chat/attachments" || path.startsWith("/api/v1/chat/attachments/");
    return this.transport.fetch(request, { headers, timeout: attachment ? 120000 : 8000 });
  }

  private async ticket() {
    const token = await this.accessToken();
    const response = await this.post("/api/v1/auth/connection-ticket", {}, token);
    const result = await response.json();
    if (!response.ok) throw requestError({ value: result });
    return { ticket: result.ticket as string, token };
  }

  start(volumes: Record<string, number> = {}) {
    if (this.closed || this.authenticating || !this.credentials) {
      return Promise.reject(new Error("Sign in before starting the server connection."));
    }
    if (this.starting) return this.starting;
    if (this.socket) return Promise.resolve();
    this.starting = Promise.resolve().then(() => this.open(volumes)).finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async open(volumes: Record<string, number>) {
    if (this.closed) throw new Error("The selected server changed.");
    this.volumes = { ...volumes };
    try {
      this.update({ ...offline, phase: "connecting" });
      const { ticket, token } = await this.ticket();
      let connectionToken = token;
      if (this.closed) throw new Error("The selected server changed.");
      const socket = this.transport.openSocket(this.origin.replace(/^https:/, "wss:") + "/api/v1/ws");
      this.socket = socket;
      let authorized = false;
      let failOpening: ((error: Error) => void) | undefined;
      socket.onclose = () => {
        failOpening?.(new Error("The server connection closed."));
        if (socket !== this.socket) return;
        this.closeSocket();
        this.update({ ...offline, phase: "error", error: "The server connection closed. Reconnect to continue." });
      };
      socket.onmessage = ({ data }) => {
        if (socket !== this.socket) return;
        let frame: Frame | undefined;
        try { frame = JSON.parse(data) as Frame; } catch {}
        if (frame?.version !== 1 || typeof frame.type !== "string") {
          socket.close();
          return;
        }
        if (frame.type === "response") this.pending.get(frame.id)?.(frame);
        else if (authorized) {
          this.event(frame);
          this.emit("raw", { type: frame.type, payload: frame.payload });
        }
      };
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("The server connection timed out.")), 8000);
        failOpening = (error) => { clearTimeout(timer); reject(error); };
        socket.onopen = () => { clearTimeout(timer); resolve(); };
        socket.onerror = () => failOpening?.(new Error("Could not open the server connection."));
      });
      failOpening = undefined;
      const state = await this.rpc<Snapshot>("connection.authenticate", { ticket, versions: [1] });
      if (socket !== this.socket) throw new Error("The server connection closed.");
      authorized = true;
      this.showSnapshot(state);
      if (socket !== this.socket) throw new Error("The server connection closed.");
      this.emit("ready", state);
      if (socket !== this.socket) return;
      void this.receiveQueued(socket);
      this.heartbeat = setInterval(async () => {
        try {
          const token = await this.accessToken();
          if (socket !== this.socket) return;
          if (token !== connectionToken) {
            const next = await this.ticket();
            if (socket !== this.socket) return;
            await this.rpc("connection.renew", { ticket: next.ticket });
            connectionToken = next.token;
          }
          await this.rpc("heartbeat");
        } catch {
          if (socket === this.socket) socket.close();
        }
      }, 15000);
    } catch (error) {
      this.closeSocket();
      if (!this.closed) this.update({ ...offline, phase: "error", error: messageFrom(error) });
      throw error;
    }
  }

  /** Fetches direct messages queued while offline, then acknowledges them. */
  private async receiveQueued(socket: ServerSocket) {
    try {
      while (socket === this.socket) {
        const queued = await this.rpc<DirectMessage[]>("direct.pending");
        if (socket !== this.socket) return;
        const account = this.snapshot?.account.id;
        const mine = queued.filter(({ recipientId }) => recipientId === account);
        for (const message of mine) if (this.addDirectMessage(message)) this.emit("directMessage", message);
        if (mine.length) this.show();
        if (!mine.length || socket !== this.socket) return;
        await this.rpc("direct.ack", { ids: mine.map(({ id }) => id) });
        if (queued.length < 100) return;
      }
    } catch {
      // Older servers do not queue direct messages.
    }
  }

  private addDirectMessage(message: DirectMessage) {
    if (this.directMessages.some((known) => isSameDirectMessage(known, message))) return false;
    this.directMessages = [...this.directMessages, message].slice(-directMessageLimit);
    return true;
  }

  rpc<T = unknown>(type: string, payload: unknown = {}): Promise<T> {
    const socket = this.socket;
    if (socket?.readyState !== 1) return Promise.reject(new Error("Connect to a server first."));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => this.pending.get(id)?.(null), 8000);
      this.pending.set(id, (reply) => {
        clearTimeout(timer);
        this.pending.delete(id);
        if (!reply) reject(new Error("The server request timed out or the connection closed."));
        else if (!reply.success) reject(requestError({ value: reply }));
        else resolve(reply.payload as T);
      });
      try {
        socket.send(JSON.stringify({ version: 1, id, type, payload }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private showSnapshot(snapshot: Snapshot) {
    this.snapshot = snapshot;
    if (this.media) this.updateVoice(snapshot, this.media);
    this.syncChat();
    this.show();
  }

  /** The joined channel and the viewed channel, whose messages this session keeps. */
  private chatChannels() {
    return new Set([this.snapshot?.channelId, this.viewedChannelId].filter((id): id is string => Boolean(id)));
  }

  private syncChat() {
    const channels = this.chatChannels();
    this.messages = this.messages.filter(({ channelId }) => channelId && channels.has(channelId));
    for (const id of this.loadedHistory.keys()) if (!channels.has(id)) this.loadedHistory.delete(id);
    for (const id of channels) if (!this.loadedHistory.has(id)) this.loadHistory(id);
  }

  private loadHistory(channelId: string) {
    const deleted = new Set<string>();
    this.loadedHistory.set(channelId, deleted);
    void this.rpc<Message[]>("message.history", { channelId }).then((history) => {
      if (this.loadedHistory.get(channelId) !== deleted) return;
      const entries = new Map(history.reverse().map((message) => [message.id, message]));
      const others: Message[] = [];
      for (const message of this.messages) {
        if (message.channelId === channelId) entries.set(message.id, message);
        else others.push(message);
      }
      for (const id of deleted) entries.delete(id);
      this.messages = [...others, ...[...entries.values()].slice(-channelMessageLimit)];
      this.show();
    }).catch(() => {}).finally(() => {
      if (this.loadedHistory.get(channelId) === deleted) this.loadedHistory.set(channelId, null);
    });
  }

  async viewChannel(connectionId: string, channelId: string | null) {
    const requested = this.viewRequest ? this.viewRequest.channelId : this.viewedChannelId;
    if (this.snapshot?.connectionId !== connectionId || requested === channelId) return;
    const request = { channelId };
    const socket = this.socket;
    this.viewRequest = request;
    // Subscribe before loading history so no live message falls between the two.
    try {
      await this.rpc("channel.view", { channelId });
      if (this.socket !== socket) return;
      this.viewedChannelId = channelId;
      this.syncChat();
      this.show();
    } finally {
      if (this.viewRequest === request) this.viewRequest = undefined;
    }
  }

  private updateVoice(snapshot: Snapshot, media: SessionMediaAdapter) {
    const { channelId, connectionId } = snapshot;
    if ((this.voice?.channelId ?? null) !== channelId) {
      this.voice?.close();
      this.voice = undefined;
      if (channelId) {
        const socket = this.socket;
        this.voice = media.open(channelId, connectionId, (kind, payload) => {
          if (socket !== this.socket || this.snapshot?.channelId !== channelId) {
            return Promise.reject(new Error("The active channel changed."));
          }
          return this.rpc(kind, payload);
        }, () => this.show(), this.volumes);
      } else media.stop();
    }
    this.voice?.update(snapshot);
  }

  private show(directChange?: DirectMessageChange) {
    this.update({ ...offline, phase: "online", snapshot: this.snapshot, messages: this.messages, messageRevisions: this.messageRevisions, directMessages: this.directMessages,
      directChange, lastPoke: this.lastPoke, lastMention: this.lastMention, voice: this.voice?.voice ?? "idle", voiceError: this.voice?.error ?? null });
  }

  private reviseMessages(channelId?: string) {
    if (channelId) this.messageRevisions = { ...this.messageRevisions, [channelId]: (this.messageRevisions[channelId] ?? 0) + 1 };
  }

  private event({ type, payload }: Frame) {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    if (type.startsWith("media.")) this.voice?.event(type, payload);
    if (type === "channel.voiceActivity") {
      const { channelId, connectionId, speaking } = payload as { channelId: string; connectionId: string; speaking: boolean };
      const update = (member: Member) => member.connectionId === connectionId ? { ...member, speaking } : member;
      let channelMembers = snapshot.channelMembers;
      if (channelMembers?.[channelId]) channelMembers = { ...channelMembers, [channelId]: channelMembers[channelId].map(update) };
      this.snapshot = { ...snapshot, channelMembers,
        members: snapshot.channelId === channelId ? snapshot.members.map(update) : snapshot.members };
      this.show();
    } else if (["state.invalidated", "presence.changed", "presence.offline", "channel.member", "channel.userChanged", "channel.changed"].includes(type)) {
      const socket = this.socket;
      void this.rpc<Snapshot>("state.get").then((state) => {
        if (socket === this.socket) this.showSnapshot(state);
      }).catch(() => {});
    } else if (type === "channel.viewEnded") {
      const { channelId } = payload as { channelId: string };
      if (this.viewedChannelId !== channelId) return;
      this.viewedChannelId = null;
      this.syncChat();
      this.show();
    } else if (type === "message.created") {
      const message = payload as Message;
      if (!message.channelId || !this.chatChannels().has(message.channelId) || this.messages.some(({ id }) => id === message.id)) return;
      this.messages = [...this.messages, message];
      const inChannel = this.messages.filter(({ channelId }) => channelId === message.channelId);
      if (inChannel.length > channelMessageLimit) {
        const oldest = new Set(inChannel.slice(0, inChannel.length - channelMessageLimit));
        this.messages = this.messages.filter((entry) => !oldest.has(entry));
      }
      this.show();
      this.emit("messageCreate", new ChannelMessage(message, this.channel(message.channelId), this));
    } else if (type === "direct.created") {
      const message = payload as DirectMessage;
      if (message.senderId !== snapshot.account.id && message.recipientId !== snapshot.account.id) return;
      if (this.addDirectMessage(message)) {
        this.show();
        this.emit("directMessage", message);
      }
    } else if (type === "message.edited") {
      const edit = payload as { channelId?: string; messageId: string; text: string; html?: string; editedAt: number; mentions?: MessageMentions };
      this.messages = this.messages.map((message) => message.id === edit.messageId
        ? { ...message, text: edit.text, html: edit.html, editedAt: edit.editedAt,
          ...(edit.mentions ? { mentions: edit.mentions.accounts.length || edit.mentions.roles.length ? edit.mentions : undefined } : {}) } : message);
      this.reviseMessages(edit.channelId);
      this.show();
      this.emit("messageUpdate", { id: edit.messageId, text: edit.text, html: edit.html, editedAt: edit.editedAt });
    } else if (type === "message.reactionsChanged") {
      const change = payload as ReactionChange;
      const mine = change.accountId === snapshot.account.id;
      this.messages = this.messages.map((message) => message.id === change.messageId
        ? { ...message, reactions: applyReaction(message.reactions, change, mine) } : message);
      this.reviseMessages(change.channelId);
      this.show();
      this.emit("reaction", change);
    } else if (type === "message.mentioned") {
      this.lastMention = payload as MessageMention;
      this.show();
      this.emit("mention", this.lastMention);
    } else if (type === "message.pinChanged") {
      const { channelId, messageId, pinnedAt } = payload as { channelId: string; messageId: string; pinnedAt: number | null };
      this.messages = this.messages.map((message) => message.id === messageId ? { ...message, pinnedAt } : message);
      this.reviseMessages(channelId);
      this.show();
    } else if (type === "direct.edited") {
      const edit = payload as Partial<DirectMessage> & Pick<DirectMessage, "id" | "senderId" | "recipientId" | "nonce" | "ciphertext" | "signature" | "editedAt">;
      if (edit.senderId !== snapshot.account.id && edit.recipientId !== snapshot.account.id) return;
      const known = this.directMessages.find((message) => isSameDirectMessage(message, edit));
      // A packet loaded from history is not held here. Keep the edit so the conversation can apply it.
      const base = known ?? (edit.createdAt === undefined ? undefined : edit as DirectMessage);
      if (!base) return;
      const next = { ...base, nonce: edit.nonce, ciphertext: edit.ciphertext, signature: edit.signature, editedAt: edit.editedAt };
      this.directMessages = known ? this.directMessages.map((message) => message === known ? next : message)
        : [...this.directMessages, next].slice(-directMessageLimit);
      const change = { type: "edit", message: next } as const;
      this.show(change);
      this.emit("directMessageChange", change);
    } else if (type === "direct.deleted") {
      const deleted = payload as DirectMessageReference;
      if (deleted.senderId !== snapshot.account.id && deleted.recipientId !== snapshot.account.id) return;
      this.directMessages = this.directMessages.filter((message) => !isSameDirectMessage(message, deleted));
      const change = { type: "delete", message: deleted } as const;
      this.show(change);
      this.emit("directMessageChange", change);
    } else if (type === "direct.poked") {
      const poke = payload as Poke;
      if (poke.recipientId !== snapshot.account.id) return;
      this.lastPoke = poke;
      this.show();
      this.emit("poke", poke);
    } else if (type === "message.deleted") {
      const { channelId, messageId } = payload as { channelId?: string; messageId: string };
      for (const deleted of this.loadedHistory.values()) deleted?.add(messageId);
      this.messages = this.messages.filter(({ id }) => id !== messageId);
      this.reviseMessages(channelId);
      this.show();
      this.emit("messageDelete", { id: messageId });
    } else if (type === "media.reset") {
      if ((payload as { channelId: string }).channelId !== snapshot.channelId) return;
      this.showSnapshot({ ...snapshot, screens: [], cameras: snapshot.cameras && [] });
    } else if (type === "media.screenAvailable" || type === "media.screenClosed"
      || type === "media.cameraAvailable" || type === "media.cameraClosed") {
      const share = payload as ScreenShare & { channelId: string };
      if (share.channelId !== snapshot.channelId) return;
      const source = type.startsWith("media.camera") ? "cameras" : "screens";
      const shares = [...(snapshot[source] ?? [])];
      const index = shares.findIndex(({ producerId }) => producerId === share.producerId);
      if (type.endsWith("Available")) {
        if (index === -1) shares.push(share);
        else shares[index] = share;
      } else if (index !== -1) shares.splice(index, 1);
      this.showSnapshot({ ...snapshot, [source]: shares });
    }
  }

  async joinChannel(channelId: string, password?: string) {
    this.media?.resume();
    this.showSnapshot(await this.rpc<Snapshot>("channel.join", { channelId, password }));
  }

  async leaveChannel() {
    this.showSnapshot(await this.rpc<Snapshot>("channel.leave"));
  }

  async setPresence(payload: Record<string, unknown> | undefined) {
    // The protocol distinguishes an omitted field from a boolean value.
    const fields = Object.fromEntries(Object.entries(payload ?? {}).filter(([, value]) => value != null));
    const member = await this.rpc<Member>("presence.set", fields);
    const snapshot = this.snapshot;
    if (!snapshot || member.connectionId !== snapshot.connectionId) return;
    this.showSnapshot({ ...snapshot, members: snapshot.members.map((entry) => entry.connectionId === member.connectionId
      ? { ...entry, ...member } : entry) });
  }

  setMemberVolume(accountId: string, level: number) {
    this.volumes[accountId] = level;
    this.voice?.setVolume(accountId, level);
  }

  async sendMessage(channelId: string, text: string, html?: string,
    options: { replyTo?: string; mentions?: Partial<MessageMentions> } = {}) {
    return this.rpc<{ messageId: string }>("message.send", { channelId, text, html, ...options });
  }

  async editMessage(messageId: string, text: string, html?: string, mentions?: Partial<MessageMentions>) {
    await this.rpc("message.edit", { messageId, text, html, mentions });
  }

  async reactToMessage(channelId: string, messageId: string, emoji: string, reacted: boolean) {
    await this.rpc("message.react", { channelId, messageId, emoji, reacted });
  }

  async deleteMessage(messageId: string) {
    await this.rpc("message.delete", { messageId });
  }

  pinnedMessages(channelId: string, before?: PinCursor) {
    return this.rpc<PinnedMessagePage>("message.pins", { channelId, before });
  }

  /** Searches a channel's stored messages, newest first. Pass the page's `next` as `before` to continue. */
  searchMessages(channelId: string, query: string, before?: SearchCursor) {
    return this.rpc<MessageSearchPage>("message.search", { channelId, query, before });
  }

  messageContext(channelId: string, messageId: string) {
    return this.rpc<Message[]>("message.context", { channelId, messageId });
  }

  async setMessagePin(channelId: string, messageId: string, pinned: boolean) {
    await this.rpc("message.pin", { channelId, messageId, pinned });
  }

  screenRequest<T>(connectionId: string, channelId: string, kind: string, payload: unknown) {
    if (this.snapshot?.connectionId !== connectionId || this.snapshot?.channelId !== channelId) {
      return Promise.reject(new Error("The active channel changed."));
    }
    return this.rpc<T>(kind, payload);
  }

  directRequest<T>(connectionId: string, kind: DirectOperation, payload: unknown) {
    if (this.snapshot?.connectionId !== connectionId) return Promise.reject(new Error("The server connection changed."));
    return this.rpc<T>(kind, payload);
  }

  async createChannel(options: ChannelOptions & { name: string; temporary?: boolean }) {
    return this.channel(await this.saveChannel(options));
  }

  directPeer(accountId: string) {
    return this.rpc<DirectPeer & { ownPublicKey: string }>("direct.peer", { accountId });
  }

  directHistory(accountId: string, before?: DirectCursor) {
    return this.rpc<DirectPage>("direct.history", { accountId, before });
  }

  sendDirect(packet: DirectPacket) {
    return this.rpc<{ messageId: string; queued: boolean }>("direct.send", packet);
  }

  editDirect(packet: DirectPacket) {
    return this.rpc("direct.edit", packet);
  }

  deleteDirect(accountId: string, id: string) {
    return this.rpc("direct.delete", { accountId, id });
  }

  poke(accountId: string, message?: string) {
    return this.rpc("direct.poke", { accountId, message });
  }

  async saveChannel(payload: ChannelOptions & { channelId?: string; temporary?: boolean }) {
    const result = await this.rpc<{ state: Snapshot; channelId: string }>(payload.channelId ? "channel.edit" : "channel.create", payload);
    this.showSnapshot(result.state);
    return result.channelId;
  }

  async deleteChannel(channelId: string) {
    await this.rpc("channel.delete", { channelId });
  }

  async memberAction({ kind, payload }: MemberRequest) {
    await this.rpc(kind, payload);
  }

  private closeSocket() {
    const socket = this.socket;
    this.socket = undefined;
    this.voice?.close();
    this.voice = undefined;
    this.media?.stop();
    this.snapshot = null;
    this.messages = [];
    this.messageRevisions = {};
    this.directMessages = [];
    this.lastPoke = undefined;
    this.lastMention = undefined;
    this.viewedChannelId = null;
    this.viewRequest = undefined;
    this.loadedHistory.clear();
    clearInterval(this.heartbeat);
    socket?.close();
    for (const settle of this.pending.values()) settle(null);
  }

  async disconnect() {
    this.closed = true;
    this.closeSocket();
    const token = this.credentials?.accessToken;
    this.credentials = undefined;
    this.update(offline);
    if (token) await this.post("/api/v1/auth/logout", undefined, token).catch(() => {});
  }
}
