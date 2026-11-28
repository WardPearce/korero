import { expect, test } from "bun:test";
import { fixture, until, type Device } from "../server";
import { LOBBY, memberPermissions } from "../../src/database";

type Server = Awaited<ReturnType<typeof fixture>>;
type Socket = Awaited<ReturnType<Server["ws"]>>;

const accountRoles = "/api/v1/admin/accounts/roles";

function helpers(server: Server, owner: Device) {
  const grant = (actor: Device, target: Device, role: string) =>
    server.fail(accountRoles, { accountId: target.account.id, role }, actor.accessToken, "POST");
  const revoke = (actor: Device, target: Device, role: string) =>
    server.fail(accountRoles, { accountId: target.account.id, role }, actor.accessToken, "DELETE");
  const define = async (name: string, permissions: string[]) =>
    expect((await server.fail("/api/v1/admin/roles", { name, permissions }, owner.accessToken)).status).toBe(200);
  const edit = async (name: string, permissions: string[]) =>
    expect((await server.fail("/api/v1/admin/roles/definition", { name, permissions }, owner.accessToken, "PATCH")).status).toBe(200);
  const override = (socket: Socket, channelId: string, role: string, permission: string, allow: boolean | null) =>
    socket.rpc("channel.override", { channelId, role, permission, allow });
  const channel = async (socket: Socket, name: string, parentId?: string) =>
    (await socket.rpc<{ channelId: string }>("channel.create", { name, ...parentId ? { parentId } : {} })).channelId;
  return { grant, revoke, define, edit, override, channel };
}

async function withServer(run: (server: Server, owner: Device, ownerWs: Socket) => Promise<void>) {
  const server = await fixture();
  try {
    const owner = await server.owner();
    const ownerWs = await server.ws(owner);
    await run(server, owner, ownerWs);
  } finally { await server.cleanup(); }
}

test("server grants combine across held roles", () => withServer(async (server, owner) => {
  const { grant, revoke, define } = helpers(server, owner);
  await define("Talker", ["join", "speak"]);
  await define("Writer", ["join", "text"]);
  const account = await server.register("Combined");
  for (const role of ["Guest", "Talker", "Writer"]) expect((await grant(owner, account, role)).status).toBe(200);
  const removed = await revoke(owner, account, "Member");
  expect(removed).toMatchObject({ status: 200, payload: { roles: ["Talker", "Writer", "Guest"] } });
  const socket = await server.ws(account);
  await socket.rpc("channel.join", { channelId: LOBBY });
  const state = await socket.rpc<{ canSendText: boolean; serverPermissions: string[]; account: Device["account"] }>("state.get");
  expect(state.canSendText).toBe(true);
  expect(state.serverPermissions.toSorted()).toEqual(["join", "speak", "text"]);
  expect(state.account).toMatchObject({ role: "Talker", roles: ["Talker", "Writer", "Guest"] });
}));

test("an allow on one role beats a deny on another at the same channel level", () => withServer(async (server, owner, ownerWs) => {
  const { grant, define, override, channel } = helpers(server, owner);
  await define("Writer", ["join"]);
  const room = await channel(ownerWs, "Room");
  await override(ownerWs, room, "Member", "text", false);
  await override(ownerWs, room, "Writer", "text", true);
  const writer = await server.register("Writer member");
  expect((await grant(owner, writer, "Writer")).status).toBe(200);
  const plain = await server.ws(await server.register("Plain member"));
  const writerWs = await server.ws(writer);
  await writerWs.rpc("channel.join", { channelId: room });
  await plain.rpc("channel.join", { channelId: room });
  expect(await writerWs.rpc("message.send", { channelId: room, text: "Hello" })).toHaveProperty("messageId");
  await expect(plain.rpc("message.send", { channelId: room, text: "Hello" })).rejects.toThrow("FORBIDDEN");
}));

