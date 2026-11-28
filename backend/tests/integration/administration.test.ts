import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { fixture, testIdentity, until, type Device, type Snapshot } from "../server";
import { LOBBY } from "../../src/database";

const accountRoles = "/api/v1/admin/accounts/roles";

test("channel permission changes respect the caller's access throughout the affected subtree", async () => {
  const server = await fixture();
  try {
    const owner = await server.owner();
    const admin = await server.register("Administrator");
    await server.call("/api/v1/admin/accounts/roles", { accountId: admin.account.id, role: "Administrator" }, owner.accessToken, "POST");
    const ownerWs = await server.ws(owner);
    const adminWs = await server.ws(admin);
    const { channelId: parent } = await ownerWs.rpc<{ channelId: string }>("channel.create", { name: "Parent" });
    const { channelId: child } = await ownerWs.rpc<{ channelId: string }>("channel.create", { name: "Child", parentId: parent });
    const override = (socket: typeof ownerWs, channelId: string, role: string, permission: string, allow: boolean | null) =>
      socket.rpc("channel.override", { channelId, role, permission, allow });

    for (const permission of ["join", "text"]) {
      await override(ownerWs, child, "Administrator", permission, false);
      await expect(override(adminWs, child, "Guest", "text", true)).rejects.toThrow("FORBIDDEN");
      await override(ownerWs, child, "Administrator", permission, null);
    }
    await expect(override(adminWs, child, "Administrator", "text", false)).rejects.toThrow("FORBIDDEN");
    await override(ownerWs, child, "Administrator", "text", false);
    await expect(override(adminWs, parent, "Guest", "text", true)).rejects.toThrow("FORBIDDEN");
    const { channelId: destination } = await ownerWs.rpc<{ channelId: string }>("channel.create", { name: "Destination" });
    await override(ownerWs, destination, "Guest", "text", true);
    await expect(adminWs.rpc("channel.edit", { channelId: parent, parentId: destination })).rejects.toThrow("FORBIDDEN");
    await override(ownerWs, child, "Guest", "text", false);
    await expect(adminWs.rpc("channel.edit", { channelId: parent, parentId: destination })).resolves.toMatchObject({ channelId: parent });
    await expect(adminWs.rpc("channel.edit", { channelId: parent, parentId: null })).resolves.toMatchObject({ channelId: parent });
    await expect(override(adminWs, parent, "Guest", "text", true)).resolves.toEqual({});
    await expect(override(adminWs, child, "Guest", "text", null)).rejects.toThrow("FORBIDDEN");
    await override(ownerWs, child, "Guest", "text", true);
    await expect(override(adminWs, child, "Guest", "speak", true)).rejects.toThrow("FORBIDDEN");
  } finally { await server.cleanup(); }
});

