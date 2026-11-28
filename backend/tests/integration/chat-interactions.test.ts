import { expect, test } from "bun:test";
import { fixture, type Snapshot, until } from "../server";

type Server = Awaited<ReturnType<typeof fixture>>;
type Device = Awaited<ReturnType<Server["owner"]>>;
type Payload = Record<string, unknown>;
type StoredMessage = { id: string; replyTo?: Payload; mentions?: { accounts: string[]; roles: string[] }; reactions?: Payload[] };

async function setMentionable(server: Server, owner: Device, name: string, mentionable: boolean) {
  const { payload } = await server.call<{ builtInRoles: { name: string; permissions: string[] }[]; customRoles: { name: string; permissions: string[] }[] }>(
    "/api/v1/admin/accounts", undefined, owner.accessToken);
  const role = [...payload.builtInRoles, ...payload.customRoles].find((entry) => entry.name === name)!;
  return server.fail("/api/v1/admin/roles/definition", { name, permissions: role.permissions, mentionable }, owner.accessToken, "PATCH");
}

test("roles can be marked mentionable, and the snapshot lists them", async () => {
  const server = await fixture();
  try {
    const owner = await server.owner();
    const before = await server.ws(owner);
    expect((before.state as Snapshot & { mentionableRoles: string[] }).mentionableRoles).toEqual([]);
    const changed = await setMentionable(server, owner, "Moderator", true);
    expect(changed.status).toBe(200);
    expect(changed.payload).toMatchObject({ name: "Moderator", mentionable: true });
    const after = await server.ws(owner);
    expect((after.state as Snapshot & { mentionableRoles: string[] }).mentionableRoles).toEqual(["Moderator"]);
    expect((await setMentionable(server, owner, "Owner", true)).status).toBe(403);
    const { payload } = await server.call<{ builtInRoles: { name: string; mentionable: boolean }[] }>("/api/v1/admin/accounts", undefined, owner.accessToken);
    expect(payload.builtInRoles.find(({ name }) => name === "Moderator")?.mentionable).toBe(true);
    expect(payload.builtInRoles.find(({ name }) => name === "Member")?.mentionable).toBe(false);
  } finally { await server.cleanup(); }
});

test("replies show the original and mentions reach readers outside the channel", async () => {
  const server = await fixture();
  try {
    const owner = await server.owner();
    const ownerWs = await server.ws(owner);
    const readerDevice = await server.register("Reader");
    const reader = await server.ws(readerDevice);
    const modDevice = await server.register("Helper");
    await ownerWs.rpc("role.add", { accountId: modDevice.account.id, role: "Moderator" });
    const mod = await server.ws(modDevice);
    const { channelId } = await ownerWs.rpc<{ channelId: string }>("channel.create", { name: "Talk" });
    const { channelId: otherId } = await ownerWs.rpc<{ channelId: string }>("channel.create", { name: "Other" });
    await ownerWs.rpc("channel.view", { channelId });

    const original = await ownerWs.rpc<{ messageId: string }>("message.send", { channelId, text: "Original question" });
    await expect(ownerWs.rpc("message.send", { channelId: otherId, text: "Wrong", replyTo: original.messageId })).rejects.toThrow("INVALID_REQUEST");
    await expect(ownerWs.rpc("message.send", { channelId, text: "Hi", mentions: { roles: ["Moderator"] } })).rejects.toThrow("INVALID_REQUEST");
    await expect(ownerWs.rpc("message.send", { channelId, text: "Hi", mentions: { accounts: [crypto.randomUUID()] } })).rejects.toThrow("INVALID_REQUEST");

    const reply = await ownerWs.rpc<{ messageId: string }>("message.send", { channelId, text: "@Reader answer",
      replyTo: original.messageId, mentions: { accounts: [readerDevice.account.id, readerDevice.account.id] } });
    const created = await until(() => ownerWs.received.find(({ type, payload }) =>
      type === "message.created" && (payload as Payload).id === reply.messageId), Boolean);
    expect(created!.payload).toMatchObject({ replyTo: { id: original.messageId, senderName: "Owner", text: "Original question" },
      mentions: { accounts: [readerDevice.account.id], roles: [] } });
    const mentioned = await until(() => reader.received.find(({ type }) => type === "message.mentioned"), Boolean);
    expect(mentioned!.payload).toEqual({ channelId, messageId: reply.messageId, senderId: owner.account.id, senderName: "Owner", text: "@Reader answer" });
    expect(reader.received.some(({ type }) => type === "message.created")).toBe(false);
    expect(ownerWs.received.some(({ type }) => type === "message.mentioned")).toBe(false);

    expect((await setMentionable(server, owner, "Moderator", true)).status).toBe(200);
    await ownerWs.rpc("message.send", { channelId, text: "@Moderator look", mentions: { roles: ["Moderator"] } });
    await until(() => mod.received.find(({ type }) => type === "message.mentioned"), Boolean);
    await ownerWs.rpc("channel.override", { channelId, role: "Member", permission: "text", allow: false });
    await ownerWs.rpc("message.send", { channelId, text: "@Reader hidden", mentions: { accounts: [readerDevice.account.id] } });
    await Bun.sleep(100);
    expect(reader.received.filter(({ type }) => type === "message.mentioned")).toHaveLength(1);

    const history = await ownerWs.rpc<StoredMessage[]>("message.history", { channelId });
    expect(history.find(({ id }) => id === reply.messageId)).toMatchObject({ replyTo: { id: original.messageId, text: "Original question" },
      mentions: { accounts: [readerDevice.account.id], roles: [] } });

    await ownerWs.rpc("message.edit", { messageId: reply.messageId, text: "Edited", mentions: {} });
    const edited = await ownerWs.rpc<StoredMessage[]>("message.history", { channelId });
    expect(edited.find(({ id }) => id === reply.messageId)?.mentions).toBeUndefined();

    await ownerWs.rpc("message.delete", { messageId: original.messageId });
    const afterDelete = await ownerWs.rpc<StoredMessage[]>("message.history", { channelId });
    expect(afterDelete.find(({ id }) => id === reply.messageId)?.replyTo).toEqual({ id: original.messageId, missing: true });
  } finally { await server.cleanup(); }
});

