import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkServerIdentity } from "node:tls";
import { generateKeyPairSync, sign, X509Certificate } from "node:crypto";
import { endpoint } from "../src/config";
import { fingerprint } from "../src/security/tls";

export type Device = {
  account: { id: string; displayName: string; role: string };
  sessionId: string;
  accessToken: string;
  refreshToken: string;
};
export type Snapshot = {
  connectionId: string;
  channelId: string | null;
  channels: { id: string; parentId: string | null; name: string }[];
  members: { connectionId: string; accountId: string; adminMuted: boolean }[];
};
type Failure = { status: number; payload: { error: { code: string; message: string } } };
type Event = { type: string; payload: Record<string, unknown> };
const cli = resolve(import.meta.dir, "../src/index.ts");
export const testIdentity = () => generateKeyPairSync("ed25519");

function freePort() {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = server;
  server.stop(true);
  return port;
}

export async function until<T>(method: () => Promise<T> | T, predicate: (value: T) => boolean, milliseconds = 6000) {
  const deadline = performance.now() + milliseconds;
  let last: unknown;
  do {
    try { const value = await method(); if (predicate(value)) return value; }
    catch (error) { last = error; }
    await Bun.sleep(40);
  } while (performance.now() < deadline);
  throw new Error("Timed out waiting for condition", { cause: last });
}

export function trusted(ca: string, expected = fingerprint(ca)) {
  return { ca, checkServerIdentity(host: string, cert: Parameters<typeof checkServerIdentity>[1]) {
    const parsed = new X509Certificate(cert.raw);
    if (fingerprint(parsed.toString()) !== expected) return new Error("Unexpected server key");
    return checkServerIdentity(host.replace(/^\[|\]$/g, ""), cert);
  } };
}

export async function fixture(options: {
  host?: string; ip?: string; port?: number; environment?: Record<string, string>; binary?: string; directory?: string; cleanup?: boolean; dockerImage?: string;
} = {}) {
  const directory = options.directory ?? await mkdtemp(join(tmpdir(), "voice-test-"));
  const port = options.port ?? freePort();
  let mediaPort = freePort();
  while (port === mediaPort) mediaPort = freePort();
  const ip = options.ip ?? "127.0.0.1";
  const origin = `https://${endpoint(ip, port)}`;
  const defaultEnv = { ...process.env, VOICE_DATA_DIR: directory, VOICE_SERVER_HOST: options.host ?? "::",
    VOICE_SERVER_PORT: String(port), VOICE_MEDIA_PORT: String(mediaPort),
    VOICE_MEDIA_LISTEN_IPS: JSON.stringify([ip]), VOICE_SERVER_ORIGINS: JSON.stringify([origin]),
    VOICE_LIMITS_AUTH_PER_MINUTE: "200", VOICE_LIMITS_REGISTRATION_PER_MINUTE: "100", ...options.environment };
  const name = `voice-e2e-${crypto.randomUUID().slice(0, 12)}`;
  const dockerArgs = options.dockerImage ? ["docker", "run", "--rm", "--name", name, "--volume", `${name}:/data`,
    "--publish", `127.0.0.1:${port}:${port}/tcp`, "--publish", `127.0.0.1:${mediaPort}:${mediaPort}/udp`,
    "--publish", `127.0.0.1:${mediaPort}:${mediaPort}/tcp`,
    ...[["VOICE_SERVER_PORT", String(port)], ["VOICE_MEDIA_PORT", String(mediaPort)], ["VOICE_MEDIA_ANNOUNCED_ADDRESS", "127.0.0.1"],
      ["VOICE_SERVER_ORIGINS", JSON.stringify([origin])]].flatMap(([key, value]) => ["--env", `${key}=${value}`]), options.dockerImage] : null;
  const command = dockerArgs ?? (options.binary ? [resolve(options.binary)] : [process.execPath, cli]);
  const server = Bun.spawn(command, { env: defaultEnv, stdin: "ignore", stdout: "pipe", stderr: "inherit" });
  let setupToken = "";
  const output = (async () => {
    let pending = "";
    for await (const chunk of server.stdout.pipeThrough(new TextDecoderStream())) {
      if (setupToken) continue;
      pending += chunk;
      setupToken = pending.match(/^(?:ADMIN SETUP TOKEN\r?\n  |First-owner setup token .*?: )([A-Za-z0-9_-]{43})\r?$/m)?.[1] ?? "";
      pending = pending.slice(-256);
    }
  })();
  const stop = async () => {
    if (dockerArgs) {
      await Bun.spawn(["docker", "stop", "--time", "4", name], { stdout: "ignore", stderr: "ignore" }).exited;
      await Bun.spawn(["docker", "volume", "rm", name], { stdout: "ignore", stderr: "ignore" }).exited;
    } else server.kill("SIGTERM");
    const result = await Promise.race([server.exited, Bun.sleep(4000).then(() => null)]);
    if (result === null) { server.kill("SIGKILL"); await server.exited; }
    await output;
    if (result !== 0) throw new Error(`Server exit status: ${result}`);
  };
  const cleanup = async () => {
    try { await stop(); }
    finally { if (options.cleanup ?? !options.directory) await rm(directory, { recursive: true, force: true }); }
  };
  try {
    const ca = await until<string>(async () => {
      if (server.exitCode !== null) throw new Error("Server exited before readiness");
      let pem: string;
      if (dockerArgs) {
        const child = Bun.spawn(["docker", "exec", name, "awk", "/BEGIN CERTIFICATE/{p=1}p", "/data/identity/tls.pem"],
          { stdout: "pipe", stderr: "ignore" });
        pem = await new Response(child.stdout).text();
        if (await child.exited) return "";
      } else {
        pem = (await Bun.file(join(directory, "identity", "tls.pem")).text()).match(/-----BEGIN CERTIFICATE-----[\s\S]+/)?.[0] ?? "";
      }
      if (!pem) return "";
      const response = await fetch(origin + "/ready", { tls: trusted(pem) });
      return response.ok ? pem : "";
    }, Boolean);
    const tls = trusted(ca);
    async function call<T>(path: string, body?: unknown, access?: string, method = body === undefined ? "GET" : "POST") {
      const response = await fetch(origin + path, { method, tls, body: body === undefined ? undefined : JSON.stringify(body),
        headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(access ? { authorization: `Bearer ${access}` } : {}) } });
      return { response, payload: await response.json() as T };
    }
    async function proof(operation: "login" | "register" | "bootstrap", identity: ReturnType<typeof testIdentity>, deviceName = "Test") {
      const publicKey = identity.publicKey.export({ format: "jwk" }).x!;
      const { response, payload } = await call<{ id: string; serverId: string; binding: string; expiresAt: number }>(
        "/api/v1/auth/identity/challenge", { operation, publicKey, deviceName, origin },
      );
      if (!response.ok) throw new Error("Could not obtain an identity challenge");
      const { id, serverId, binding, expiresAt } = payload;
      const transcript = ["korero-identity-v1", serverId, origin, operation, id, publicKey, binding, deviceName, expiresAt];
      return { id, signature: sign(null, Buffer.from(JSON.stringify(transcript)), identity.privateKey).toString("base64url") };
    }
    return { directory, port, mediaPort, origin, ca, tls, command, defaultEnv, setupToken, stop, cleanup, call, proof,
      async register(name: string, identity = testIdentity()) {
        return (await call<Device>("/api/v1/auth/register", {
          displayName: name, deviceName: "Test", identity: await proof("register", identity),
        })).payload;
      },
      async owner(identity = testIdentity()) {
        return (await call<Device>("/api/v1/admin/bootstrap", {
          displayName: "Owner", deviceName: "Test", token: setupToken, identity: await proof("bootstrap", identity),
        })).payload;
      },
      async ws(device: Device) {
        const { payload } = await call<{ ticket: string }>("/api/v1/auth/connection-ticket", {}, device.accessToken);
        const socket = await openSocket(origin, tls);
        const state = await socket.rpc<Snapshot>("connection.authenticate", { ticket: payload.ticket, versions: [1] });
        return { ...socket, state };
      },
      async fail(path: string, body?: unknown, access?: string, method?: string): Promise<Failure> {
        const { response, payload } = await call<Failure["payload"]>(path, body, access, method);
        return { status: response.status, payload };
      },
    };
  } catch (error) { await cleanup().catch(() => {}); throw error; }
}