test("role administration requires a lower rank and control of current and proposed grants", async () => {
  const server = await fixture();
  try {
    const owner = await server.owner();
    const admin = await server.register("Administrator");
    const delegate = await server.register("Delegate");
    const moderator = await server.register("Moderator");
    const guest = await server.register("Guest");
    const roles = "/api/v1/admin/roles";
    const definition = `${roles}/definition`;
    const assign = (actor: Device, target: Device, role: string) =>
      server.fail(accountRoles, { accountId: target.account.id, role }, actor.accessToken, "POST");
    const revoke = (actor: Device, target: Device, role: string) =>
      server.fail(accountRoles, { accountId: target.account.id, role }, actor.accessToken, "DELETE");
    const delegator = { name: "Role manager", permissions: ["join", "manageRoles"] };
    const reader = { name: "Reader", permissions: ["join"] };
    expect((await assign(owner, admin, "Administrator")).status).toBe(200);
    expect((await assign(owner, moderator, "Moderator")).status).toBe(200);
    expect((await assign(owner, guest, "Guest")).status).toBe(200);
    expect((await revoke(owner, guest, "Member")).status).toBe(200);
    expect((await server.fail(roles, delegator, owner.accessToken)).status).toBe(200);
    expect((await assign(owner, delegate, delegator.name)).status).toBe(200);
    expect((await assign(delegate, delegate, "Guest")).status).toBe(403);
    // Removing a role requires holding its grants.
    expect((await revoke(delegate, moderator, "Moderator")).status).toBe(403);
    expect((await assign(delegate, guest, "Moderator")).status).toBe(403);
    expect((await server.fail(definition, { ...delegator, permissions: ["join"] }, delegate.accessToken, "PATCH")).status).toBe(403);
    const delegateWs = await server.ws(delegate);
    await expect(delegateWs.rpc("role.remove", { accountId: moderator.account.id, role: "Moderator" })).rejects.toThrow("FORBIDDEN");

    expect((await server.fail(roles, reader, admin.accessToken)).status).toBe(200);
    const ownerWs = await server.ws(owner);
    const { channelId } = await ownerWs.rpc<{ channelId: string }>("channel.create", { name: "Restricted text" });
    await ownerWs.rpc("channel.override", { channelId, role: "Administrator", permission: "text", allow: false });
    expect((await server.fail(definition, { ...reader, permissions: ["join", "text"] }, admin.accessToken, "PATCH")).status).toBe(403);
    expect((await assign(admin, guest, reader.name)).status).toBe(200);
    expect((await revoke(owner, guest, reader.name)).status).toBe(200);
    await ownerWs.rpc("channel.override", { channelId, role: reader.name, permission: "text", allow: true });
    expect((await assign(admin, guest, reader.name)).status).toBe(403);
    expect((await server.fail(definition, reader, admin.accessToken, "PATCH")).status).toBe(403);
    expect((await server.fail(definition, { name: reader.name }, admin.accessToken, "DELETE")).status).toBe(403);
    expect((await server.fail(definition, { name: reader.name }, owner.accessToken, "DELETE")).status).toBe(200);
  } finally { await server.cleanup(); }
});

test("bans are audited and accounts that can ban others cannot be banned", async () => {
  const server = await fixture();
  try {
    const owner = await server.owner();
    const admin = await server.register("Administrator");
    await server.call("/api/v1/admin/accounts/roles", { accountId: admin.account.id, role: "Administrator" }, owner.accessToken, "POST");
    const member = await server.register("Member");

    const ownerWs = await server.ws(owner);
    const adminWs = await server.ws(admin);
    try {
      // Accounts that can themselves ban others cannot be banned, even by the owner.
      await expect(ownerWs.rpc("moderation.ban", { accountId: admin.account.id })).rejects.toThrow("FORBIDDEN");
      await expect(adminWs.rpc("moderation.ban", { accountId: owner.account.id })).rejects.toThrow("FORBIDDEN");

      // A regular member can be banned, and the ban is recorded in the audit log.
      await adminWs.rpc("moderation.ban", { accountId: member.account.id });
      type EventPage = { events: { action: string; targetId: string | null }[] };
      const moderation = async () => (await server.call<EventPage>("/api/v1/admin/audit?prefix=moderation", undefined, owner.accessToken)).payload.events;
      expect(await moderation()).toEqual(expect.arrayContaining([
        expect.objectContaining({ action: "moderation.ban", targetId: member.account.id }),
      ]));

      type AccountPage = { accounts: { id: string; banned: boolean; bannedUntil: number | null }[] };
      const listed = async () => (await server.call<AccountPage>("/api/v1/admin/accounts", undefined, owner.accessToken))
        .payload.accounts.find(({ id }) => id === member.account.id);
      expect(await listed()).toEqual(expect.objectContaining({ banned: true, bannedUntil: null }));

      // Unbanning is audited too.
      await adminWs.rpc("moderation.unban", { accountId: member.account.id });
      expect(await moderation()).toEqual(expect.arrayContaining([
        expect.objectContaining({ action: "moderation.unban", targetId: member.account.id }),
      ]));
      expect(await listed()).toEqual(expect.objectContaining({ banned: false, bannedUntil: null }));

      // A timed ban reports its expiry and lifts itself once it passes.
      const before = Date.now();
      await adminWs.rpc("moderation.ban", { accountId: member.account.id, expiresInSeconds: 1 });
      const timed = await listed();
      expect(timed?.banned).toBe(true);
      expect(timed?.bannedUntil).toBeGreaterThanOrEqual(before + 1000);
      expect(timed?.bannedUntil).toBeLessThanOrEqual(Date.now() + 1000);
      await Bun.sleep(1100);
      expect(await listed()).toEqual(expect.objectContaining({ banned: false, bannedUntil: null }));
    } finally {
      ownerWs.close();
      adminWs.close();
      await Promise.all([ownerWs.closed, adminWs.closed]);
    }
  } finally { await server.cleanup(); }
});

