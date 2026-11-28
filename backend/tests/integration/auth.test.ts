import { expect, test } from "bun:test";
import { fixture, openSocket, testIdentity, type Device } from "../server";
import { LOBBY } from "../../src/database";

const base = "/api/v1/auth/";

test("login challenges echo the requested origin and verify the enrolled origin after proof", async () => {
  const server = await fixture();
  try {
    const enrolled = testIdentity();
    const member = await server.register("Existing member", enrolled);
    const alternate = `https://localhost:${server.port}`;
    for (const identity of [enrolled, testIdentity()]) {
      const { response, payload } = await server.call<{ origin: string }>(base + "identity/challenge", {
        operation: "login", publicKey: identity.publicKey.export({ format: "jwk" }).x!,
        deviceName: "Test", origin: alternate,
      });
      expect(response.status).toBe(200);
      expect(payload.origin).toBe(alternate);
    }
    const differentOrigin = await server.proof("login", enrolled, "Test", alternate);
    expect((await server.fail(base + "identity/login", differentOrigin)).status).toBe(401);
    const sameOrigin = await server.proof("login", enrolled);
    expect((await server.call<Device>(base + "identity/login", sameOrigin)).payload.account.id).toBe(member.account.id);
  } finally { await server.cleanup(); }
});

test("valid refresh and ticket issuance have capacity after the public authentication quota is used", async () => {
  const server = await fixture({ environment: { VOICE_LIMITS_AUTH_PER_MINUTE: "4" } });
  try {
    const user = await server.register("Existing member");
    let status = 0;
    for (let index = 0; index < 4; index++) {
      status = (await server.fail(base + "refresh", { refreshToken: "A".repeat(43) })).status;
    }
    expect(status).toBe(429);
    const refreshed = await server.call<Device>(base + "refresh", { refreshToken: user.refreshToken });
    expect(refreshed.response.status).toBe(200);
    expect(await server.ws(refreshed.payload)).toHaveProperty("state.connectionId");
  } finally { await server.cleanup(); }
});

test("pending identity challenges are limited per source and consumed proofs release capacity", async () => {
  const server = await fixture({ environment: { VOICE_SERVER_TRUSTED_PROXIES: '["127.0.0.1"]' } });
  try {
    const key = testIdentity();
    const user = await server.register("Existing member", key);
    const proof = await server.proof("login", key);
    const body = { operation: "login", publicKey: key.publicKey.export({ format: "jwk" }).x!,
      deviceName: "Test", origin: server.origin };
    for (let index = 0; index < 15; index++) {
      expect((await server.fail(base + "identity/challenge", body)).status).toBe(200);
    }
    expect((await server.fail(base + "identity/challenge", body)).status).toBe(429);
    const anotherSource = await fetch(server.origin + base + "identity/challenge", {
      method: "POST", tls: server.tls, body: JSON.stringify(body),
      headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.10" },
    });
    expect(anotherSource.status).toBe(200);
    expect((await server.call<Device>(base + "identity/login", proof)).payload.account.id).toBe(user.account.id);
    expect((await server.fail(base + "identity/challenge", body)).status).toBe(200);
  } finally { await server.cleanup(); }
});

test("enrollment binds the key to the account and each sign-in requires a fresh proof", async () => {
  const server = await fixture();
  try {
    await server.owner();
    const key = testIdentity();
    const deviceName = "Imported identity";
    expect((await server.fail(base + "register", { displayName: "New member", deviceName })).status).toBe(400);
    expect((await server.fail(base + "identity/login", await server.proof("login", key))).status).toBe(404);
    for (const displayName of ["abc", "a".repeat(33)]) {
      expect((await server.fail(base + "register", {
        displayName, deviceName, identity: await server.proof("register", key, deviceName),
      })).status).toBe(400);
    }
    const created = await server.call<Device>(base + "register", {
      displayName: "New member", deviceName, identity: await server.proof("register", key, deviceName),
    });
    expect(created.response.status).toBe(201);
    expect(created.payload).not.toHaveProperty("recoveryCode");
    await server.call(base + "logout", {}, created.payload.accessToken);
    const wrongKeyProof = await server.proof("login", { publicKey: key.publicKey, privateKey: testIdentity().privateKey });
    expect((await server.fail(base + "identity/login", wrongKeyProof)).status).toBe(401);
    const loginProof = await server.proof("login", key, "Another device");
    const loggedIn = await server.call<Device>(base + "identity/login", loginProof);
    expect(loggedIn.response.status).toBe(200);
    expect(loggedIn.payload.account).toEqual(created.payload.account);
    expect((await server.fail(base + "identity/login", loginProof)).status).toBe(401);
    expect((await server.fail(base + "recover", { recoveryCode: "invalid", deviceName })).status).toBe(404);
    expect((await server.fail("/api/v1/account/identity", loginProof, loggedIn.payload.accessToken)).status).toBe(404);
  } finally { await server.cleanup(); }
}, 10000);