test("the nearest channel level decides across roles", () => withServer(async (server, owner, ownerWs) => {
  const { grant, define, override, channel } = helpers(server, owner);
  await define("Writer", ["join"]);
  const parent = await channel(ownerWs, "Parent");
  const child = await channel(ownerWs, "Child", parent);
  const writer = await server.register("Writer member");
  expect((await grant(owner, writer, "Writer")).status).toBe(200);
  const socket = await server.ws(writer);
  await socket.rpc("channel.join", { channelId: child });
  const send = () => socket.rpc("message.send", { channelId: child, text: "Hello" });

  await override(ownerWs, parent, "Writer", "text", true);
  await override(ownerWs, child, "Member", "text", false);
  await expect(send()).rejects.toThrow("FORBIDDEN");

  await override(ownerWs, parent, "Writer", "text", null);
  await override(ownerWs, child, "Member", "text", null);
  await override(ownerWs, parent, "Member", "text", false);
  await override(ownerWs, child, "Writer", "text", true);
  expect(await send()).toHaveProperty("messageId");
}));

test("a channel deny on one role beats a server-wide grant from another", () => withServer(async (server, owner, ownerWs) => {
  const { grant, override, channel } = helpers(server, owner);
  const staff = await channel(ownerWs, "Staff");
  await override(ownerWs, staff, "Member", "join", false);
  const moderator = await server.register("Moderator member");
  expect((await grant(owner, moderator, "Moderator")).status).toBe(200);
  const socket = await server.ws(moderator);
  await expect(socket.rpc("channel.join", { channelId: staff })).rejects.toThrow("FORBIDDEN");
  await override(ownerWs, staff, "Moderator", "join", true);
  await socket.rpc("channel.join", { channelId: staff });
}));

test("a Moderator cannot change roles of an account that also holds Administrator", () => withServer(async (server, owner) => {
  const { grant, revoke, edit } = helpers(server, owner);
  await edit("Moderator", ["join", "speak", "text", "move", "mute", "kick", "manageInvitations", "manageRoles"]);
  const moderator = await server.register("Moderator");
  const admin = await server.register("Administrator");
  const member = await server.register("Member");
  expect((await grant(owner, moderator, "Moderator")).status).toBe(200);
  expect((await grant(owner, admin, "Administrator")).status).toBe(200);
  expect((await revoke(moderator, admin, "Member")).status).toBe(403);
  expect((await grant(moderator, admin, "Guest")).status).toBe(403);
  expect((await grant(moderator, member, "Guest")).status).toBe(200);
  expect((await revoke(moderator, member, "Guest")).status).toBe(200);
}));

test("an actor cannot grant a role carrying permissions they lack", () => withServer(async (server, owner, ownerWs) => {
  const { grant, define, edit, override, channel } = helpers(server, owner);
  await edit("Moderator", [...memberPermissions, "move", "mute", "kick", "manageInvitations", "manageRoles"]);
  const moderator = await server.register("Moderator");
  const admin = await server.register("Administrator");
  const member = await server.register("Member");
  expect((await grant(owner, moderator, "Moderator")).status).toBe(200);
  expect((await grant(owner, admin, "Administrator")).status).toBe(200);
  // Server-wide: Guest now carries ban, which the Moderator lacks.
  await edit("Guest", ["join", "ban"]);
  expect((await grant(moderator, member, "Guest")).status).toBe(403);
  // Channel-scoped: Cleaner may delete messages in a room where the Administrator role may not.
  await define("Cleaner", ["join"]);
  const room = await channel(ownerWs, "Room");
  await override(ownerWs, room, "Administrator", "deleteChannels", false);
  await override(ownerWs, room, "Cleaner", "deleteChannels", true);
  expect((await grant(admin, member, "Cleaner")).status).toBe(403);
  await override(ownerWs, room, "Administrator", "deleteChannels", null);
  expect((await grant(admin, member, "Cleaner")).status).toBe(200);
}));

test("an account keeps at least one base role", () => withServer(async (server, owner) => {
  const { grant, revoke } = helpers(server, owner);
  const member = await server.register("Member");
  expect((await revoke(owner, member, "Member")).status).toBe(409);
  expect((await grant(owner, member, "Guest")).status).toBe(200);
  expect(await revoke(owner, member, "Member")).toMatchObject({ status: 200, payload: { roles: ["Guest"] } });
  expect((await revoke(owner, member, "Guest")).status).toBe(409);
}));

