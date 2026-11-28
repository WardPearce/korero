export type ServerSocket = Pick<WebSocket, "readyState" | "send" | "close"> & {
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
};

export interface Transport {
  fetch(input: string | Request, init: RequestInit & { timeout: number }): Promise<Response>;
  openSocket(url: string): ServerSocket;
}

export const webTransport: Transport = {
  fetch(input, { timeout, signal, ...options }) {
    const deadline = AbortSignal.timeout(timeout);
    return fetch(input, { ...options, redirect: "error", signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
  },
  openSocket(url) {
    return new WebSocket(url) as unknown as ServerSocket;
  },
};

function hasExplicitPort(source: string) {
  const authority = source.slice(source.indexOf("//") + 2).split(/[/?#]/, 1)[0] ?? "";
  return authority.startsWith("[") ? authority.includes("]:") : authority.includes(":");
}

export function serverOrigin(address: string) {
  const value = address.trim();
  const source = value.includes("://") ? value : `https://${value}`;
  let url: URL | undefined;
  try { url = new URL(source); } catch {}
  if (!url || url.protocol !== "https:" || !url.host || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Enter a server IP or host, with an optional port (default 8443).");
  }
  if (!url.port && !hasExplicitPort(source)) url.port = "8443";
  return url.origin;
}
