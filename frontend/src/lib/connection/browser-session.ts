import { offline, requestError, messageFrom, type DirectMessage, type DirectOperation, type Member, type MemberRequest, type Message, type Poke, type RelayResponse, type ScreenShare, type Snapshot, type VoiceState } from "./client";
import { MobileCallAudio } from "../media/mobile-call-audio";
import { WebVoice } from "../media/web-voice";
import { mobileApp, voiceApp } from "./platform";

type Credentials = { accessToken: string; refreshToken: string; accessExpiresAt: number };
type Reply = { type: string; id: number; success: boolean; payload: unknown; error?: unknown };

export function browserServerOrigin(address: string) {
  const value = address.trim();
  let url: URL | undefined;
  try { url = new URL(value.includes("://") ? value : `https://${value}`); } catch {}
  if (!url || url.protocol !== "https:" || !url.host || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Enter a server IP or host, with an optional port.");
  }
  return url.origin;
}

/** Direct messages kept in the view while connected. Older ones remain in server history. */
const directMessageLimit = 200;
// Voice uses one call at a time, so the sessions share the platform call audio route.
const callAudio = new MobileCallAudio();

class BrowserSession {
  private credentials?: Credentials;
  private refresh?: Promise<void>;
  private socket?: WebSocket;
  private heartbeat?: ReturnType<typeof setInterval>;
  private nextId = 0;
  private readonly callAudio = callAudio;
  private voice?: WebVoice;
  private audio?: AudioContext;
  private volumes: Record<string, number> = {};
  private pending = new Map<number, (reply: Reply | null) => void>();
  private snapshot: Snapshot | null = null;
  private messages: Message[] = [];
  private directMessages: DirectMessage[] = [];
  private lastPoke?: Poke;
  private directDeleted: string[] = [];
  private historyRequest = 0;
  private deletedDuringHistory?: Set<string>;

  private closed = false;

  constructor(readonly origin: string, private readonly update: (view: VoiceState) => void) {}

  get connectionId() { return this.snapshot?.connectionId; }
  get channelId() { return this.snapshot?.channelId ?? null; }

  resumeAudio() {
    if (this.voice) void this.audio?.resume().catch(() => {});
  }