test("built-in role permissions apply to connected accounts and protect the registration role", async () => {
  const server = await fixture();
  try {
    const owner = await server.owner();
    const member = await server.register("Member");
    const guest = await server.register("Guest");
    const roles = "/api/v1/admin/roles";
    const edit = (name: string, permissions: string[], token = owner.accessToken) =>
      server.call(`${roles}/definition`, { name, permissions }, token, "PATCH");
    const assign = (accountId: string, role: string) => server.call(accountRoles, { accountId, role }, owner.accessToken, "POST");
    expect((await assign(guest.account.id, "Guest")).response.status).toBe(200);
    expect((await server.call(accountRoles, { accountId: guest.account.id, role: "Member" }, owner.accessToken, "DELETE")).response.status).toBe(200);
    expect((await edit("Member", ["join", "kick"])).response.status).toBe(409);
    expect((await edit("Administrator", ["join"])).response.status).toBe(403);
    expect((await edit("Owner", ["join"])).response.status).toBe(403);
    expect((await edit("Guest", ["join", "text"], member.accessToken)).response.status).toBe(403);

    const ownerWs = await server.ws(owner);
    const memberWs = await server.ws(member);
    const guestWs = await server.ws(guest);
    try {
      const { channelId: studio } = await ownerWs.rpc<{ channelId: string }>("channel.create", { name: "Studio" });
      await ownerWs.rpc("channel.join", { channelId: studio });
      await memberWs.rpc("channel.join", { channelId: LOBBY });
      await guestWs.rpc("channel.join", { channelId: LOBBY });
      await expect(guestWs.rpc("message.send", { channelId: LOBBY, text: "Hello" })).rejects.toThrow("FORBIDDEN");
      expect((await edit("Guest", ["join", "text"])).response.status).toBe(200);
      expect(await guestWs.rpc("state.get")).toMatchObject({ account: { role: "Guest" }, canSendText: true });
      await guestWs.rpc("message.send", { channelId: LOBBY, text: "Hello" });

      const upload = { channelId: LOBBY, connectionId: memberWs.state.connectionId, name: "test.txt", data: "YQ==", text: "" };
      const attachmentPath = "/api/v1/chat/attachments";
      expect((await server.call(attachmentPath, upload, member.accessToken)).response.status).toBe(200);
      const screen = { kind: "video", direction: "send" };
      const camera = { ...screen, videoSource: "camera" };
      const transport = await memberWs.rpc<{ id: string }>("media.transport.create", screen);
      expect((await edit("Member", ["join", "text", "speak", "useCamera"])).response.status).toBe(200);
      expect(await memberWs.rpc("state.get")).toMatchObject({ channelId: LOBBY, canSendText: true, canAttachFiles: false,
        canShareScreen: false, canUseCamera: true, directMessages: { canSend: false },
        channels: expect.arrayContaining([expect.objectContaining({ id: studio, canWhisperTo: false })]) });
      await expect(memberWs.rpc("media.transport.stats", { transportId: transport.id })).rejects.toThrow("NOT_FOUND");
      await expect(memberWs.rpc("media.transport.create", screen)).rejects.toThrow("FORBIDDEN");
      await memberWs.rpc("media.transport.create", camera);
      await expect(memberWs.rpc("media.transport.create", { direction: "send", whisperChannelId: studio })).rejects.toThrow("FORBIDDEN");
      expect((await server.fail(attachmentPath, upload, member.accessToken)).status).toBe(403);
      await expect(memberWs.rpc("direct.send", { accountId: owner.account.id, id: crypto.randomUUID(),
        nonce: randomBytes(12).toString("base64url"), ciphertext: randomBytes(25).toString("base64url"),
        signature: randomBytes(64).toString("base64url") })).rejects.toThrow("FORBIDDEN");
      await expect(ownerWs.rpc("channel.override", { channelId: studio, role: "Member", permission: "mute", allow: true }))
        .rejects.toThrow("CONFLICT");
      const listing = await server.call("/api/v1/admin/accounts", undefined, owner.accessToken);
      expect(listing.payload).toMatchObject({ defaultRole: "Member", customRoles: [], builtInRoles: expect.arrayContaining([
        expect.objectContaining({ name: "Guest", editable: true, permissions: ["join", "text"] }),
        expect.objectContaining({ name: "Member", editable: true, permissions: ["join", "text", "speak", "useCamera"] }),
      ]) });
    } finally {
      for (const socket of [ownerWs, memberWs, guestWs]) socket.close();
      await Promise.all([ownerWs.closed, memberWs.closed, guestWs.closed]);
    }
  } finally { await server.cleanup(); }
});

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
    expect((await server.fail(accountRoles, { accountId: owner.account.id, role: "Member" }, owner.accessToken, "POST")).status).toBe(403);
    const grant = await server.call(accountRoles, { accountId: alice.account.id, role: "Administrator" }, owner.accessToken, "POST");
    expect(grant.response.status).toBe(200);
    expect((await server.fail(accountRoles, { accountId: owner.account.id, role: "Member" }, alice.accessToken, "POST")).status).toBe(403);
    const accounts = await server.call("/api/v1/admin/accounts", undefined, alice.accessToken);
    expect(accounts.payload).toMatchObject({ accounts: expect.arrayContaining([{ id: owner.account.id,
      displayName: "Operator", role: "Owner", roles: ["Owner", "Member"], badge: null, editable: false, bannable: false, banned: false, bannedUntil: null }]) });

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

