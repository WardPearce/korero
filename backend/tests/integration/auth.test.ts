import { expect, test } from "bun:test";
import { fixture, openSocket, testIdentity, type Device } from "../server";
import { LOBBY } from "../../src/database";

const base = "/api/v1/auth/";
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
