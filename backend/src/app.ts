import { Elysia, t } from "elysia";
import { isIP, SocketAddress } from "node:net";
import type { Config } from "./config";
import type { Auth } from "./modules/auth";
import type { Media } from "./modules/media";
import type { Realtime } from "./modules/realtime";
import { attachmentDataLength, auditQuery, bytesPerMiB, httpBodies, id, maxSupportedAttachmentMiB, payloads, version } from "./protocol";
import { errorResponse, fail, ProtocolError, RateLimit } from "./security/errors";
import { version as serverVersion } from "../package.json";

const normalizeIp = (address: string) => {
  const unwrapped = address.startsWith("::ffff:") && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
  return SocketAddress.parse(isIP(unwrapped) === 6 ? `[${unwrapped}]:0` : `${unwrapped}:0`)?.address ?? "unknown";
};

// Allow worst-case JSON escaping of the caption, formatting and filename.
const attachmentBodyLimit = (bytes: number) => attachmentDataLength(bytes) + 262144;

export function createApp(config: Config, auth: Auth, media: Media, realtime: Realtime, info: { serverId: string; fingerprint?: string }) {
  const upgrades = new RateLimit(config.limits.upgrades_per_minute);
  const authentication = new RateLimit(config.limits.auth_per_minute);
  const registration = new RateLimit(config.limits.registration_per_minute);
  const globalAuth = new RateLimit(Math.max(240, config.limits.auth_per_minute * 8), 1);
  const attachmentRequests = new RateLimit(config.limits.attachment_uploads_per_minute);
  const attachmentDownloads = new RateLimit(config.limits.attachment_downloads_per_minute);
  const connectionInfoRequests = new RateLimit(30);
  const attachmentUploadsInProgress = new Set<string>();
  const attachmentPath = "/api/v1/chat/attachments";
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
    serve: { maxRequestBodySize: attachmentBodyLimit(maxSupportedAttachmentMiB * bytesPerMiB), idleTimeout: 30 },
    websocket: { maxPayloadLength: config.limits.websocket_bytes,
      idleTimeout: 60, backpressureLimit: 262144, closeOnBackpressureLimit: true, perMessageDeflate: false },
  });
  const ip = (request: Request) => normalizeIp(app.server?.requestIP(request)?.address ?? "");
  const clientIp = (request: Request) => source(request, ip(request));
  const limit = (request: Request, register = false) => {
    const client = clientIp(request);
    (register ? registration : authentication).take(client);
    globalAuth.take("auth");
  };
  const bearer = (request: Request) => auth.access(request.headers.get("authorization"));
  const manageSettings = (request: Request) => realtime.authorize(bearer(request).accountId, "manageSettings");
  const manageInvitations = (request: Request) => realtime.authorize(bearer(request).accountId, "manageInvitations");
  const parseAttachment = async ({ request }: { request: Request }) => {
    const { accountId } = bearer(request);
    attachmentRequests.take(accountId);
    const limit = attachmentBodyLimit(realtime.maxAttachmentBytes);
    if (Number(request.headers.get("content-length")) > limit) realtime.attachmentTooLarge();
    if (attachmentUploadsInProgress.has(accountId) || attachmentUploadsInProgress.size >= config.limits.attachment_uploads_concurrent) fail("RATE_LIMITED");
    const reader = request.body?.getReader() ?? fail("INVALID_REQUEST");
    attachmentUploadsInProgress.add(accountId);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let length = 0;
    let body = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > limit) {
          void reader.cancel().catch(() => {});
          realtime.attachmentTooLarge();
        }
        body += decoder.decode(value, { stream: true });
      }
      return JSON.parse(body + decoder.decode());
    } finally {
      reader.releaseLock();
      attachmentUploadsInProgress.delete(accountId);
    }
  };
  return app
    .onRequest(({ request, set }) => {
      const path = new URL(request.url).pathname.replace(/\/$/, "");
      if (path === "/health" || path === "/ready") return;
      if (config.tls.mode === "proxy" && !proxyIps.has(ip(request))) fail("FORBIDDEN");
      set.headers["cache-control"] = "no-store";
      set.headers["x-content-type-options"] = "nosniff";
      const origin = request.headers.get("origin");
      if (origin && origin !== new URL(request.url).origin) {
        if (!origins.has(origin)) fail("FORBIDDEN");
        set.headers["access-control-allow-origin"] = origin;
        set.headers.vary = "Origin";
        if (request.method === "OPTIONS") {
          set.headers["access-control-allow-methods"] = "GET, POST, PATCH, DELETE, OPTIONS";
          set.headers["access-control-allow-headers"] = "authorization, content-type";
          return new Response(null, { status: 204, headers: set.headers as HeadersInit });
        }
      }
      if ((path !== attachmentPath || request.method !== "POST") && Number(request.headers.get("content-length")) > 393728) fail("LIMIT");
    })
    .onError(({ code, error, set }) => {
      const parseCause = code === "PARSE" && error.cause instanceof ProtocolError ? error.cause : undefined;
      const response = code === "NOT_FOUND" ? errorResponse(new ProtocolError("NOT_FOUND")) :
        code === "VALIDATION" || code === "PARSE" && !parseCause ? { status: 400, error: { code: "INVALID_REQUEST", message: "Invalid request" } } :
        errorResponse(parseCause ?? error);
      set.status = response.status;
      return { error: response.error };
    })
    .get("/health", () => ({ status: "ok" }))
    .get("/ready", ({ set }) => {
      if (!media.ready) set.status = 503;
      return { status: media.ready ? "ready" : "unavailable" };
    })
    .get("/api/v1/server/info", () => ({ ...info, name: config.server.name, version: serverVersion, protocolVersions: [version],
      registration: config.server.registration, setupRequired: !auth.hasOwner(), identityAuthentication: true,
      identityEnrollment: true, channelBackgrounds: true, serverAdministration: true, extendedServerAdministration: true,
      passwordRequired: auth.passwordRequired(),
      invitationPasswordBypass: true, bannerImageUrl: realtime.bannerImageUrl,
      screenSharing: true, richChat: true, channelAudioQuality: true,
      maxWebSocketBytes: config.limits.websocket_bytes, maxAttachmentBytes: realtime.maxAttachmentBytes }))
    .get("/api/v1/server/capabilities", ({ request }) => {
      const access = request.headers.get("authorization");
      if (access) bearer(request);
      return { protocolVersions: [version], websocketPath: "/api/v1/ws", audio: "opus", targetAudioBitrate: realtime.targetAudioBitrate,
        heartbeatSeconds: 25, maxWebSocketBytes: config.limits.websocket_bytes,
        udp: config.media.enable_udp, tcp: config.media.enable_tcp, textPersistence: config.messaging.persistence,
        ...(access ? { iceServers: config.media.ice_servers } : {}) };
    })
    .post("/api/v1/auth/identity/challenge", ({ request, body }) => {
      limit(request);
      return auth.challengeIdentity(info.serverId, body.operation, body.publicKey, body.deviceName, body.origin);
    }, { body: httpBodies.identityChallenge })
    .post("/api/v1/auth/identity/login", ({ request, body }) => {
      limit(request);
      return auth.loginIdentity(info.serverId, body.id, body.signature, body.password);
    }, { body: httpBodies.identityProof })
    .post("/api/v1/auth/register", async ({ request, body, set }) => {
      limit(request, true);
      const identity = auth.proveEnrollment(info.serverId, "register", body.deviceName, body.identity);
      const result = await auth.register(body.displayName.trim(), body.deviceName.trim(), identity, body.invitation, body.password);
      set.status = 201;
      return result;
    }, { body: httpBodies.register })
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
    .post("/api/v1/auth/connection-ticket", ({ request }) => {
      limit(request);
      return auth.ticket(bearer(request));
    })
    .get("/api/v1/account", ({ request }) => auth.account(bearer(request).accountId))
    .get("/api/v1/connections/:id", ({ request, params }) => {
      const session = bearer(request);
      connectionInfoRequests.take(session.accountId);
      return realtime.connectionInfo(session, params.id);
    }, {
      params: t.Object({ id }),
      response: { 200: t.Object({
        displayName: t.String(), channelName: t.Nullable(t.String()),
        connectedSeconds: t.Integer({ minimum: 0 }), latencyMs: t.Nullable(t.Integer({ minimum: 0 })),
      }, { additionalProperties: false }) },
    })
    .post(attachmentPath, ({ request, body }) => realtime.uploadAttachment(bearer(request), body), {
      body: httpBodies.attachmentUpload,
      parse: parseAttachment,
    })
    .get("/api/v1/chat/attachments/:messageId", ({ request, params, query }) => {
      const session = bearer(request);
      attachmentDownloads.take(session.accountId);
      return realtime.downloadAttachment(session, query.connectionId, params.messageId);
    }, { params: t.Object({ messageId: id }), query: t.Object({ connectionId: id }) })
    .patch("/api/v1/account", ({ request, body }) => auth.updateAccount(bearer(request).accountId, body.displayName.trim()), { body: httpBodies.account })
    .get("/api/v1/account/sessions", ({ request }) => auth.listSessions(bearer(request).accountId))
    .delete("/api/v1/account/sessions/:id", ({ request, params }) => {
      auth.revoke(bearer(request).accountId, params.id);
      return {};
    }, { params: t.Object({ id }) })
    .post("/api/v1/admin/bootstrap", ({ request, body, set }) => {
      limit(request);
      const identity = auth.proveEnrollment(info.serverId, "bootstrap", body.deviceName, body.identity);
      const result = auth.bootstrap(body.token, body.displayName.trim(), body.deviceName.trim(), identity);
      set.status = 201;
      return result;
    }, { body: httpBodies.bootstrap })
    .get("/api/v1/admin/accounts", ({ request, query }) => realtime.listAccounts(bearer(request).accountId, query.after),
      { query: t.Object({ after: t.Optional(id) }) })
    .patch("/api/v1/admin/badges", ({ request, body }) =>
      realtime.setBadge(bearer(request).accountId, body.accountId, body.badge), { body: httpBodies.accountBadge })
    .patch("/api/v1/admin/roles", ({ request, body }) => {
      realtime.setRole(auth.account(bearer(request).accountId), body.accountId, body.role);
      return { role: body.role };
    }, { body: payloads["role.set"] })
    .post("/api/v1/admin/roles", ({ request, body }) =>
      realtime.defineRole(bearer(request).accountId, body.name.trim(), body.permissions, true), { body: httpBodies.roleDefinition })
    .patch("/api/v1/admin/roles/definition", ({ request, body }) =>
      realtime.defineRole(bearer(request).accountId, body.name.trim(), body.permissions, false), { body: httpBodies.roleDefinition })
    .delete("/api/v1/admin/roles/definition", ({ request, body }) =>
      realtime.deleteRole(bearer(request).accountId, body.name.trim()), { body: httpBodies.deleteRole })
    .get("/api/v1/admin/audit", ({ request, query }) =>
      realtime.listAudit(bearer(request).accountId, query), { query: auditQuery })
    .get("/api/v1/admin/preferences", ({ request }) => realtime.serverPreferences(bearer(request).accountId))
    .patch("/api/v1/admin/preferences", ({ request, body }) =>
      realtime.saveServerPreferences(bearer(request).accountId, body), { body: httpBodies.serverPreferences })
    .patch("/api/v1/admin/banner", ({ request, body }) =>
      realtime.setBanner(bearer(request).accountId, body.bannerImageUrl), { body: httpBodies.serverBanner })
    .patch("/api/v1/channels/order", ({ request, body }) =>
      realtime.reorderChannel(bearer(request).accountId, body), { body: httpBodies.channelOrder })
    .get("/api/v1/admin/invitations", ({ request }) => ({ invitations: auth.invitations(manageInvitations(request), false) }))
    .post("/api/v1/admin/invitations", ({ request, body: { expiresInSeconds, uses, expiresAt } }) =>
      auth.invitation(manageInvitations(request), expiresInSeconds, uses, expiresAt),
      { body: payloads["invitation.create"] })
    .patch("/api/v1/admin/invitations/:id", ({ request, params, body }) =>
      auth.updateInvitation(manageInvitations(request), params.id, body),
      { params: t.Object({ id }), body: httpBodies.invitationUpdate })
    .delete("/api/v1/admin/invitations/:id", ({ request, params }) => {
      auth.revokeInvitation(manageInvitations(request), params.id);
      return {};
    }, { params: t.Object({ id }) })
    .get("/api/v1/admin/password", ({ request }) => {
      manageSettings(request);
      return { passwordRequired: auth.passwordRequired(), passwordLocked: auth.passwordLocked };
    })
    .patch("/api/v1/admin/password", ({ request, body }) => {
      const authorize = () => manageSettings(request);
      authorize();
      return auth.setServerPassword(authorize, body.password);
    }, { body: httpBodies.serverPassword })
    .ws("/api/v1/ws", {
      upgrade: ({ request }) => { upgrades.take(clientIp(request)); },
      open: (ws) => realtime.open(ws.id, ws, source(ws.data.request, normalizeIp(ws.remoteAddress))),
      message: (ws, message) => realtime.receive(ws.id, message),
      close: (ws) => realtime.closed(ws.id),
    });
}

export type App = ReturnType<typeof createApp>;