test("the server counts unique accounts and shares badges from authorized account edits", async () => {
  const server = await fixture();
  try {
    const owner = await server.owner();
    const admin = await server.register("Administrator");
    const identity = testIdentity();
    const member = await server.register("Member", identity);
    await server.call("/api/v1/admin/accounts/roles", { accountId: admin.account.id, role: "Administrator" }, owner.accessToken, "POST");
    const badges = "/api/v1/admin/badges";
    const target = { accountId: member.account.id, badge: "  Event host  " };
    expect((await server.fail(badges, { ...target, accountId: admin.account.id }, member.accessToken, "PATCH")).status).toBe(403);
    expect((await server.fail(badges, { ...target, accountId: owner.account.id }, admin.accessToken, "PATCH")).status).toBe(403);
    expect((await server.fail(badges, { ...target, badge: "\n" }, admin.accessToken, "PATCH")).status).toBe(400);
    expect((await server.call(badges, target, admin.accessToken, "PATCH")).payload).toEqual({ badge: "Event host" });

    const observer = await server.ws(owner);
    expect(observer.state).toMatchObject({ totalUsers: 3, presence: [{ accountId: owner.account.id, connections: 1 }] });
    await server.register("Offline user");
    await until(() => observer.received.some(({ type }) => type === "state.invalidated"), Boolean);
    expect(await observer.rpc("state.get")).toMatchObject({ totalUsers: 4, presence: [{ accountId: owner.account.id }] });

    const memberWs = await server.ws(member);
    await memberWs.rpc("channel.join", { channelId: LOBBY });
    const login = await server.call<Device>("/api/v1/auth/identity/login", await server.proof("login", identity));
    const secondDevice = await server.ws(login.payload);
    try {
      expect(await observer.rpc("state.get")).toMatchObject({ totalUsers: 4, presence: [
        { accountId: owner.account.id, connections: 1 }, { accountId: member.account.id, connections: 2 },
      ], channelMembers: { [LOBBY]: [{ accountId: member.account.id, role: "Member", badge: "Event host" }] } });
      expect((await server.call(badges, { ...target, badge: null }, admin.accessToken, "PATCH")).payload).toEqual({ badge: null });
      await until(() => observer.received.some(({ type, payload }) => type === "channel.member" &&
        payload.accountId === member.account.id && payload.badge === null), Boolean);
      expect(await memberWs.rpc("state.get")).toMatchObject({ account: { role: "Member", badge: null } });
    } finally {
      for (const socket of [observer, memberWs, secondDevice]) socket.close();
      await Promise.all([observer.closed, memberWs.closed, secondDevice.closed]);
    }
  } finally { await server.cleanup(); }
});

