import { Elysia, t } from "elysia";
import { isIP, SocketAddress } from "node:net";
import type { Config } from "./config";
import type { Auth } from "./modules/auth";
import type { Media } from "./modules/media";
import type { Realtime } from "./modules/realtime";
import { httpBodies, id, version } from "./protocol";
import { errorResponse, fail, ProtocolError, RateLimit } from "./security/errors";
import { version as serverVersion } from "../package.json";

const normalizeIp = (address: string) => {
  const unwrapped = address.startsWith("::ffff:") && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
  return SocketAddress.parse(isIP(unwrapped) === 6 ? `[${unwrapped}]:0` : `${unwrapped}:0`)?.address ?? "unknown";
};

export function createApp(config: Config, auth: Auth, media: Media, realtime: Realtime, info: { serverId: string; fingerprint?: string }) {
  const upgrades = new RateLimit(config.limits.upgrades_per_minute);
  const authentication = new RateLimit(config.limits.auth_per_minute);
  const registration = new RateLimit(config.limits.registration_per_minute);
  const globalAuth = new RateLimit(Math.max(240, config.limits.auth_per_minute * 8), 1);
  const proxyIps = new Set(config.server.trusted_proxies.map(normalizeIp));
  const origins = new Set(config.server.origins);
  function source(request: Request, direct: string) {
    const forwarded = request.headers.get("x-forwarded-for");
    if (proxyIps.has(direct) && forwarded && isIP(forwarded.trim())) return normalizeIp(forwarded.trim());
    return direct;
  }
  const app = new Elysia({
    name: "voice-api",
    normalize: false,
    serve: { maxRequestBodySize: 8192, idleTimeout: 30 },
    websocket: { maxPayloadLength: config.limits.websocket_bytes,
      idleTimeout: 60, backpressureLimit: 262144, closeOnBackpressureLimit: true, perMessageDeflate: false },
  });
  const ip = (request: Request) => normalizeIp(app.server?.requestIP(request)?.address ?? "");
  const limit = (request: Request, register = false) => {
    const client = source(request, ip(request));
    (register ? registration : authentication).take(client);
    globalAuth.take("auth");
  };
  const bearer = (request: Request) => auth.access(request.headers.get("authorization"));
  return app
    .onRequest(({ request, set }) => {
      const path = new URL(request.url).pathname;
      if (path === "/health" || path === "/ready") return;
      if (config.tls.mode === "proxy" && !proxyIps.has(ip(request))) fail("FORBIDDEN");
      set.headers["cache-control"] = "no-store";
      set.headers["x-content-type-options"] = "nosniff";
      const origin = request.headers.get("origin");
      if (origin) {
        if (!origins.has(origin)) fail("FORBIDDEN");
        set.headers["access-control-allow-origin"] = origin;
        set.headers.vary = "Origin";
        if (request.method === "OPTIONS") {
          set.headers["access-control-allow-methods"] = "GET, POST, PATCH, DELETE, OPTIONS";
          set.headers["access-control-allow-headers"] = "authorization, content-type";
          return new Response(null, { status: 204, headers: set.headers as HeadersInit });
        }
      }
      if (path === "/api/v1/ws") upgrades.take(source(request, ip(request)));
    })
    .onError(({ code, error, set }) => {
      const response = code === "NOT_FOUND" ? errorResponse(new ProtocolError("NOT_FOUND")) :
        code === "VALIDATION" || code === "PARSE" ? { status: 400, error: { code: "INVALID_REQUEST", message: "Invalid request" } } : errorResponse(error);
      set.status = response.status;
      return { error: response.error };
    })
    .get("/health", () => ({ status: "ok" }))
    .get("/ready", ({ set }) => {
      if (!media.ready) set.status = 503;
      return { status: media.ready ? "ready" : "unavailable" };
    })
    .get("/api/v1/server/info", () => ({ ...info, name: config.server.name, version: serverVersion, protocolVersions: [version],
      registration: config.server.registration, setupRequired: !auth.hasOwner() }))
    .get("/api/v1/server/capabilities", ({ request }) => {
      const access = request.headers.get("authorization");
      if (access) bearer(request);
      return { protocolVersions: [version], websocketPath: "/api/v1/ws", audio: "opus", targetAudioBitrate: config.media.target_audio_bitrate,
        heartbeatSeconds: 25, maxWebSocketBytes: config.limits.websocket_bytes,
        udp: config.media.enable_udp, tcp: config.media.enable_tcp, textPersistence: config.messaging.persistence,
        ...(access ? { iceServers: config.media.ice_servers } : {}) };
    })
    .post("/api/v1/auth/register", ({ request, body, set }) => {
      limit(request, true);
      const result = auth.register(body.displayName.trim(), body.deviceName.trim(), body.invitation);
      set.status = 201;
      return result;
    }, { body: httpBodies.register })
    .post("/api/v1/auth/recover", ({ request, body }) => {
      limit(request);
      return auth.recover(body.recoveryCode, body.deviceName.trim());
    }, { body: httpBodies.recover })
    .post("/api/v1/auth/refresh", ({ request, body }) => {
      limit(request);
      return auth.refresh(body.refreshToken);
    }, { body: httpBodies.refresh })
    .post("/api/v1/auth/logout", ({ request }) => {
      const session = bearer(request);
      auth.revoke(session.accountId, session.id);
      return {};
    })
    .post("/api/v1/auth/logout-all", ({ request }) => {
      const session = bearer(request);
      auth.revoke(session.accountId);
      return {};
    })
    .post("/api/v1/auth/recovery-code/rotate", ({ request, body }) => {
      limit(request);
      return auth.rotateRecovery(bearer(request), body.recoveryCode, body.revokeOthers ?? true);
    }, { body: httpBodies.rotate })
    .post("/api/v1/auth/connection-ticket", ({ request }) => {
      limit(request);
      return auth.ticket(bearer(request));
    })
    .get("/api/v1/account", ({ request }) => auth.account(bearer(request).accountId))
    .patch("/api/v1/account", ({ request, body }) => auth.updateAccount(bearer(request).accountId, body.displayName.trim()), { body: httpBodies.account })
    .get("/api/v1/account/sessions", ({ request }) => auth.listSessions(bearer(request).accountId))
    .delete("/api/v1/account/sessions/:id", ({ request, params }) => {
      auth.revoke(bearer(request).accountId, params.id);
      return {};
    }, { params: t.Object({ id }) })
    .post("/api/v1/admin/bootstrap", ({ request, body, set }) => {
      limit(request);
      const result = auth.bootstrap(body.token, body.displayName.trim(), body.deviceName.trim());
      set.status = 201;
      return result;
    }, { body: httpBodies.bootstrap })
    .ws("/api/v1/ws", {
      open: (ws) => realtime.open(ws.id, ws),
      message: (ws, message) => realtime.receive(ws.id, message),
      close: (ws) => realtime.closed(ws.id),
    });
}

export type App = ReturnType<typeof createApp>;