test("owner bootstrap is atomic and replay revokes a live session after concurrent refreshes", async () => {
  const server = await fixture({ environment: { VOICE_AUTHENTICATION_REFRESH_RETRY_SECONDS: "1" } });
  try {
    const request = { token: server.setupToken, displayName: "Owner", deviceName: "Setup" };
    expect((await server.fail("/api/v1/admin/bootstrap", request)).status).toBe(400);
    const competing = await Promise.all([0, 1].map(async () => server.call<Device>("/api/v1/admin/bootstrap", {
      ...request, identity: await server.proof("bootstrap", testIdentity(), request.deviceName),
    })));
    expect(competing.map(({ response }) => response.status).sort()).toEqual([201, 404]);
    const user = await server.register("Duplicate display name");
    const second = await server.register("Duplicate display name");
    expect(second.account.id).not.toBe(user.account.id);
    const ws = await server.ws(user);
    await ws.rpc("channel.join", { channelId: LOBBY });

    const concurrent = await Promise.all([0, 1].map(() => server.call<Device>(base + "refresh", { refreshToken: user.refreshToken })));
    expect(concurrent.map(({ response }) => response.status)).toEqual([200, 200]);
    expect(concurrent[0]!.payload).toEqual(concurrent[1]!.payload);
    const rotated = concurrent[0]!.payload;
    expect(rotated.refreshToken).not.toBe(user.refreshToken);
    expect((await server.fail("/api/v1/account", undefined, user.accessToken)).status).toBe(401);

    await Bun.sleep(1050);
    expect((await server.fail(base + "refresh", { refreshToken: user.refreshToken })).status).toBe(401);
    expect((await ws.closed).code).toBe(4401);
    expect((await server.fail(base + "refresh", { refreshToken: rotated.refreshToken })).status).toBe(401);
  } finally { await server.cleanup(); }
}, 10000);

test("invitations are single-use, expirable, revocable and required in admin registration", async () => {
  const server = await fixture({ environment: { VOICE_SERVER_REGISTRATION: "admin" } });
  try {
    const owner = await server.owner();
    const ws = await server.ws(owner);
    const register = async (invitation?: string) => server.call(base + "register", {
      displayName: "User", deviceName: "Device", invitation, identity: await server.proof("register", testIdentity(), "Device"),
    });
    expect((await register()).response.status).toBe(401);
    const invitation = await ws.rpc<{ token: string }>("invitation.create", { uses: 1 });
    const requests = await Promise.all([0, 1].map(() => register(invitation.token)));
    expect(requests.map(({ response }) => response.status).sort()).toEqual([201, 401]);
    const revoked = await ws.rpc<{ id: string; token: string }>("invitation.create");
    await ws.rpc("invitation.revoke", { invitationId: revoked.id });
    expect((await register(revoked.token)).response.status).toBe(401);
    const expiring = await ws.rpc<{ id: string; token: string }>("invitation.create", { expiresInSeconds: 1 });
    const listed = await ws.rpc<{ id: string }[]>("invitation.list");
    expect(listed[0]?.id).toBe(expiring.id);
    expect(listed[0]).not.toHaveProperty("token");
    expect(listed[0]).not.toHaveProperty("digest");
    await Bun.sleep(1050);
    expect((await register(expiring.token)).response.status).toBe(401);
    expect(await ws.rpc("invitation.update", { invitationId: expiring.id, expiresAt: null, usesLeft: 1 }))
      .toMatchObject({ id: expiring.id, expiresAt: null, usesLeft: 1 });
    expect((await register(expiring.token)).response.status).toBe(201);
    ws.close();
  } finally { await server.cleanup(); }
});

