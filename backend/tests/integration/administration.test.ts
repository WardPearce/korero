import { expect, test } from "bun:test";
import { join } from "node:path";
import { fixture, testIdentity, until, type Device, type Snapshot } from "../server";
import { LOBBY } from "../../src/database";

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
    const configuration = await Bun.file(file).text();
    expect((await server.fail(configPath, undefined, owner.accessToken)).status).toBe(404);
    expect((await server.fail(configPath, { toml: configuration + "\n# change" }, owner.accessToken, "PATCH")).status).toBe(404);
    expect(await Bun.file(file).text()).toBe(configuration);

    const passwordPath = "/api/v1/admin/password";
    expect((await server.call(passwordPath, undefined, alice.accessToken)).payload)
      .toEqual({ passwordRequired: false, passwordLocked: false });
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

test("the host password is enforced at startup and stays read-only in the admin API", async () => {
  const password = "fixture host password";
  const server = await fixture({ environment: { VOICE_SERVER_PASSWORD: password } });
  try {
    const key = testIdentity();
    const owner = await server.owner(key);
    const passwordPath = "/api/v1/admin/password";
    expect((await server.call(passwordPath, undefined, owner.accessToken)).payload)
      .toEqual({ passwordRequired: true, passwordLocked: true });
    expect((await server.fail(passwordPath, { password: null }, owner.accessToken, "PATCH")).status).toBe(403);
    expect((await server.fail(passwordPath, { password: "replacement" }, owner.accessToken, "PATCH")).status).toBe(403);
    const loginPath = "/api/v1/auth/identity/login";
    expect((await server.fail(loginPath, await server.proof("login", key))).status).toBe(401);
    expect((await server.call(loginPath, { ...await server.proof("login", key), password })).response.status).toBe(200);
    const registerPath = "/api/v1/auth/register";
    const registration = async () => ({
      displayName: "Listener", deviceName: "Test", identity: await server.proof("register", testIdentity()),
    });
    expect((await server.fail(registerPath, await registration())).status).toBe(401);
    expect((await server.call(registerPath, { ...await registration(), password })).response.status).toBe(201);
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

test("channel moves preserve subtrees and enforce destination permissions and depth", async () => {
  const server = await fixture();
  try {
    const owner = await server.owner();
    const admin = await server.register("Administrator");
    const member = await server.register("Listener");
    await server.call("/api/v1/admin/roles", { accountId: admin.account.id, role: "Administrator" }, owner.accessToken, "PATCH");
    const ownerWs = await server.ws(owner);
    const adminWs = await server.ws(admin);
    const memberWs = await server.ws(member);
    const create = async (name: string, parentId?: string, temporary?: boolean) =>
      (await ownerWs.rpc<{ channelId: string }>("channel.create", { name, parentId, temporary })).channelId;
    const source = await create("Source");
    const child = await create("Child", source);
    const destination = await create("Destination");
    const sibling = await create("Existing child", destination);
    const temporary = await create("Temporary", undefined, true);
    const order = (channelId: string, targetId: string, placement: string, parentId?: string | null) =>
      server.call("/api/v1/channels/order", { channelId, targetId, placement, parentId }, admin.accessToken, "PATCH");

    expect((await order(source, child, "inside")).response.status).toBe(409);
    expect((await order(source, child, "after", source)).response.status).toBe(409);
    expect((await order(source, temporary, "inside")).response.status).toBe(409);
    expect((await order(LOBBY, destination, "inside")).response.status).toBe(403);
    expect((await order(source, sibling, "after", null)).response.status).toBe(409);
    const override = (channelId: string, role: string, permission: string, allow: boolean) =>
      ownerWs.rpc("channel.override", { channelId, role, permission, allow });
    await override(destination, "Administrator", "editChannels", false);
    await override(sibling, "Administrator", "editChannels", true);
    expect((await order(source, sibling, "before", destination)).response.status).toBe(403);
    await override(destination, "Administrator", "editChannels", true);

    await override(destination, "Member", "join", false);
    await memberWs.rpc("channel.join", { channelId: child });
    expect((await order(source, destination, "inside")).response.status).toBe(200);
    await until(() => memberWs.received.some(({ type, payload }) => type === "channel.changed" && payload.channelId === null), Boolean);
    const getState = () => adminWs.rpc<Snapshot>("state.get");
    const nested = await getState();
    expect(nested.channels.filter(({ parentId }) => parentId === destination).map(({ id }) => id)).toEqual([sibling, source]);
    expect(nested.channels.find(({ id }) => id === child)?.parentId).toBe(source);

    await override(destination, "Administrator", "editChannels", false);
    await override(source, "Administrator", "editChannels", true);
    expect((await order(source, LOBBY, "before", null)).response.status).toBe(403);
    await expect(adminWs.rpc("channel.edit", { channelId: source, parentId: null })).rejects.toThrow("FORBIDDEN");
    await override(destination, "Administrator", "editChannels", true);

    const editor = await server.register("Channel editor");
    const roles = "/api/v1/admin/roles";
    expect((await server.call(roles, { name: "Editor", permissions: ["join", "editChannels"] }, owner.accessToken)).response.status).toBe(200);
    await server.call(roles, { accountId: editor.account.id, role: "Editor" }, owner.accessToken, "PATCH");
    const editorWs = await server.ws(editor);
    expect((await server.fail("/api/v1/channels/order", { channelId: source, targetId: destination, placement: "before", parentId: null },
      editor.accessToken, "PATCH")).status).toBe(403);
    await expect(editorWs.rpc("channel.edit", { channelId: source, parentId: null })).rejects.toThrow("FORBIDDEN");
    await expect(memberWs.rpc("channel.join", { channelId: child })).rejects.toThrow("FORBIDDEN");

    expect((await order(source, destination, "before", null)).response.status).toBe(200);
    const roots = (await getState()).channels.filter(({ parentId }) => parentId === null).map(({ id }) => id);
    expect(roots[roots.indexOf(destination) - 1]).toBe(source);
    let deepest = destination;
    for (let depth = 1; depth <= 14; depth++) deepest = await create(`Level ${depth}`, deepest);
    expect((await order(source, deepest, "inside")).response.status).toBe(409);
    expect((await order(source, sibling, "before", destination)).response.status).toBe(200);
    expect((await getState()).channels.filter(({ parentId }) => parentId === destination).map(({ id }) => id))
      .toEqual([source, sibling, expect.any(String)]);
  } finally { await server.cleanup(); }
});

test("live server preferences and paged audit history enforce role permissions", async () => {
  const server = await fixture();
  try {
    const owner = await server.owner();
    const member = await server.register("Existing member");
    const audit = "/api/v1/admin/audit";
    const settings = "/api/v1/admin/preferences";
    const roles = "/api/v1/admin/roles";
    const save = (body: Record<string, unknown>) => server.call(settings, body, owner.accessToken, "PATCH");
    const remove = (name: string) => server.call(roles + "/definition", { name }, owner.accessToken, "DELETE");
    expect((await server.fail(audit, undefined, member.accessToken)).status).toBe(403);
    expect((await server.fail(settings, undefined, member.accessToken)).status).toBe(403);
    expect((await save({ defaultRole: "Administrator" })).response.status).toBe(403);
    expect((await save({ defaultAudioBitrate: 128001 })).response.status).toBe(400);
    expect((await save({ maxAttachmentMiB: 33 })).response.status).toBe(400);
    expect((await server.fail(settings, { maxAttachmentMiB: 8 }, member.accessToken, "PATCH")).status).toBe(403);

    const ownerWs = await server.ws(owner);
    const { channelId } = await ownerWs.rpc<{ channelId: string }>("channel.create", { name: "Studio", audioBitrate: 128000 });
    const listener = { name: "Listener", permissions: ["join"] };
    expect((await server.call(roles, listener, owner.accessToken)).response.status).toBe(200);
    await ownerWs.rpc("channel.override", { channelId, role: listener.name, permission: "editChannels", allow: true });
    expect((await save({ defaultRole: listener.name })).response.status).toBe(403);
    await ownerWs.rpc("channel.override", { channelId, role: listener.name, permission: "editChannels", allow: null });
    expect((await save({ defaultRole: listener.name, motd: " Hello!\nVoice meetup tonight. ", defaultAudioBitrate: 40000 })).payload)
      .toMatchObject({ defaultRole: listener.name, motd: "Hello!\nVoice meetup tonight.", defaultAudioBitrate: 40000 });
    expect((await remove(listener.name)).response.status).toBe(409);
    expect((await server.call(roles + "/definition", { ...listener, permissions: ["join", "kick"] }, owner.accessToken, "PATCH")).response.status).toBe(409);
    await expect(ownerWs.rpc("channel.override", { channelId, role: listener.name, permission: "editChannels", allow: true }))
      .rejects.toThrow("CONFLICT");
    expect(await ownerWs.rpc("state.get")).toMatchObject({
      motd: "Hello!\nVoice meetup tonight.", targetAudioBitrate: 40000,
      channels: expect.arrayContaining([expect.objectContaining({ id: channelId, audioBitrate: 128000 })]),
    });
    expect((await server.call("/api/v1/server/capabilities")).payload).toMatchObject({ targetAudioBitrate: 40000 });
    expect((await server.call("/api/v1/account", undefined, member.accessToken)).payload).toMatchObject({ role: "Member" });
    const registered = await server.register("New listener");
    expect(registered.account.role).toBe(listener.name);
    const socket = await server.ws(registered);
    await socket.rpc("channel.join", { channelId });
    await socket.rpc("channel.join", { channelId });
    await socket.rpc("channel.leave");
    socket.close();
    await socket.closed;
    const query = <T>(path = audit) => server.call<T>(path, undefined, owner.accessToken);
    type EventPage = { events: { action: string; id: number }[]; next: number | null };
    expect((await query<EventPage>(`${audit}?prefix=voice&actorId=${registered.account.id}`)).payload).toMatchObject({
      events: [
        { action: "voice.left", actorName: "New listener", targetName: "Studio", targetId: channelId },
        { action: "voice.joined", actorName: "New listener", targetName: "Studio", targetId: channelId },
      ], next: null,
    });
    await until(async () => (await query<EventPage>(`${audit}?prefix=connection&actorId=${registered.account.id}`)).payload.events,
      (events) => events.some(({ action }) => action === "connection.closed"));

    await save({ defaultRole: "Member", defaultAudioBitrate: null, motd: "" });
    expect((await remove(listener.name)).response.status).toBe(409);
    await server.call(roles, { accountId: registered.account.id, role: "Member" }, owner.accessToken, "PATCH");
    expect((await remove(listener.name)).response.status).toBe(200);
    expect(await ownerWs.rpc("state.get")).toMatchObject({ motd: "", targetAudioBitrate: 48000 });
    for (let index = 0; index < 101; index++) {
      const updated = await server.call("/api/v1/account", { displayName: `Name ${index}` }, member.accessToken, "PATCH");
      expect(updated.response.status).toBe(200);
    }
    const filter = `${audit}?actorId=${member.account.id}&prefix=account`;
    const first = (await query<EventPage>(filter)).payload;
    expect(first.events).toHaveLength(100);
    expect(first.next).toBe(first.events.at(-1)?.id ?? null);
    const second = (await query<EventPage>(`${filter}&before=${first.next}`)).payload;
    expect(second.events.map(({ action }) => action)).toEqual(["account.profile_changed", "account.registered"]);
    expect(second.next).toBeNull();
  } finally { await server.cleanup(); }
});

test("invitation links bypass the registration password and honor updated limits and deletion", async () => {
  const server = await fixture({ environment: { VOICE_SERVER_REGISTRATION: "invitation" } });
  try {
    const owner = await server.owner();
    const path = "/api/v1/admin/invitations";
    const password = "private phrase";
    await server.call("/api/v1/admin/password", { password }, owner.accessToken, "PATCH");
    const expiresAt = Date.now() + 3 * 86400000;
    const { payload } = await server.call<{ id: string; token: string; expiresAt: number; usesLeft: number }>(path,
      { expiresAt, uses: 2 }, owner.accessToken);
    expect(payload).toMatchObject({ expiresAt, usesLeft: 2 });
    const { payload: other } = await server.call<{ id: string; token: string }>(path, {}, owner.accessToken);
    expect(other.token).not.toBe(payload.token);
    const list = () => server.call<{ invitations: { id: string }[] }>(path, undefined, owner.accessToken);
    const listed = (await list()).payload.invitations;
    expect(listed.map(({ id }) => id)).toEqual([other.id, payload.id]);
    expect(listed[0]).not.toHaveProperty("token");
    expect((await server.fail(path, { expiresAt: Date.now() - 1000 }, owner.accessToken)).status).toBe(400);
    const key = testIdentity();
    const register = async (displayName: string, invitation = payload.token, identity = testIdentity()) => server.call<Device>("/api/v1/auth/register", {
      displayName, deviceName: "Test", identity: await server.proof("register", identity), invitation,
    });
    expect((await register("Invalid", "a".repeat(43))).response.status).toBe(401);
    const alice = await register("Alice", payload.token, key);
    expect(alice.response.status).toBe(201);
    expect((await register("Alice", payload.token, key)).response.status).toBe(409);
    expect((await server.fail("/api/v1/auth/identity/login", await server.proof("login", key))).status).toBe(401);

    const invitation = `${path}/${payload.id}`;
    expect((await server.fail(invitation, { usesLeft: 10 }, alice.payload.accessToken, "PATCH")).status).toBe(403);
    const edit = (body: { expiresAt?: number | null; usesLeft?: number | null }) =>
      server.call(invitation, body, owner.accessToken, "PATCH");
    expect((await edit({ expiresAt: null })).payload).toMatchObject({ expiresAt: null, usesLeft: 1 });
    expect((await register("Bobby")).response.status).toBe(201);
    expect((await register("Carol")).response.status).toBe(401);
    expect((await edit({ usesLeft: null })).payload).toMatchObject({ expiresAt: null, usesLeft: null });
    expect((await register("Carol")).response.status).toBe(201);
    expect((await server.call(invitation, undefined, owner.accessToken, "DELETE")).response.status).toBe(200);
    expect((await register("David")).response.status).toBe(401);
    expect((await edit({ usesLeft: 1 })).response.status).toBe(404);
    expect((await list()).payload.invitations.map(({ id }) => id)).toEqual([other.id]);
    expect((await register("David", other.token)).response.status).toBe(201);
  } finally { await server.cleanup(); }
});