test("an account holds at most 25 roles", () => withServer(async (server, owner) => {
  const { grant, define } = helpers(server, owner);
  const member = await server.register("Collector");
  for (let index = 1; index <= 25; index++) await define(`Role ${index}`, ["join"]);
  for (let index = 1; index <= 24; index++) expect((await grant(owner, member, `Role ${index}`)).status).toBe(200);
  expect((await grant(owner, member, "Role 25")).status).toBe(409);
  const listing = await server.call<{ accounts: { id: string; roles: string[] }[] }>("/api/v1/admin/accounts", undefined, owner.accessToken);
  expect(listing.payload.accounts.find(({ id }) => id === member.account.id)?.roles).toHaveLength(25);
}));

test("role additions and removals are audited, and repeating them changes nothing", () => withServer(async (server, owner) => {
  const { grant, revoke } = helpers(server, owner);
  const member = await server.register("Member");
  expect(await grant(owner, member, "Guest")).toMatchObject({ status: 200, payload: { roles: ["Member", "Guest"] } });
  expect(await grant(owner, member, "Guest")).toMatchObject({ status: 200, payload: { roles: ["Member", "Guest"] } });
  expect(await revoke(owner, member, "Member")).toMatchObject({ status: 200, payload: { roles: ["Guest"] } });
  expect(await revoke(owner, member, "Member")).toMatchObject({ status: 200, payload: { roles: ["Guest"] } });
  type EventPage = { events: { action: string; targetId: string; details: unknown }[] };
  const { events } = (await server.call<EventPage>("/api/v1/admin/audit?prefix=role", undefined, owner.accessToken)).payload;
  expect(events.filter(({ targetId }) => targetId === member.account.id)).toEqual([
    expect.objectContaining({ action: "role.removed", details: { role: "Member", roles: ["Guest"] } }),
    expect.objectContaining({ action: "role.added", details: { role: "Guest", roles: ["Member", "Guest"] } }),
  ]);
}));

test("the role.add and role.remove requests change roles over the socket", () => withServer(async (server, owner, ownerWs) => {
  const member = await server.register("Member");
  expect(await ownerWs.rpc<{ roles: string[] }>("role.add", { accountId: member.account.id, role: "Moderator" })).toEqual({ roles: ["Moderator", "Member"] });
  expect(await ownerWs.rpc<{ roles: string[] }>("role.remove", { accountId: member.account.id, role: "Moderator" })).toEqual({ roles: ["Member"] });
  await expect(ownerWs.rpc("role.set", { accountId: member.account.id, role: "Moderator" })).rejects.toThrow();
}));

test("the accounts listing pages by account", () => withServer(async (server, owner) => {
  const { grant, define } = helpers(server, owner);
  await define("Extra", ["join"]);
  const registered: Device[] = [];
  for (let index = 0; index < 55; index++) registered.push(await server.register(`Account ${String(index).padStart(2, "0")}`));
  for (const account of registered.slice(0, 3)) {
    expect((await grant(owner, account, "Guest")).status).toBe(200);
    expect((await grant(owner, account, "Extra")).status).toBe(200);
  }
  type Page = { accounts: { id: string; role: string; roles: string[]; editable: boolean }[]; next: string | null };
  const first = (await server.call<Page>("/api/v1/admin/accounts", undefined, owner.accessToken)).payload;
  expect(first.accounts).toHaveLength(50);
  expect(new Set(first.accounts.map(({ id }) => id)).size).toBe(50);
  expect(first.next).not.toBeNull();
  const second = (await server.call<Page>(`/api/v1/admin/accounts?after=${first.next}`, undefined, owner.accessToken)).payload;
  expect(first.accounts.length + second.accounts.length).toBe(56);
  const all = [...first.accounts, ...second.accounts];
  for (const account of registered.slice(0, 3)) {
    expect(all.find(({ id }) => id === account.account.id)).toMatchObject({ role: "Extra", roles: ["Extra", "Member", "Guest"], editable: true });
  }
  expect(all.find(({ id }) => id === owner.account.id)).toMatchObject({ roles: ["Owner", "Member"], editable: false });
}));

test("a held custom role cannot be deleted until it is removed", () => withServer(async (server, owner) => {
  const { grant, revoke, define } = helpers(server, owner);
  await define("Temporary", ["join"]);
  const member = await server.register("Member");
  expect((await grant(owner, member, "Temporary")).status).toBe(200);
  const definition = "/api/v1/admin/roles/definition";
  expect((await server.fail(definition, { name: "Temporary" }, owner.accessToken, "DELETE")).status).toBe(409);
  expect((await revoke(owner, member, "Temporary")).status).toBe(200);
  expect((await server.fail(definition, { name: "Temporary" }, owner.accessToken, "DELETE")).status).toBe(200);
}));

