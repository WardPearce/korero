import { X509Certificate } from "node:crypto";
import { Agent, request } from "node:https";
import { isIP } from "node:net";
import { checkServerIdentity, connect, getCACertificates } from "node:tls";
import WebSocket from "ws";

const timeout = 8000;
const roots = [...new Set([...getCACertificates("default"), ...getCACertificates("system")])];

export function remoteError(error, fallback = "Server rejected the request") {
  return new Error(`${error?.code ?? "SIGNALING_ERROR"}: ${error?.message ?? fallback}`);
}

export function requireSuccess({ status, body }) {
  if (status >= 200 && status < 300) return body;
  throw remoteError(body?.error, `Request failed with HTTP ${status}`);
}

export function serverOrigin(address) {
  if (typeof address !== "string") throw new Error("Enter a valid server address.");
  const value = address.trim();
  const origin = URL.parse(value.includes("://") ? value : `https://${value}`);
  if (!origin || origin.protocol !== "https:" || !origin.hostname || origin.username || origin.password ||
      origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("Enter a server IP or host, with an optional port.");
  }
  return origin.origin;
}

export async function inspectServer(address) {
  const origin = serverOrigin(address);
  const url = new URL(origin);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  // The probe only inspects the TLS handshake. Every HTTP and WebSocket request uses a verified agent.
  const certificate = await new Promise((resolve, reject) => {
    const socket = connect({
      host, port: Number(url.port || 443), servername: isIP(host) ? undefined : host,
      ca: roots, rejectUnauthorized: false, signal: AbortSignal.timeout(timeout),
    });
    socket.once("error", reject);
    socket.once("secureConnect", () => {
      const leaf = socket.getPeerCertificate();
      socket.destroy();
      if (!leaf?.raw) reject(new Error("The server did not present a certificate."));
      else resolve({ leaf: new X509Certificate(leaf.raw), trusted: socket.authorized && !checkServerIdentity(host, leaf) });
    });
  });
  const info = { origin, fingerprint: certificate.leaf.fingerprint256, publiclyTrusted: certificate.trusted };
  return { info, certificate: certificate.leaf };
}

export class Server {
  constructor({ info, certificate }, fingerprint) {
    if (fingerprint == null ? !info.publiclyTrusted : fingerprint !== info.fingerprint) {
      throw new Error("Review the server certificate before connecting.");
    }
    this.origin = info.origin;
    this.agent = new Agent({
      keepAlive: true, maxCachedSessions: 0, rejectUnauthorized: true, minVersion: "TLSv1.2",
      ca: info.publiclyTrusted ? roots : [certificate.toString()],
      allowPartialTrustChain: !info.publiclyTrusted,
      checkServerIdentity(host, leaf) {
        return checkServerIdentity(host, leaf) ??
          (fingerprint && leaf.fingerprint256 !== fingerprint ? new Error("The server certificate changed.") : undefined);
      },
    });
  }

  http(method, path, body, token, signal) {
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin || !url.pathname.startsWith("/api/v1/")) throw new Error("Invalid API path.");
    const payload = body == null ? undefined : JSON.stringify(body);
    const headers = { accept: "application/json" };
    if (payload !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(payload);
    }
    if (token) headers.authorization = `Bearer ${token}`;
    const attachment = url.pathname === "/api/v1/chat/attachments" || url.pathname.startsWith("/api/v1/chat/attachments/");
    const limit = attachment ? 120000 : timeout;
    // The server supports attachments up to 32 MiB, sent as base64 JSON.
    const maxResponseBytes = (attachment ? 48 : 16) * 1024 * 1024;
    const deadline = AbortSignal.timeout(limit);
    return new Promise((resolve, reject) => {
      const outgoing = request(url, {
        headers, method, agent: this.agent, signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      }, async (response) => {
        try {
          const chunks = [];
          let size = 0;
          for await (const chunk of response) {
            size += chunk.length;
            if (size > maxResponseBytes) throw new Error("The server response is too large.");
            chunks.push(chunk);
          }
          const data = Buffer.concat(chunks, size).toString("utf8");
          resolve({ status: response.statusCode, body: data ? JSON.parse(data) : null });
        } catch (error) {
          reject(error);
        }
      });
      outgoing.once("error", reject);
      outgoing.end(payload);
    });
  }

  socket(maxBytes, onEvent, onClose) {
    return new Wire(this.origin.replace(/^https:/, "wss:") + "/api/v1/ws", this.agent, maxBytes, onEvent, onClose);
  }

  close() { this.agent.destroy(); }
}

class Wire {
  #pending = new Map();
  #id = 0;
  #failure;

  constructor(url, agent, maxBytes, onEvent, onClose) {
    const socket = new WebSocket(url, { agent, maxPayload: 256 * 1024, handshakeTimeout: timeout, perMessageDeflate: false });
    this.socket = socket;
    this.maxBytes = maxBytes;
    this.opened = Promise.withResolvers();
    socket.once("open", () => this.opened.resolve());
    const fail = (error) => {
      if (this.#failure) return;
      this.#failure = error;
      this.opened.reject(error);
      for (const { finish } of this.#pending.values()) finish(error);
      onClose(this, error);
    };
    socket.on("error", fail);
    socket.once("close", (code, reason) => fail(new Error(`Server closed signaling (${code}): ${reason}`)));
    socket.on("message", (data, binary) => {
      let frame;
      try { if (!binary) frame = JSON.parse(data.toString()); } catch {}
      if (frame?.version !== 1 || typeof frame.type !== "string") {
        fail(new Error("Server sent an invalid signaling message."));
        this.close();
        return;
      }
      if (frame.type === "response") {
        this.#pending.get(frame.id)?.finish(frame.success === true ? null : remoteError(frame.error), frame.payload);
      } else {
        onEvent(this, frame);
      }
    });
  }

  async rpc(type, payload = {}) {
    await this.opened.promise;
    if (this.#failure || this.socket.readyState !== WebSocket.OPEN) throw this.#failure ?? new Error("The server connection closed.");
    if (this.#pending.size >= 128) throw new Error("Too many pending server requests.");
    const id = ++this.#id;
    const data = JSON.stringify({ version: 1, id, type, payload });
    if (Buffer.byteLength(data) > this.maxBytes) throw new Error("Request exceeds the server's message limit.");
    return new Promise((resolve, reject) => {
      const finish = (error, response) => {
        if (!this.#pending.delete(id)) return;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(response);
      };
      const timer = setTimeout(() => finish(new Error("The server request timed out.")), timeout);
      this.#pending.set(id, { finish });
      this.socket.send(data, (error) => { if (error) finish(error); });
    });
  }

  close() {
    if (this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate();
  }
}