export async function openSocket(origin: string, tls: ReturnType<typeof trusted>, headers?: Record<string, string>, path = "/api/v1/ws") {
  const raw = new (WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket)(origin.replace("https:", "wss:") + path, { tls, headers: headers ?? {} });
  const received: Event[] = [];
  const callbacks = new Map<number, (data: { success: boolean; payload?: unknown; error?: { code: string } }) => void>();
  let nextId = 0;
  const closed = new Promise<CloseEvent>((resolve) => raw.addEventListener("close", resolve, { once: true }));
  raw.addEventListener("message", (message) => {
    const data = JSON.parse(String(message.data));
    if (data.type === "response") callbacks.get(data.id)?.(data);
    else received.push(data);
  });
  await Promise.race([
    new Promise<void>((resolve, reject) => {
      raw.addEventListener("open", () => resolve(), { once: true });
      raw.addEventListener("error", () => reject(new Error("WebSocket upgrade failed")), { once: true });
      raw.addEventListener("close", () => reject(new Error("WebSocket closed before opening")), { once: true });
    }),
    Bun.sleep(3000).then(() => { throw new Error("WebSocket upgrade timeout"); }),
  ]);
  const rpc = async <T = Record<string, never>>(type: string, payload: unknown = {}, id = ++nextId): Promise<T> => {
    const message = JSON.stringify({ version: 1, id, type, payload });
    try {
      return await Promise.race([
        new Promise<T>((resolve, reject) => {
          callbacks.set(id, (data) => data.success ? resolve(data.payload as T) : reject(new Error(data.error?.code)));
          raw.send(message);
        }),
        closed.then(({ code }) => { throw new Error(`WebSocket closed ${code}`); }),
        Bun.sleep(5000).then(() => { throw new Error(`No response for ${type}`); }),
      ]);
    } finally { callbacks.delete(id); }
  };
  return { raw, rpc, received, closed, close: () => raw.close() };
}