const codec = { mimeType: "audio/opus", clockRate: 48000, channels: 2, payloadType: 111 };

test("removing the role that granted join moves every connection of the account out", () => withServer(async (server, owner, ownerWs) => {
  const { grant, revoke, define, override, channel } = helpers(server, owner);
  await define("Insider", ["join"]);
  const room = await channel(ownerWs, "Room");
  await override(ownerWs, room, "Member", "join", false);
  await override(ownerWs, room, "Insider", "join", true);
  const insider = await server.register("Insider");
  expect((await grant(owner, insider, "Insider")).status).toBe(200);
  const sockets = [await server.ws(insider), await server.ws(insider)];
  for (const socket of sockets) await socket.rpc("channel.join", { channelId: room });
  expect((await revoke(owner, insider, "Insider")).status).toBe(200);
  for (const socket of sockets) {
    await until(() => socket.rpc<{ channelId: string | null }>("state.get"), ({ channelId }) => channelId === null);
    await expect(socket.rpc("channel.join", { channelId: room })).rejects.toThrow("FORBIDDEN");
  }
}));

test("removing the role that granted speak closes the live producer", () => withServer(async (server, owner, ownerWs) => {
  const { grant, revoke, define, override, channel } = helpers(server, owner);
  await define("Talker", ["join"]);
  const room = await channel(ownerWs, "Room");
  await override(ownerWs, room, "Member", "speak", false);
  await override(ownerWs, room, "Talker", "speak", true);
  const talker = await server.register("Talker");
  expect((await grant(owner, talker, "Talker")).status).toBe(200);
  const socket = await server.ws(talker);
  await socket.rpc("channel.join", { channelId: room });
  await ownerWs.rpc("channel.join", { channelId: room });
  const outgoing = await socket.rpc<{ id: string }>("media.transport.create", { direction: "send" });
  const produce = (ssrc: number) => socket.rpc<{ id: string }>("media.producer.create", {
    kind: "audio", transportId: outgoing.id, rtpParameters: { codecs: [codec], encodings: [{ ssrc }] } });
  const { id: producerId } = await produce(1001);
  const listed = () => ownerWs.rpc<{ producerId: string }[]>("media.producers");
  expect((await listed()).map(({ producerId }) => producerId)).toContain(producerId);
  expect((await revoke(owner, talker, "Talker")).status).toBe(200);
  await until(listed, (producers) => !producers.some((entry) => entry.producerId === producerId));
  await expect(produce(1002)).rejects.toThrow("FORBIDDEN");
  expect(await socket.rpc<{ channelId: string }>("state.get")).toMatchObject({ channelId: room });
}));

test("override changes take effect after a cached check", () => withServer(async (server, owner, ownerWs) => {
  const { override, channel } = helpers(server, owner);
  const room = await channel(ownerWs, "Room");
  const socket = await server.ws(await server.register("Member"));
  await socket.rpc("channel.join", { channelId: room });
  expect(await socket.rpc("message.send", { channelId: room, text: "First" })).toHaveProperty("messageId");
  await override(ownerWs, room, "Member", "text", false);
  await expect(socket.rpc("message.send", { channelId: room, text: "Second" })).rejects.toThrow("FORBIDDEN");
}));

test("reparenting recomputes inherited access", () => withServer(async (server, owner, ownerWs) => {
  const { override, channel } = helpers(server, owner);
  const parent = await channel(ownerWs, "Parent");
  const room = await channel(ownerWs, "Room");
  await override(ownerWs, parent, "Member", "join", false);
  const socket = await server.ws(await server.register("Member"));
  await socket.rpc("channel.join", { channelId: room });
  await ownerWs.rpc("channel.edit", { channelId: room, parentId: parent });
  await until(() => socket.rpc<{ channelId: string | null }>("state.get"), ({ channelId }) => channelId === null);
  await expect(socket.rpc("channel.join", { channelId: room })).rejects.toThrow("FORBIDDEN");
}));