test("the host password is enforced at startup and stays read-only in the admin API", async () => {
  const password = "fixture host password";
  const server = await fixture({ environment: { VOICE_SERVER_PASSWORD: password } });
  try {
    const key = testIdentity();
    const bootstrapPath = "/api/v1/admin/bootstrap";
    const bootstrap = async () => ({
      displayName: "Owner", deviceName: "Test", token: server.setupToken, identity: await server.proof("bootstrap", key),
    });
    expect((await server.fail(bootstrapPath, await bootstrap())).status).toBe(401);
    expect((await server.fail(bootstrapPath, { ...await bootstrap(), password: "incorrect" })).status).toBe(401);
    const claimed = await server.call<Device>(bootstrapPath, { ...await bootstrap(), password });
    expect(claimed.response.status).toBe(201);
    const owner = claimed.payload;
    expect(owner.account.role).toBe("Owner");
    expect((await server.fail(bootstrapPath, await bootstrap())).status).toBe(404);
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
    await server.call(accountRoles, { accountId: admin.account.id, role: "Administrator" }, owner.accessToken, "POST");
    const role = { name: "Listener", permissions: ["join", "manageRoles"] };
    expect((await server.fail(roles, role, member.accessToken)).status).toBe(403);
    expect((await server.call(roles, role, admin.accessToken)).payload).toEqual(role);
    expect((await server.fail(roles, { ...role, name: "administrator" }, admin.accessToken)).status).toBe(409);
    expect((await server.call(accountRoles, { accountId: member.account.id, role: role.name }, admin.accessToken, "POST")).response.status).toBe(200);
    expect((await server.call(accountRoles, { accountId: member.account.id, role: "Guest" }, admin.accessToken, "POST")).response.status).toBe(200);
    expect((await server.call(accountRoles, { accountId: member.account.id, role: "Member" }, admin.accessToken, "DELETE")).response.status).toBe(200);
    expect((await server.fail(roles, { ...role, name: "Other role" }, member.accessToken)).status).toBe(403);
    expect((await server.fail(accountRoles, { accountId: admin.account.id, role: "Guest" }, member.accessToken, "POST")).status).toBe(403);

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

test("channel deletion uses its own grant and protects the Lobby and parents with children", async () => {
  const server = await fixture();
  try {
    const owner = await server.owner();
    const member = await server.register("Channel moderator");
    const roles = "/api/v1/admin/roles";
    const name = "Channel moderator";
    const permissions = ["join", "deleteChannels"];
    expect((await server.call(roles, { name, permissions }, owner.accessToken)).response.status).toBe(200);
    expect((await server.call(accountRoles, { accountId: member.account.id, role: name }, owner.accessToken, "POST")).response.status).toBe(200);

    const ownerWs = await server.ws(owner);
    const memberWs = await server.ws(member);
    const { channelId: parent } = await ownerWs.rpc<{ channelId: string }>("channel.create", { name: "Parent" });
    const { channelId: child } = await ownerWs.rpc<{ channelId: string }>("channel.create", { name: "Child", parentId: parent });
    const getState = () => memberWs.rpc<Snapshot & { channels: { id: string; canDelete: boolean }[] }>("state.get");
    const capability = async (id: string) => (await getState()).channels.find((channel) => channel.id === id);
    expect(await capability(child)).toMatchObject({ canDelete: false });
    await expect(memberWs.rpc("channel.delete", { channelId: child })).rejects.toThrow("FORBIDDEN");

    expect((await server.call(`${roles}/definition`, { name, permissions: ["join", "removeChannels"] }, owner.accessToken, "PATCH")).response.status).toBe(200);
    expect(await capability(child)).toMatchObject({ canDelete: true, canEdit: false });
    for (const channelId of [LOBBY, parent]) {
      expect(await capability(channelId)).toMatchObject({ canDelete: false });
      await expect(memberWs.rpc("channel.delete", { channelId })).rejects.toThrow("CONFLICT");
    }
    await memberWs.rpc("channel.join", { channelId: child });
    await memberWs.rpc("channel.delete", { channelId: child });
    expect(await capability(child)).toBeUndefined();
    expect(await getState()).toMatchObject({ channelId: null });
    expect(await capability(parent)).toMatchObject({ canDelete: true });
    ownerWs.close();
    memberWs.close();
  } finally { await server.cleanup(); }
});

test("channel moves preserve subtrees and enforce destination permissions and depth", async () => {
  const server = await fixture();
  try {
    const owner = await server.owner();
    const admin = await server.register("Administrator");
    const member = await server.register("Listener");
    await server.call("/api/v1/admin/accounts/roles", { accountId: admin.account.id, role: "Administrator" }, owner.accessToken, "POST");
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
    await override(destination, "Member", "join", false);
    // Administrators also hold Member, so they need their own allow to keep reaching the channel.
    await override(destination, "Administrator", "join", true);
    await memberWs.rpc("channel.join", { channelId: child });
    expect((await order(source, destination, "inside")).response.status).toBe(200);
    await until(() => memberWs.received.some(({ type, payload }) => type === "channel.changed" && payload.channelId === null), Boolean);
    const getState = () => adminWs.rpc<Snapshot>("state.get");
    const nested = await getState();
    expect(nested.channels.filter(({ parentId }) => parentId === destination).map(({ id }) => id)).toEqual([sibling, source]);
    expect(nested.channels.find(({ id }) => id === child)?.parentId).toBe(source);

    const editor = await server.register("Channel editor");
    const roles = "/api/v1/admin/roles";
    expect((await server.call(roles, { name: "Editor", permissions: ["join", "editChannels"] }, owner.accessToken)).response.status).toBe(200);
    await server.call(accountRoles, { accountId: editor.account.id, role: "Editor" }, owner.accessToken, "POST");
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
  const server = await fixture({ environment: { VOICE_LIMITS_PROFILE_UPDATES_PER_MINUTE: "120" } });
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
    await ownerWs.rpc("channel.override", { channelId, role: listener.name, permission: "mute", allow: true });
    expect((await save({ defaultRole: listener.name })).response.status).toBe(403);
    await ownerWs.rpc("channel.override", { channelId, role: listener.name, permission: "mute", allow: null });
    expect((await save({ defaultRole: listener.name, motd: " Hello!\nVoice meetup tonight. ", defaultAudioBitrate: 40000 })).payload)
      .toMatchObject({ defaultRole: listener.name, motd: "Hello!\nVoice meetup tonight.", defaultAudioBitrate: 40000 });
    expect((await remove(listener.name)).response.status).toBe(409);
    expect((await server.call(roles + "/definition", { ...listener, permissions: ["join", "kick"] }, owner.accessToken, "PATCH")).response.status).toBe(409);
    await expect(ownerWs.rpc("channel.override", { channelId, role: listener.name, permission: "mute", allow: true }))
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
    await server.call(accountRoles, { accountId: registered.account.id, role: "Member" }, owner.accessToken, "POST");
    await server.call(accountRoles, { accountId: registered.account.id, role: listener.name }, owner.accessToken, "DELETE");
    expect((await remove(listener.name)).response.status).toBe(200);
    expect(await ownerWs.rpc("state.get")).toMatchObject({ motd: "", targetAudioBitrate: 64000 });
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

test("invited identities can sign back in without the password and invitations honor updated limits and deletion", async () => {
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
    const signIn = async () => server.call<Device>("/api/v1/auth/identity/login", await server.proof("login", key));
    const login = await signIn();
    expect(login.response.status).toBe(200);
    expect(login.payload.account.id).toBe(alice.payload.account.id);

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
    expect((await server.call("/api/v1/admin/password", { password: "replacement phrase" }, owner.accessToken, "PATCH")).response.status).toBe(200);
    expect((await server.call("/api/v1/auth/logout-all", {}, login.payload.accessToken)).response.status).toBe(200);
    const reconnected = await signIn();
    expect(reconnected.response.status).toBe(200);
    expect(reconnected.payload.account.id).toBe(alice.payload.account.id);
    expect(reconnected.payload.sessionId).not.toBe(login.payload.sessionId);
  } finally { await server.cleanup(); }
});

test("channel permission settings list and apply per-role overrides over HTTP", async () => {
  const server = await fixture();
  try {
    const owner = await server.owner();
    const moderator = await server.register("Moderator");
    const member = await server.register("Member");
    await server.call("/api/v1/admin/accounts/roles", { accountId: moderator.account.id, role: "Moderator" }, owner.accessToken, "POST");
    const ownerWs = await server.ws(owner);
    const memberWs = await server.ws(member);
    const { channelId: parent } = await ownerWs.rpc<{ channelId: string }>("channel.create", { name: "Staff" });
    const { channelId: child } = await ownerWs.rpc<{ channelId: string }>("channel.create", { name: "Briefing", parentId: parent });
    const path = (channelId: string) => `/api/v1/channels/${channelId}/permissions`;
    type State = { canShareScreen: boolean; channels: { id: string; canManagePermissions: boolean }[] };
    type Table = { roles: { name: string; permissions: Record<string, { allow: boolean | null; inherited: boolean }> }[]; editable: string[] };

    const state = await ownerWs.rpc<State>("state.get");
    expect(state.channels.find(({ id }) => id === child)).toMatchObject({ canManagePermissions: true });
    expect((await memberWs.rpc<State>("state.get")).channels.find(({ id }) => id === child))
      .toMatchObject({ canManagePermissions: false });
    expect((await server.fail(path(child), undefined, member.accessToken, "GET")).status).toBe(403);
    expect((await server.fail(path(child), undefined, moderator.accessToken, "GET")).status).toBe(403);

    const changes = [
      { role: "Member", permission: "speak", allow: false },
      { role: "Moderator", permission: "speak", allow: true },
    ];
    expect((await server.fail(path(parent), { changes }, owner.accessToken, "PATCH")).status).toBe(200);
    const { payload: table } = await server.call<Table>(path(child), undefined, owner.accessToken, "GET");
    expect(table.editable).toContain("speak");
    const roleEntry = (name: string) => table.roles.find((role) => role.name === name)!;
    expect(roleEntry("Member").permissions.speak).toEqual({ allow: null, inherited: false });
    expect(roleEntry("Guest").permissions.join).toEqual({ allow: null, inherited: true });
    expect(table.roles.map(({ name }) => name)).not.toContain("Owner");

    await memberWs.rpc("channel.join", { channelId: child });
    expect((await memberWs.rpc<State>("state.get")).canShareScreen).toBe(false);
    expect((await server.fail(path(parent), { changes: [{ role: "Member", permission: "speak", allow: null }] },
      owner.accessToken, "PATCH")).status).toBe(200);
    const { payload: parentTable } = await server.call<Table>(path(parent), undefined, owner.accessToken, "GET");
    expect(parentTable.roles.find((role) => role.name === "Member")!.permissions.speak).toEqual({ allow: null, inherited: true });
    expect(parentTable.roles.find((role) => role.name === "Moderator")!.permissions.speak).toEqual({ allow: true, inherited: true });
    expect((await server.fail(path(parent), { changes: [{ role: "Owner", permission: "speak", allow: false }] },
      owner.accessToken, "PATCH")).status).toBe(403);
  } finally { await server.cleanup(); }
}, 20000);
