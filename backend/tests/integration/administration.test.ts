import { expect, test } from "bun:test";
import { join } from "node:path";
import { fixture, testIdentity, type Device, type Snapshot } from "../server";

test("identity enrollment, role hierarchy, and server administration are enforced by the API", async () => {
  const server = await fixture();
  try {
    const identity = testIdentity();
    const member = await server.register("Operator", identity);
    expect(member.account.role).toBe("Member");
    expect((await server.fail("/api/v1/admin/accounts", undefined, member.accessToken)).status).toBe(403);
    const owner = await server.owner(identity);
    expect(owner.account).toMatchObject({ id: member.account.id, role: "Owner" });

    const aliceIdentity = testIdentity();
    const alice = await server.register("Alice", aliceIdentity);
    const roles = "/api/v1/admin/roles";
    expect((await server.fail(roles, { accountId: owner.account.id, role: "Member" }, owner.accessToken, "PATCH")).status).toBe(403);
    const grant = await server.call(roles, { accountId: alice.account.id, role: "Administrator" }, owner.accessToken, "PATCH");
    expect(grant.response.status).toBe(200);
    expect((await server.fail(roles, { accountId: owner.account.id, role: "Member" }, alice.accessToken, "PATCH")).status).toBe(403);
    const accounts = await server.call("/api/v1/admin/accounts", undefined, alice.accessToken);
    expect(accounts.payload).toMatchObject({ accounts: expect.arrayContaining([{ id: owner.account.id,
      displayName: "Operator", role: "Owner", editable: false }]) });

    const configPath = "/api/v1/admin/configuration";
    const file = join(server.directory, "server.toml");
    const { payload: configuration } = await server.call<{ toml: string; revision: string }>(configPath, undefined, alice.accessToken);
    const save = (toml: string) => server.call(configPath, { toml, revision: configuration.revision }, alice.accessToken, "PATCH");
    expect((await save("this is not TOML")).response.status).toBe(400);
    expect(await Bun.file(file).text()).toBe(configuration.toml);
    const updated = configuration.toml.replace("Voice Server", "New name");
    expect((await save(updated)).response.status).toBe(200);
    expect(await Bun.file(file).text()).toBe(updated);
    expect((await save(updated + "\n# stale")).response.status).toBe(409);

    const passwordPath = "/api/v1/admin/password";
    expect((await server.call(passwordPath, { password: "private phrase" }, alice.accessToken, "PATCH")).payload)
      .toEqual({ passwordRequired: true });
    const publicInfo = await server.call("/api/v1/server/info");
    expect(publicInfo.payload).toMatchObject({ passwordRequired: true });
    const loginPath = "/api/v1/auth/identity/login";
    expect((await server.fail(loginPath, await server.proof("login", aliceIdentity))).status).toBe(401);
    const login = await server.call<Device>(loginPath, { ...await server.proof("login", aliceIdentity), password: "private phrase" });
    expect(login.payload.account.role).toBe("Administrator");
    const registration = await server.fail("/api/v1/auth/register", { displayName: "Bobby", deviceName: "Test",
      identity: await server.proof("register", testIdentity()), password: "incorrect" });
    expect(registration.status).toBe(401);
    expect((await server.call(passwordPath, { password: null }, alice.accessToken, "PATCH")).payload)
      .toEqual({ passwordRequired: false });
    expect((await server.call(loginPath, await server.proof("login", aliceIdentity))).response.status).toBe(200);
  } finally { await server.cleanup(); }
});