test("redefining a role's grants takes effect after a cached check", () => withServer(async (server, owner, ownerWs) => {
  const { grant, define, edit } = helpers(server, owner);
  await define("Writer", ["join", "text"]);
  const account = await server.register("Writer");
  expect((await grant(owner, account, "Guest")).status).toBe(200);
  expect((await grant(owner, account, "Writer")).status).toBe(200);
  expect((await server.fail(accountRoles, { accountId: account.account.id, role: "Member" }, owner.accessToken, "DELETE")).status).toBe(200);
  const socket = await server.ws(account);
  await socket.rpc("channel.join", { channelId: LOBBY });
  expect(await socket.rpc("message.send", { channelId: LOBBY, text: "First" })).toHaveProperty("messageId");
  await edit("Writer", ["join"]);
  await expect(socket.rpc("message.send", { channelId: LOBBY, text: "Second" })).rejects.toThrow("FORBIDDEN");
  void ownerWs;
}));

test("removing a role cannot give the account access the actor lacks", () => withServer(async (server, owner, ownerWs) => {
  const { grant, revoke, edit, override, channel } = helpers(server, owner);
  await edit("Moderator", [...memberPermissions, "move", "mute", "kick", "manageInvitations", "manageRoles"]);
  const moderator = await server.register("Moderator");
  expect((await grant(owner, moderator, "Moderator")).status).toBe(200);
  const target = await server.register("Target");
  expect((await grant(owner, target, "Guest")).status).toBe(200);
  const staff = await channel(ownerWs, "Staff");
  // The Moderator also holds Member, so it cannot join Staff. Removing Member would let the target's Guest grant through.
  await override(ownerWs, staff, "Member", "join", false);
  expect((await revoke(moderator, target, "Member")).status).toBe(403);
  await override(ownerWs, staff, "Moderator", "join", true);
  expect((await revoke(moderator, target, "Member")).status).toBe(200);
}));

test("moving a channel out from under a deny-only role requires managing that role", () => withServer(async (server, owner, ownerWs) => {
  const { grant, define, edit, override, channel } = helpers(server, owner);
  await define("Muted", ["join"]);
  await edit("Moderator", [...memberPermissions, "move", "mute", "kick", "manageInvitations", "editChannels"]);
  const moderator = await server.register("Moderator");
  expect((await grant(owner, moderator, "Moderator")).status).toBe(200);
  const parent = await channel(ownerWs, "Quiet");
  const child = await channel(ownerWs, "Quiet child", parent);
  await override(ownerWs, parent, "Muted", "speak", false);
  const moderatorWs = await server.ws(moderator);
  await expect(moderatorWs.rpc("channel.edit", { channelId: child, parentId: null })).rejects.toThrow("FORBIDDEN");
  await override(ownerWs, parent, "Muted", "speak", null);
  expect(await moderatorWs.rpc("channel.edit", { channelId: child, parentId: null })).toMatchObject({ channelId: child });
}));

test("reparenting checks combined grants in affected descendants", () => withServer(async (server, owner, ownerWs) => {
  const { grant, define, override, channel } = helpers(server, owner);
  await define("Writer", ["join", "text"]);
  const admin = await server.register("Administrator");
  const writer = await server.register("Writer member");
  expect((await grant(owner, admin, "Administrator")).status).toBe(200);
  expect((await grant(owner, writer, "Writer")).status).toBe(200);
  const previousRoot = await channel(ownerWs, "Current root");
  const previous = await channel(ownerWs, "Current parent", previousRoot);
  const proposed = await channel(ownerWs, "Proposed parent");
  const moved = await channel(ownerWs, "Moved channel", previous);
  const affected = await channel(ownerWs, "Affected child", moved);
  const shielded = await channel(ownerWs, "Shielded child", moved);
  for (const parent of [previous, proposed]) {
    await override(ownerWs, parent, "Member", "text", false);
    await override(ownerWs, parent, "Administrator", "text", true);
  }
  // Both roles keep the same override values. The Writer allow only wins once it is as close as Member's deny.
  await override(ownerWs, previousRoot, "Writer", "text", true);
  await override(ownerWs, proposed, "Writer", "text", true);
  await override(ownerWs, shielded, "Writer", "text", false);
  await override(ownerWs, affected, "Administrator", "text", false);
  await override(ownerWs, shielded, "Administrator", "text", false);

  const adminWs = await server.ws(admin);
  const writerWs = await server.ws(writer);
  const canChat = async (id: string) => (await writerWs.rpc<{ channels: { id: string; canChat: boolean }[] }>("state.get"))
    .channels.find((channel) => channel.id === id)?.canChat;
  const order = () => server.fail("/api/v1/channels/order", { channelId: moved, targetId: proposed, placement: "inside" },
    admin.accessToken, "PATCH");
  expect(await canChat(affected)).toBe(false);
  expect((await order()).status).toBe(403);
  await expect(adminWs.rpc("channel.edit", { channelId: moved, parentId: proposed })).rejects.toThrow("FORBIDDEN");
  expect(await canChat(affected)).toBe(false);

  await override(ownerWs, affected, "Administrator", "text", null);
  expect((await order()).status).toBe(200);
  expect(await canChat(affected)).toBe(true);
  expect(await canChat(shielded)).toBe(false);
}));