test("connection ticket is single-use, bound to a session, short-lived and origin-checked", async () => {
  const server = await fixture({ ip: "::1", environment: { VOICE_AUTHENTICATION_TICKET_SECONDS: "2" } });
  try {
    const user = await server.register("User");
    const issue = async () => (await server.call<{ ticket: string }>(base + "connection-ticket", {}, user.accessToken)).payload.ticket;
    const first = await issue();
    const client = await openSocket(server.origin, server.tls);
    await client.rpc("connection.authenticate", { ticket: first, versions: [1] });
    const other = await openSocket(server.origin, server.tls);
    await expect(other.rpc("connection.authenticate", { ticket: first, versions: [1] })).rejects.toThrow("AUTH_FAILED");
    const next = await issue();
    await client.rpc("connection.renew", { ticket: next });
    await expect(openSocket(server.origin, server.tls, { origin: "https://untrusted.example" })).rejects.toThrow();
    const expires = await issue();
    await Bun.sleep(2050);
    const late = await openSocket(server.origin, server.tls);
    await expect(late.rpc("connection.authenticate", { ticket: expires, versions: [1] })).rejects.toThrow("AUTH_FAILED");
    const revoked = await issue();
    await server.call(base + "logout", {}, user.accessToken);
    expect((await client.closed).code).toBe(4401);
    const after = await openSocket(server.origin, server.tls);
    await expect(after.rpc("connection.authenticate", { ticket: revoked, versions: [1] })).rejects.toThrow("AUTH_FAILED");
  } finally { await server.cleanup(); }
}, 10000);

test("access tokens expire independently and device sessions enforce expiry", async () => {
  const server = await fixture({ environment: { VOICE_AUTHENTICATION_ACCESS_SECONDS: "1", VOICE_AUTHENTICATION_REFRESH_SECONDS: "3",
    VOICE_AUTHENTICATION_REFRESH_RETRY_SECONDS: "1" } });
  try {
    const user = await server.register("Short lifetime");
    const ws = await server.ws(user);
    await Bun.sleep(1100);
    expect((await server.fail("/api/v1/account", undefined, user.accessToken)).status).toBe(401);
    expect(await ws.rpc("heartbeat")).toHaveProperty("time");
    const fresh = await server.call<Device>(base + "refresh", { refreshToken: user.refreshToken });
    expect(fresh.response.status).toBe(200);
    expect(await ws.rpc("heartbeat")).toHaveProperty("time");
    const closed = await ws.closed;
    expect(closed.code).toBe(4401);
    expect((await server.fail(base + "refresh", { refreshToken: fresh.payload.refreshToken })).status).toBe(401);
  } finally { await server.cleanup(); }
}, 12000);

test("accounts carry every role they hold, ordered by rank", async () => {
  const server = await fixture();
  try {
    const newcomer = await server.register("Newcomer");
    expect(newcomer.account).toMatchObject({ role: "Member", roles: ["Member"] });
    expect((await server.call<Device["account"]>("/api/v1/account", undefined, newcomer.accessToken)).payload.roles).toEqual(["Member"]);

    const owner = await server.owner();
    expect(owner.account).toMatchObject({ role: "Owner", roles: ["Owner", "Member"] });

    await server.call("/api/v1/admin/roles", { name: "Visitor", permissions: ["join"] }, owner.accessToken);
    expect((await server.call("/api/v1/admin/preferences", { defaultRole: "Visitor" }, owner.accessToken, "PATCH")).response.status).toBe(200);
    const visitor = await server.register("Visitor account");
    expect(visitor.account).toMatchObject({ role: "Visitor", roles: ["Visitor", "Guest"] });
  } finally { await server.cleanup(); }
});

test("bootstrapping an existing account adds Owner without dropping its roles", async () => {
  const server = await fixture();
  try {
    const identity = testIdentity();
    await server.register("Promoted", identity);
    const owner = await server.owner(identity);
    expect(owner.account).toMatchObject({ role: "Owner", roles: ["Owner", "Member"] });
  } finally { await server.cleanup(); }
});
