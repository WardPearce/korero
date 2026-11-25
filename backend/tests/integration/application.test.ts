import { expect, test } from "bun:test";
import { fixture, type Snapshot, until } from "../server";
import { LOBBY } from "../../src/database";

test("channels, inheritance, password membership, moderation and text are permission-scoped", async () => {
  const server = await fixture({ environment: { VOICE_MESSAGING_PERSISTENCE: "true" } });
  try {
    const owner = await server.owner();
    const alice = await server.register("Alice");
    const bob = await server.register("Bob");
    const adminWs = await server.ws(owner);
    const aliceWs = await server.ws(alice);
    const bobWs = await server.ws(bob);
    const create = (payload: object) => adminWs.rpc<{ channelId: string; state: Snapshot }>("channel.create", payload);
    const parent = await create({ name: "Parent", position: 1 });
    const child = await create({ name: "Child", parentId: parent.channelId, password: "private phrase" });
    await expect(aliceWs.rpc("channel.create", { name: "Unauthorized" })).rejects.toThrow("FORBIDDEN");
    await expect(aliceWs.rpc("role.set", { accountId: alice.account.id, role: "Owner" })).rejects.toThrow("FORBIDDEN");
    await expect(adminWs.rpc("role.set", { accountId: owner.account.id, role: "Member" })).rejects.toThrow("FORBIDDEN");
    await adminWs.rpc("channel.override", { channelId: parent.channelId, role: "Member", permission: "join", allow: false });
    await expect(aliceWs.rpc("channel.join", { channelId: child.channelId, password: "private phrase" })).rejects.toThrow("FORBIDDEN");
    await adminWs.rpc("channel.override", { channelId: child.channelId, role: "Member", permission: "join", allow: true });
    await expect(aliceWs.rpc("channel.join", { channelId: child.channelId, password: "wrong" })).rejects.toThrow("FORBIDDEN");
    expect((await aliceWs.rpc<Snapshot>("channel.join", { channelId: child.channelId, password: "private phrase" })).channelId).toBe(child.channelId);
    await expect(bobWs.rpc("message.history", { channelId: child.channelId })).rejects.toThrow("FORBIDDEN");
    await bobWs.rpc("channel.join", { channelId: child.channelId, password: "private phrase" });
    await until(() => aliceWs.received.find((event) => event.type === "channel.userJoined" && event.payload.accountId === bob.account.id), Boolean);
    const sent = await aliceWs.rpc<{ messageId: string }>("message.send", { channelId: child.channelId, text: "Hello" });
    expect(await bobWs.rpc("message.history", { channelId: child.channelId })).toMatchObject([{ id: sent.messageId, text: "Hello" }]);
    await expect(bobWs.rpc("message.delete", sent)).rejects.toThrow("FORBIDDEN");
    await aliceWs.rpc("message.delete", sent);
    expect(await bobWs.rpc<unknown[]>("message.history", { channelId: child.channelId })).toEqual([]);
    await adminWs.rpc("channel.override", { channelId: child.channelId, role: "Member", permission: "join", allow: null });
    expect((await aliceWs.rpc<Snapshot>("state.get")).channelId).toBeNull();
    const temporary = await create({ name: "Temporary", temporary: true });
    expect(temporary.state.channelId).toBe(temporary.channelId);
    await adminWs.rpc("channel.join", { channelId: LOBBY });
    expect((await adminWs.rpc<Snapshot>("state.get")).channels.map(({ id }) => id)).not.toContain(temporary.channelId);
    await adminWs.rpc("moderation.kick", { accountId: bob.account.id });
    expect((await bobWs.closed).code).toBe(4403);
    const reconnected = await server.ws(bob);
    expect(reconnected.state.channelId).toBeNull();
    reconnected.close();
  } finally { await server.cleanup(); }
});

test("duplicate requests are replayed safely, malformed requests are correlated, oversized frames are closed", async () => {
  const server = await fixture({ environment: { VOICE_LIMITS_WEBSOCKET_BYTES: "4096" } });
  try {
    const ws = await server.ws(await server.owner());
    const args = { name: "Only one" };
    const first = await ws.rpc("channel.create", args, 2);
    expect(await ws.rpc("channel.create", args, 2)).toEqual(first);
    await expect(ws.rpc("channel.create", { name: "Other" }, 2)).rejects.toThrow("CONFLICT");
    await expect(ws.rpc("heartbeat", { unexpected: true }, 3)).rejects.toThrow("INVALID_REQUEST");
    expect((await ws.rpc<Snapshot>("state.get", {}, 4)).channels.filter(({ name }) => name === "Only one")).toHaveLength(1);
    ws.raw.send("x".repeat(10000));
    expect([1006, 1009]).toContain((await ws.closed).code);
  } finally { await server.cleanup(); }
});

test("worker crash invalidates media and starts a replacement", async () => {
  const server = await fixture();
  try {
    const owner = await server.ws(await server.owner());
    const member = await server.ws(await server.register("Member"));
    await member.rpc("channel.join", { channelId: LOBBY });
    await member.rpc("media.capabilities");
    const own = await member.rpc<{ id: string }>("media.transport.create", { direction: "send" });
    await owner.rpc("channel.join", { channelId: LOBBY });
    await expect(owner.rpc("media.transport.stats", { transportId: own.id })).rejects.toThrow("NOT_FOUND");
    expect(await member.rpc("media.ice.restart", { transportId: own.id })).toHaveProperty("usernameFragment");
    const diagnostics = () => owner.rpc<{ workers: { pid: number }[]; routers: number }>("admin.diagnostics");
    const before = await diagnostics();
    expect(before.routers).toBe(1);
    process.kill(before.workers[0]!.pid, "SIGKILL");
    await until(() => member.received.find((event) => event.type === "media.reset"), Boolean);
    await until(diagnostics, (stats) => !!stats.workers[0]?.pid && stats.workers[0].pid !== before.workers[0]!.pid);
    await expect(member.rpc("media.transport.stats", { transportId: own.id })).rejects.toThrow("NOT_FOUND");
    expect(await member.rpc("media.capabilities")).toHaveProperty("codecs");
  } finally { await server.cleanup(); }
});