test("clearing a deny-only override is checked in every descendant it reaches", () => withServer(async (server, owner, ownerWs) => {
  const { grant, define, override, channel } = helpers(server, owner);
  await define("Muted", ["join"]);
  const admin = await server.register("Administrator");
  expect((await grant(owner, admin, "Administrator")).status).toBe(200);
  const parent = await channel(ownerWs, "Quiet");
  const child = await channel(ownerWs, "Quiet child", parent);
  await override(ownerWs, parent, "Muted", "speak", false);
  await override(ownerWs, child, "Administrator", "speak", false);
  const adminWs = await server.ws(admin);
  await expect(override(adminWs, parent, "Muted", "speak", null)).rejects.toThrow("FORBIDDEN");
  await override(ownerWs, child, "Administrator", "speak", null);
  await expect(override(adminWs, parent, "Muted", "speak", null)).resolves.toEqual({});
}));

test("role managers are told when any account's roles change", () => withServer(async (server, owner, ownerWs) => {
  const { grant } = helpers(server, owner);
  const admin = await server.register("Administrator");
  expect((await grant(owner, admin, "Administrator")).status).toBe(200);
  const adminWs = await server.ws(admin);
  const member = await server.ws(await server.register("Member"));
  const offline = await server.register("Offline");
  type State = { accountsRevision?: number };
  const before = (await adminWs.rpc<State>("state.get")).accountsRevision;
  expect(before).toBeNumber();
  expect((await member.rpc<State>("state.get")).accountsRevision).toBeUndefined();
  const invalidations = () => adminWs.received.filter(({ type }) => type === "state.invalidated").length;
  const seen = invalidations();
  // The owner changes an offline account, so the administrator's own peers are not otherwise involved.
  expect((await grant(owner, offline, "Guest")).status).toBe(200);
  await until(invalidations, (count) => count > seen);
  expect((await adminWs.rpc<State>("state.get")).accountsRevision).toBeGreaterThan(before!);
  void ownerWs;
}));

test("the account listing filters by search, role and ban status", () => withServer(async (server, owner, ownerWs) => {
  const { grant, define } = helpers(server, owner);
  await define("Helper", ["join"]);
  const alice = await server.register("Alice_1");
  const bob = await server.register("Bobby");
  const carol = await server.register("Carol");
  expect((await grant(owner, bob, "Helper")).status).toBe(200);
  await ownerWs.rpc("moderation.ban", { accountId: carol.account.id });
  type Page = { accounts: { id: string; displayName: string }[]; allRoles: string[] };
  const list = async (query: string) =>
    (await server.call<Page>(`/api/v1/admin/accounts?${query}`, undefined, owner.accessToken)).payload;
  const names = async (query: string) => (await list(query)).accounts.map(({ displayName }) => displayName).toSorted();
  expect(await names("search=ali")).toEqual(["Alice_1"]);
  expect(await names("search=_")).toEqual(["Alice_1"]);
  expect(await names(`search=${alice.account.id.slice(0, 8)}`)).toEqual(["Alice_1"]);
  expect(await names("role=Helper")).toEqual(["Bobby"]);
  expect(await names("status=banned")).toEqual(["Carol"]);
  expect(await names("status=active&search=b")).toEqual(["Bobby"]);
  expect((await list("")).allRoles).toEqual(expect.arrayContaining(["Owner", "Member", "Guest", "Helper"]));
}));
