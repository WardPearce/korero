import { expect, test } from "bun:test";
import { fixture, openSocket, type Device } from "../server";
import { LOBBY } from "../../src/database";

const base = "/api/v1/auth/";
test("owner bootstrap is atomic, sessions rotate concurrently, recovery and replay revoke live access", async () => {
  const server = await fixture({ environment: { VOICE_AUTHENTICATION_REFRESH_RETRY_SECONDS: "1" } });
  try {
    const request = { token: server.setupToken, displayName: "Owner", deviceName: "Setup" };
    const competing = await Promise.all([0, 1].map(() => server.call<Device>("/api/v1/admin/bootstrap", request)));
    expect(competing.map(({ response }) => response.status).sort()).toEqual([201, 404]);
    const user = await server.register("Duplicate display name");
    const second = await server.register("Duplicate display name");
    expect(second.account.id).not.toBe(user.account.id);
    const invalid = await server.fail(base + "recover", { recoveryCode: "bad", deviceName: "Other" });
    expect(invalid.status).toBe(401);
    const recovered = (await server.call<Device>(base + "recover", { recoveryCode: user.recoveryCode.toLowerCase(), deviceName: "Other" })).payload;
    expect(recovered.account.id).toBe(user.account.id);
    expect(recovered).not.toHaveProperty("recoveryCode");
    const ws = await server.ws(recovered);
    await ws.rpc("channel.join", { channelId: LOBBY });

    const concurrent = await Promise.all([0, 1].map(() => server.call<Device>(base + "refresh", { refreshToken: user.refreshToken })));
    expect(concurrent.map(({ response }) => response.status)).toEqual([200, 200]);
    expect(concurrent[0]!.payload).toEqual(concurrent[1]!.payload);
    const rotated = concurrent[0]!.payload;
    expect(rotated.refreshToken).not.toBe(user.refreshToken);
    expect((await server.fail("/api/v1/account", undefined, user.accessToken)).status).toBe(401);
    const rotation = (await server.call<{ recoveryCode: string }>(base + "recovery-code/rotate",
      { recoveryCode: user.recoveryCode }, rotated.accessToken)).payload;
    expect(rotation.recoveryCode).not.toBe(user.recoveryCode);
    expect((await ws.closed).code).toBe(4401);
    expect((await server.fail(base + "recover", { recoveryCode: user.recoveryCode, deviceName: "Other" })).status).toBe(401);
    expect((await server.call<Device>(base + "recover", { recoveryCode: rotation.recoveryCode, deviceName: "New" })).payload.account.id).toBe(user.account.id);

    await Bun.sleep(1050);
    expect((await server.fail(base + "refresh", { refreshToken: user.refreshToken })).status).toBe(401);
    expect((await server.fail(base + "refresh", { refreshToken: rotated.refreshToken })).status).toBe(401);
  } finally { await server.cleanup(); }
}, 10000);

test("invitations are single-use, expirable, revocable and required in admin registration", async () => {
  const server = await fixture({ environment: { VOICE_SERVER_REGISTRATION: "admin" } });
  try {
    const owner = await server.owner();
    const ws = await server.ws(owner);
    const invalid = await server.fail(base + "register", { displayName: "User", deviceName: "Device" });
    expect(invalid.status).toBe(401);
    const invitation = await ws.rpc<{ token: string }>("invitation.create", { uses: 1 });
    const requests = await Promise.all([0, 1].map(() => server.call(base + "register",
      { displayName: "User", deviceName: "Device", invitation: invitation.token })));
    expect(requests.map(({ response }) => response.status).sort()).toEqual([201, 401]);
    const revoked = await ws.rpc<{ id: string; token: string }>("invitation.create");
    await ws.rpc("invitation.revoke", { invitationId: revoked.id });
    expect((await server.fail(base + "register", { displayName: "User", deviceName: "Device", invitation: revoked.token })).status).toBe(401);
    const expiring = await ws.rpc<{ id: string; token: string }>("invitation.create", { expiresInSeconds: 1 });
    const listed = await ws.rpc<{ id: string }[]>("invitation.list");
    expect(listed[0]?.id).toBe(expiring.id);
    expect(listed[0]).not.toHaveProperty("token");
    expect(listed[0]).not.toHaveProperty("digest");
    await Bun.sleep(1050);
    expect((await server.fail(base + "register", { displayName: "User", deviceName: "Device", invitation: expiring.token })).status).toBe(401);
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