  async request(path: string, body: unknown): Promise<RelayResponse> {
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
    return fetch(this.origin + path, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(8000),
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
    const headers = new Headers(request.headers);
    const path = new URL(request.url).pathname;
    if (path !== "/api/v1/server/info" && path !== "/api/v1/server/capabilities") {
      const token = await this.accessToken();
      if (this.closed) throw new Error("The selected server changed.");
      headers.set("authorization", `Bearer ${token}`);
    }
    const attachment = path === "/api/v1/chat/attachments" || path.startsWith("/api/v1/chat/attachments/");
    return fetch(request, { headers, signal: AbortSignal.timeout(attachment ? 120000 : 8000), redirect: "error" });
  }

  private async ticket() {
    const token = await this.accessToken();
    const response = await this.post("/api/v1/auth/connection-ticket", {}, token);
    const result = await response.json();
    if (!response.ok) throw requestError({ value: result });
    return { ticket: result.ticket as string, token };
  }

  async start(volumes: Record<string, number> = {}) {
    this.volumes = { ...volumes };
    this.update({ ...offline, phase: "connecting" });
    try {
      const { ticket, token } = await this.ticket();
      let connectionToken = token;
      const socket = new WebSocket(this.origin.replace(/^https:/, "wss:") + "/api/v1/ws");
      this.socket = socket;
      let authorized = false;
      socket.onclose = () => {
        if (socket !== this.socket) return;
        this.closeSocket();
        this.update({ ...offline, phase: "error", error: "The server connection closed. Reconnect to continue." });
      };
      socket.onmessage = ({ data }) => {
        if (socket !== this.socket) return;
        const reply = JSON.parse(data) as Reply;
        if (reply.type === "response") this.pending.get(reply.id)?.(reply);
        else if (authorized) this.event(reply);
      };
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("The server connection timed out.")), 8000);
        socket.onopen = () => { clearTimeout(timer); resolve(); };
        socket.onerror = () => { clearTimeout(timer); reject(new Error("Could not open the server connection.")); };
      });
      const state = await this.rpc<Snapshot>("connection.authenticate", { ticket, versions: [1] });
      authorized = true;
      this.showSnapshot(state);
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
      this.update({ ...offline, phase: "error", error: messageFrom(error) });
      throw error;
    }
  }

  /** Fetches direct messages queued while offline, then acknowledges them. */
  private async receiveQueued(socket: WebSocket) {
    try {
      for (let page = 0; page < directMessageLimit / 100; page++) {
        const queued = await this.rpc<DirectMessage[]>("direct.pending");
        if (socket !== this.socket) return;
        const account = this.snapshot?.account.id;
        const mine = queued.filter(({ recipientId }) => recipientId === account);
        for (const message of mine) this.addDirectMessage(message);
        if (mine.length) this.show();
        if (!mine.length) return;
        await this.rpc("direct.ack", { ids: mine.map(({ id }) => id) });
        if (queued.length < 100) return;
      }
    } catch {
      // Older servers do not queue direct messages.
    }
  }

  private addDirectMessage(message: DirectMessage) {
    if (this.directMessages.some(({ id }) => id === message.id)) return false;
    this.directMessages = [...this.directMessages, message].slice(-directMessageLimit);
    return true;
  }

  private rpc<T>(type: string, payload: unknown = {}): Promise<T> {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Connect to a server first."));
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
      socket.send(JSON.stringify({ version: 1, id, type, payload }));
    });
  }

  private showSnapshot(snapshot: Snapshot) {
    const previous = this.snapshot?.channelId;
    this.snapshot = snapshot;
    if (mobileApp() && voiceApp()) this.updateVoice(snapshot);
    if (previous !== snapshot.channelId) {
      this.messages = [];
      const request = ++this.historyRequest;
      this.deletedDuringHistory = snapshot.channelId ? new Set() : undefined;
      if (snapshot.channelId) {
        void this.rpc<Message[]>("message.history", { channelId: snapshot.channelId }).then((history) => {
          if (request !== this.historyRequest) return;
          const entries = new Map(history.reverse().map((message) => [message.id, message]));
          for (const message of this.messages) entries.set(message.id, message);
          for (const id of this.deletedDuringHistory ?? []) entries.delete(id);
          this.messages = [...entries.values()].slice(-200);
          this.show();
        }).catch(() => {}).finally(() => {
          if (request === this.historyRequest) this.deletedDuringHistory = undefined;
        });
      }
    }
    this.show();
  }

  private updateVoice(snapshot: Snapshot) {
    const { channelId, connectionId } = snapshot;
    if ((this.voice?.channelId ?? null) !== channelId) {
      this.voice?.close();
      this.voice = undefined;
      if (channelId) {
        const socket = this.socket;
        const audio = this.audio ??= new AudioContext();
        this.voice = new WebVoice(channelId, connectionId, audio, this.callAudio, (kind, payload) => {
          if (socket !== this.socket || this.snapshot?.channelId !== channelId) {
            return Promise.reject(new Error("The active channel changed."));
          }
          return this.rpc(kind, payload);
        }, () => this.show(), this.volumes);
      } else this.stopCallAudio();
    }
    this.voice?.update(snapshot);
  }

  private show() {
    this.update({ ...offline, phase: "online", snapshot: this.snapshot, messages: this.messages, directMessages: this.directMessages,
      directDeleted: this.directDeleted, lastPoke: this.lastPoke, voice: this.voice?.voice ?? "idle", voiceError: this.voice?.error ?? null });
  }

  private event({ type, payload }: Reply) {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    if (type.startsWith("media.")) this.voice?.event(type, payload as Parameters<WebVoice["event"]>[1]);
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
    } else if (type === "message.created") {
      const message = payload as Message;
      if (!message.channelId || message.channelId !== snapshot.channelId || this.messages.some(({ id }) => id === message.id)) return;
      this.messages = [...this.messages, message].slice(-200);
      this.show();
    } else if (type === "direct.created") {
      const message = payload as DirectMessage;
      if (message.senderId !== snapshot.account.id && message.recipientId !== snapshot.account.id) return;
      if (this.addDirectMessage(message)) this.show();
    } else if (type === "message.edited") {
      const edit = payload as { messageId: string; text: string; html?: string; editedAt: number };
      this.messages = this.messages.map((message) => message.id === edit.messageId
        ? { ...message, text: edit.text, html: edit.html, editedAt: edit.editedAt } : message);
      this.show();
    } else if (type === "direct.edited") {
      const edit = payload as Partial<DirectMessage> & Pick<DirectMessage, "id" | "senderId" | "recipientId" | "nonce" | "ciphertext" | "signature" | "editedAt">;
      if (edit.senderId !== snapshot.account.id && edit.recipientId !== snapshot.account.id) return;
      const known = this.directMessages.find(({ id, senderId, recipientId }) =>
        id === edit.id && senderId === edit.senderId && recipientId === edit.recipientId);
      // A packet loaded from history is not held here. Keep the edit so the conversation can apply it.
      const base = known ?? (edit.createdAt === undefined ? undefined : edit as DirectMessage);
      if (!base) return;
      const next = { ...base, nonce: edit.nonce, ciphertext: edit.ciphertext, signature: edit.signature, editedAt: edit.editedAt };
      this.directMessages = known ? this.directMessages.map((message) => message === known ? next : message)
        : [...this.directMessages, next].slice(-directMessageLimit);
      this.show();
    } else if (type === "direct.deleted") {
      const { id, senderId } = payload as { id: string; senderId: string };
      this.directMessages = this.directMessages.filter((message) => message.id !== id || message.senderId !== senderId);
      this.directDeleted = [...this.directDeleted, id].slice(-directMessageLimit);
      this.show();
    } else if (type === "direct.poked") {
      const poke = payload as Poke;
      if (poke.recipientId !== snapshot.account.id) return;
      this.lastPoke = poke;
      this.show();
    } else if (type === "message.deleted") {
      const { messageId } = payload as { messageId: string };
      this.deletedDuringHistory?.add(messageId);
      this.messages = this.messages.filter(({ id }) => id !== messageId);
      this.show();
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
    if (mobileApp() && voiceApp()) void (this.audio ??= new AudioContext()).resume().catch(() => {});
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

  async sendMessage(channelId: string, text: string, html?: string) {
    await this.rpc("message.send", { channelId, text, html });
  }

  async editMessage(messageId: string, text: string) {
    await this.rpc("message.edit", { messageId, text });
  }

  async deleteMessage(messageId: string) {
    await this.rpc("message.delete", { messageId });
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

  async saveChannel(payload: Record<string, unknown>) {
    const result = await this.rpc<{ state: Snapshot }>(payload.channelId ? "channel.edit" : "channel.create", payload);
    this.showSnapshot(result.state);
  }

  async deleteChannel(channelId: string) {
    await this.rpc("channel.delete", { channelId });
  }

  async memberAction({ kind, payload }: MemberRequest) {
    await this.rpc(kind, payload);
  }

  private stopCallAudio() {
    void this.callAudio.setMode("auto").catch(() => {});
    void this.audio?.close().catch(() => {});
    this.audio = undefined;
  }

  private closeSocket() {
    const socket = this.socket;
    this.socket = undefined;
    this.voice?.close();
    this.voice = undefined;
    this.stopCallAudio();
    this.snapshot = null;
    this.messages = [];
    this.directMessages = [];
    this.lastPoke = undefined;
    this.directDeleted = [];
    this.historyRequest++;
    this.deletedDuringHistory = undefined;
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

/**
 * Holds a session for each signed-in server. Requests that name a connection go to
 * the session that owns it. Others name the server origin.
 */
class BrowserSessions {
  private readonly sessions = new Map<string, BrowserSession>();
  private update: (origin: string, view: VoiceState) => void = () => {};

  watch(update: (origin: string, view: VoiceState) => void) {
    this.update = update;
    const visibility = () => {
      if (!document.hidden) for (const session of this.sessions.values()) session.resumeAudio();
    };
    if (mobileApp()) document.addEventListener("visibilitychange", visibility);
    return () => {
      this.update = () => {};
      if (mobileApp()) document.removeEventListener("visibilitychange", visibility);
    };
  }

  /** Replaces any session for this origin with a fresh, signed-out one. */
  async select(origin: string) {
    await this.disconnect(origin);
    const session: BrowserSession = new BrowserSession(origin, (view) => {
      if (this.sessions.get(origin) === session) this.update(origin, view);
    });
    this.sessions.set(origin, session);
    return session;
  }

  session(origin: string) {
    const session = this.sessions.get(origin);
    if (!session) throw new Error("Connect to a server first.");
    return session;
  }

  private connection(connectionId: string) {
    for (const session of this.sessions.values()) if (session.connectionId === connectionId) return session;
    throw new Error("The server connection changed.");
  }

  request(origin: string, path: string, body: unknown) {
    return this.session(origin).request(path, body);
  }

  fetch(request: Request) {
    const origin = new URL(request.url).origin;
    const session = this.sessions.get(origin);
    if (session) return session.fetch(request);
    const path = new URL(request.url).pathname;
    if (path === "/api/v1/server/info" || path === "/api/v1/server/capabilities") {
      return fetch(request, { signal: AbortSignal.timeout(8000), redirect: "error" });
    }
    throw new Error("The selected server changed.");
  }

  directRequest<T>(connectionId: string, kind: DirectOperation, payload: unknown) {
    try { return this.connection(connectionId).directRequest<T>(connectionId, kind, payload); }
    catch (error) { return Promise.reject(error); }
  }

  screenRequest<T>(connectionId: string, channelId: string, kind: string, payload: unknown) {
    try { return this.connection(connectionId).screenRequest<T>(connectionId, channelId, kind, payload); }
    catch (error) { return Promise.reject(error); }
  }

  /** Voice uses one call at a time, so joining a channel leaves any channel on another server. */
  async joinChannel(origin: string, channelId: string, password?: string) {
    const session = this.session(origin);
    for (const other of this.sessions.values()) {
      if (other !== session && other.channelId) await other.leaveChannel();
    }
    await session.joinChannel(channelId, password);
  }

  async disconnect(origin: string) {
    const session = this.sessions.get(origin);
    this.sessions.delete(origin);
    await session?.disconnect();
  }
}

export const browserSessions = new BrowserSessions();