test("custom role grants, server presentation, and channel order are enforced and shared", async () => {
  const server = await fixture();
  try {
    const owner = await server.owner();
    const admin = await server.register("Administrator");
    const member = await server.register("Listener");
    const roles = "/api/v1/admin/roles";
    await server.call(roles, { accountId: admin.account.id, role: "Administrator" }, owner.accessToken, "PATCH");
    const role = { name: "Listener", permissions: ["join", "manageRoles"] };
    expect((await server.fail(roles, role, member.accessToken)).status).toBe(403);
    expect((await server.call(roles, role, admin.accessToken)).payload).toEqual(role);
    expect((await server.fail(roles, { ...role, name: "administrator" }, admin.accessToken)).status).toBe(409);
    expect((await server.call(roles, { accountId: member.account.id, role: role.name }, admin.accessToken, "PATCH")).response.status).toBe(200);
    expect((await server.fail(roles, { ...role, name: "Other role" }, member.accessToken)).status).toBe(403);
    expect((await server.fail(roles, { accountId: admin.account.id, role: "Guest" }, member.accessToken, "PATCH")).status).toBe(403);

    const adminWs = await server.ws(admin);
    const memberWs = await server.ws(member);
    const { channelId: first } = await adminWs.rpc<{ channelId: string }>("channel.create", { name: "First" });
    const { channelId: second } = await adminWs.rpc<{ channelId: string }>("channel.create", { name: "Second" });
    const { channelId: child } = await adminWs.rpc<{ channelId: string }>("channel.create", { name: "Child", parentId: first });
    const order = "/api/v1/channels/order";
    const move = { channelId: second, targetId: first, placement: "before" };
    expect((await server.fail(order, move, member.accessToken, "PATCH")).status).toBe(403);
    expect((await server.fail(order, { ...move, targetId: child }, admin.accessToken, "PATCH")).status).toBe(409);
    expect((await server.call(order, move, admin.accessToken, "PATCH")).response.status).toBe(200);
    const state = await memberWs.rpc<Snapshot & { serverPermissions: string[] }>("state.get");
    expect(state.channels.filter(({ parentId }) => parentId === null).map(({ id }) => id).slice(0, 2)).toEqual([second, first]);
    expect(state.serverPermissions).toEqual(role.permissions);
    expect((await server.call(roles + "/definition", { ...role, permissions: ["join", "text"] }, admin.accessToken, "PATCH")).response.status).toBe(200);
    expect(await memberWs.rpc("state.get")).toMatchObject({ serverPermissions: ["join", "text"] });

    const banner = "/api/v1/admin/banner";
    const image = { bannerImageUrl: "https://example.test/banner.jpg" };
    expect((await server.fail(banner, image, member.accessToken, "PATCH")).status).toBe(403);
    expect((await server.call(banner, image, admin.accessToken, "PATCH")).payload).toEqual(image);
    expect((await server.call("/api/v1/server/info")).payload).toMatchObject(image);
    expect(await memberWs.rpc("state.get")).toMatchObject(image);
    await server.call(banner, { bannerImageUrl: null }, admin.accessToken, "PATCH");
    expect(await memberWs.rpc("state.get")).toMatchObject({ bannerImageUrl: null });
    adminWs.raw.close();
    memberWs.raw.close();
  } finally { await server.cleanup(); }
});

test("invitations accept an exact expiration date and enforce a custom user limit", async () => {
  const server = await fixture({ environment: { VOICE_SERVER_REGISTRATION: "invitation" } });
  try {
    const owner = await server.owner();
    const path = "/api/v1/admin/invitations";
    const expiresAt = Date.now() + 3 * 86400000;
    const { payload } = await server.call<{ token: string; expiresAt: number; usesLeft: number }>(path,
      { expiresAt, uses: 2 }, owner.accessToken);
    expect(payload).toMatchObject({ expiresAt, usesLeft: 2 });
    expect((await server.fail(path, { expiresAt: Date.now() - 1000 }, owner.accessToken)).status).toBe(400);
    const register = async (displayName: string) => server.call("/api/v1/auth/register", {
      displayName, deviceName: "Test", identity: await server.proof("register", testIdentity()), invitation: payload.token,
    });
    expect((await register("Alice")).response.status).toBe(201);
    expect((await register("Bobby")).response.status).toBe(201);
    expect((await register("Carol")).response.status).toBe(401);
  } finally { await server.cleanup(); }
});
