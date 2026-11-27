import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export interface CertificateContact { origin: string; fingerprint: string; publiclyTrusted: boolean }

type SocketEvent = { id: number; type: "open" | "message" | "error" | "close"; data?: string; code?: number; reason?: string };

/**
 * Android sends server traffic natively, like the desktop main process, so a private
 * certificate can be pinned and requests are not subject to WebView CORS.
 */
export const androidTransport = registerPlugin<{
  inspect(options: { origin: string }): Promise<CertificateContact>;
  allow(options: { origin: string; fingerprint: string | null }): Promise<void>;
  request(options: { origin: string; method: string; path: string; headers: Record<string, string>; body?: string; timeout: number }):
    Promise<{ status: number; headers: Record<string, string>; body: string }>;
  open(options: { url: string }): Promise<{ id: number }>;
  send(options: { id: number; data: string }): Promise<void>;
  close(options: { id: number }): Promise<void>;
  addListener(event: "socket", listener: (event: SocketEvent) => void): Promise<PluginListenerHandle>;
}>("ServerTransport");

export function nativeTransport() {
  return Capacitor.getPlatform() === "android";
}

const emptyBody = new Set([101, 204, 205, 304]);

/** Sends a server request. Headers in `init` replace those on the request. */
export async function serverFetch(input: string | Request, init: RequestInit & { timeout: number }): Promise<Response> {
  const { timeout, ...options } = init;
  if (!nativeTransport()) return fetch(input, { ...options, redirect: "error", signal: AbortSignal.timeout(timeout) });
  const request = new Request(input, options);
  const url = new URL(request.url);
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
  const reply = await androidTransport.request({
    origin: url.origin, path: url.pathname + url.search, method: request.method,
    headers: Object.fromEntries(request.headers.entries()), body, timeout,
  });
  return new Response(emptyBody.has(reply.status) ? null : reply.body, { status: reply.status, headers: reply.headers });
}

const sockets = new Map<number, NativeSocket>();
let listening: Promise<unknown> | undefined;

/** The WebSocket members the browser session uses, backed by the native transport. */
class NativeSocket {
  readyState: WebSocket["readyState"] = WebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  private id?: Promise<number>;

  constructor(url: string) {
    listening ??= androidTransport.addListener("socket", (event) => sockets.get(event.id)?.receive(event));
    this.id = listening.then(() => androidTransport.open({ url })).then(({ id }) => {
      if (this.readyState === WebSocket.CLOSED) void androidTransport.close({ id });
      else sockets.set(id, this);
      return id;
    });
    this.id.catch(() => this.receive({ id: -1, type: "error" }).receive({ id: -1, type: "close" }));
  }

  private receive(event: SocketEvent) {
    if (this.readyState === WebSocket.CLOSED) return this;
    if (event.type === "open") {
      this.readyState = WebSocket.OPEN;
      this.onopen?.();
    } else if (event.type === "message") this.onmessage?.({ data: event.data ?? "" });
    else if (event.type === "error") this.onerror?.();
    else {
      this.readyState = WebSocket.CLOSED;
      sockets.delete(event.id);
      this.onclose?.();
    }
    return this;
  }

  send(data: string) {
    if (this.readyState !== WebSocket.OPEN) throw new Error("The server connection closed.");
    // Frames go out in order because the bridge handles calls in sequence.
    void this.id!.then((id) => androidTransport.send({ id, data })).catch(() => {});
  }

  close() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSING;
    void this.id!.then((id) => androidTransport.close({ id })).catch(() => {});
  }
}

export type ServerSocket = Pick<WebSocket, "readyState" | "send" | "close"> & {
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
};

export function openServerSocket(url: string): ServerSocket {
  return nativeTransport() ? new NativeSocket(url) : new WebSocket(url) as unknown as ServerSocket;
}
