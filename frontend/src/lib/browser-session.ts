import { offline, requestError, messageFrom, type MemberRequest, type RelayResponse, type Snapshot, type VoiceState } from "./client";

type Credentials = { accessToken: string; refreshToken: string; accessExpiresAt: number };
type Reply = { type: string; id: number; success: boolean; payload: unknown; error?: unknown };

export function browserServerOrigin(address: string) {
  const value = address.trim();
  const url = URL.parse(value.includes("://") ? value : `https://${value}`);
  if (!url || url.protocol !== "https:" || !url.host || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Enter a server IP or host, with an optional port.");
  }
  return url.origin;
}

class BrowserSession {
  private origin = "";
  private credentials?: Credentials;
  private refresh?: Promise<void>;
  private socket?: WebSocket;
  private heartbeat?: ReturnType<typeof setInterval>;
  private nextId = 0;
  private pending = new Map<number, (reply: Reply | null) => void>();
  private update: (view: VoiceState) => void = () => {};

  watch(update: (view: VoiceState) => void) {
    this.update = update;
    return () => { this.update = () => {}; };
  }

  async select(origin: string) {
    await this.disconnect();
    this.origin = origin;
  }

  async request(origin: string, path: string, body: unknown): Promise<RelayResponse> {
    if (origin !== this.origin) throw new Error("The selected server changed.");
    const response = await this.post(path, body);
    const result = await response.json();
    if (response.ok && path !== "/api/v1/auth/identity/challenge") {
      if (origin !== this.origin) throw new Error("The selected server changed.");
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
    const origin = new URL(request.url).origin;
    if (origin !== this.origin) throw new Error("The selected server changed.");
    const headers = new Headers(request.headers);
    const path = new URL(request.url).pathname;
    if (path !== "/api/v1/server/info" && path !== "/api/v1/server/capabilities") {
      const token = await this.accessToken();
      if (origin !== this.origin) throw new Error("The selected server changed.");
      headers.set("authorization", `Bearer ${token}`);
    }
    return fetch(request, { headers, signal: AbortSignal.timeout(8000), redirect: "error" });
  }

  private async ticket() {
    const token = await this.accessToken();
    const response = await this.post("/api/v1/auth/connection-ticket", {}, token);
    const result = await response.json();
    if (!response.ok) throw requestError({ value: result });
    return { ticket: result.ticket as string, token };
  }

  async start() {
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
        if (authorized && ["state.invalidated", "presence.changed", "presence.offline", "channel.member"].includes(reply.type)) {
          void this.rpc<Snapshot>("state.get").then((state) => this.showSnapshot(state)).catch(() => {});
        }
      };
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("The server connection timed out.")), 8000);
        socket.onopen = () => { clearTimeout(timer); resolve(); };
        socket.onerror = () => { clearTimeout(timer); reject(new Error("Could not open the server connection.")); };
      });
      const state = await this.rpc<Snapshot>("connection.authenticate", { ticket, versions: [1] });
      authorized = true;
      this.showSnapshot(state);
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
    this.update({ ...offline, phase: "online", snapshot });
  }

  async saveChannel(payload: Record<string, unknown>) {
    const result = await this.rpc<{ state: Snapshot }>(payload.channelId ? "channel.edit" : "channel.create", payload);
    this.showSnapshot(result.state);
  }

  async memberAction({ kind, payload }: MemberRequest) {
    await this.rpc(kind, payload);
  }

  private closeSocket() {
    const socket = this.socket;
    this.socket = undefined;
    clearInterval(this.heartbeat);
    socket?.close();
    for (const settle of this.pending.values()) settle(null);
  }

  async disconnect() {
    this.closeSocket();
    const token = this.credentials?.accessToken;
    this.credentials = undefined;
    this.update(offline);
    if (token) await this.post("/api/v1/auth/logout", undefined, token).catch(() => {});
  }
}

export const browserSession = new BrowserSession();