test("reactions toggle per account, are limited and disappear with the message", async () => {
  const server = await fixture();
  try {
    const owner = await server.owner();
    const ownerWs = await server.ws(owner);
    const reader = await server.ws(await server.register("Reader"));
    const { channelId } = await ownerWs.rpc<{ channelId: string }>("channel.create", { name: "Reacts" });
    await reader.rpc("channel.view", { channelId });
    const { messageId } = await ownerWs.rpc<{ messageId: string }>("message.send", { channelId, text: "React to me" });
    const react = (socket: typeof ownerWs, emoji: string, reacted = true) => socket.rpc("message.react", { channelId, messageId, emoji, reacted });

    await react(ownerWs, "👍");
    await react(ownerWs, "👍");
    await react(reader, "👍");
    await react(reader, "🇳🇿");
    await react(reader, "👩🏽‍💻");
    const changed = await until(() => reader.received.filter(({ type }) => type === "message.reactionsChanged"), (events) => events.length === 4);
    expect(changed!.at(1)!.payload).toMatchObject({ channelId, messageId, emoji: "👍", count: 2, reacted: true });
    await expect(react(reader, "a")).rejects.toThrow("INVALID_REQUEST");
    await expect(react(reader, "👍👍")).rejects.toThrow("INVALID_REQUEST");

    const reactions = async (socket: typeof ownerWs) =>
      (await socket.rpc<StoredMessage[]>("message.history", { channelId })).find(({ id }) => id === messageId)?.reactions;
    expect(await reactions(ownerWs)).toEqual([{ emoji: "👍", count: 2, me: true }, { emoji: "🇳🇿", count: 1, me: false },
      { emoji: "👩🏽‍💻", count: 1, me: false }]);
    await react(ownerWs, "👍", false);
    expect((await reactions(ownerWs))?.[0]).toEqual({ emoji: "👍", count: 1, me: false });

    const extra = ["😀", "😁", "😂", "🤣", "😃", "😄", "😅", "😆", "😉", "😊", "😋", "😎", "😍", "😘", "🥰", "😗", "😙"];
    for (const emoji of extra) await react(ownerWs, emoji);
    await expect(react(ownerWs, "🙃")).rejects.toThrow("LIMIT");
    await react(ownerWs, "👍");

    await ownerWs.rpc("message.delete", { messageId });
    await expect(react(ownerWs, "👍")).rejects.toThrow("NOT_FOUND");
  } finally { await server.cleanup(); }
});

test("without persistence, replies use live messages and reactions are unavailable", async () => {
  const server = await fixture({ environment: { VOICE_MESSAGING_PERSISTENCE: "false" } });
  try {
    const ownerWs = await server.ws(await server.owner());
    const { channelId } = await ownerWs.rpc<{ channelId: string }>("channel.create", { name: "Live" });
    await ownerWs.rpc("channel.view", { channelId });
    const { messageId } = await ownerWs.rpc<{ messageId: string }>("message.send", { channelId, text: "Live original" });
    const reply = await ownerWs.rpc<{ messageId: string }>("message.send", { channelId, text: "Live reply", replyTo: messageId });
    const created = await until(() => ownerWs.received.find(({ type, payload }) =>
      type === "message.created" && (payload as Payload).id === reply.messageId), Boolean);
    expect((created!.payload as Payload).replyTo).toMatchObject({ id: messageId, text: "Live original", senderName: "Owner" });
    await expect(ownerWs.rpc("message.react", { channelId, messageId, emoji: "👍", reacted: true })).rejects.toThrow("CONFLICT");
  } finally { await server.cleanup(); }
});
