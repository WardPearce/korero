import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { fixture, testIdentity, until, type Device } from "../server";

const envelope = (accountId: string) => ({
  accountId,
  id: crypto.randomUUID(),
  nonce: randomBytes(12).toString("base64url"),
  ciphertext: randomBytes(25).toString("base64url"),
  signature: randomBytes(64).toString("base64url"),
});
type Cursor = { id: string; createdAt: number };
type Packet = Omit<ReturnType<typeof envelope>, "accountId"> & Cursor & { senderId: string; recipientId: string };
type Page = { messages: Packet[]; next: Cursor | null };
type Receipt = { messageId: string };
type Inbox = { accountId: string; displayName: string; lastMessageAt: number }[];

test("direct messages reach only the two accounts and survive an offline recipient", async () => {
  const server = await fixture({ environment: { VOICE_MESSAGING_PERSISTENCE: "true" } });
  try {
    const alice = await server.owner();
    const identity = testIdentity();
    const bob = await server.register("Bobby", identity);
    const carol = await server.register("Carol");
    const { payload: bobSecondDevice } = await server.call<Device>("/api/v1/auth/identity/login", await server.proof("login", identity));
    const sender = await server.ws(alice);
    const recipient = await server.ws(bob);
    const secondDevice = await server.ws(bobSecondDevice);
    const bystander = await server.ws(carol);
    const accountId = bob.account.id;

    expect(sender.state.channelId).toBeNull();
    expect(await sender.rpc("direct.peer", { accountId })).toMatchObject({
      accountId, displayName: "Bobby", publicKey: identity.publicKey.export({ format: "jwk" }).x,
    });
    await expect(sender.rpc("message.send", { accountId, text: "plaintext" })).rejects.toThrow("INVALID_REQUEST");
    await expect(sender.rpc("direct.send", { ...envelope(accountId), text: "plaintext" })).rejects.toThrow("INVALID_REQUEST");

    const packet = envelope(accountId);
    const expected = { id: packet.id, nonce: packet.nonce, ciphertext: packet.ciphertext, signature: packet.signature,
      senderId: alice.account.id, recipientId: accountId };
    expect(await sender.rpc<Receipt>("direct.send", packet)).toEqual({ messageId: packet.id });
    for (const socket of [sender, recipient, secondDevice]) {
      const event = await until(() => socket.received.find(({ type }) => type === "direct.created"), Boolean);
      expect(event?.payload).toMatchObject(expected);
      expect(event?.payload).not.toHaveProperty("text");
    }
    expect(await sender.rpc<Receipt>("direct.send", packet)).toEqual({ messageId: packet.id });
    expect(sender.received.filter(({ type }) => type === "direct.created")).toHaveLength(1);
    await expect(sender.rpc("direct.send", { ...envelope(accountId), id: packet.id })).rejects.toThrow("CONFLICT");
    expect(await bystander.rpc<Page>("direct.history", { accountId })).toEqual({ messages: [], next: null });
    expect(bystander.received.some(({ type }) => type === "direct.created")).toBe(false);

    recipient.close();
    secondDevice.close();
    await Promise.all([recipient.closed, secondDevice.closed]);
    await until(() => sender.received.some(({ type, payload }) => type === "presence.offline" && payload.accountId === accountId), Boolean);
    const offline = envelope(accountId);
    await sender.rpc("direct.send", offline);
    const returned = await server.ws(bob);
    expect(await returned.rpc<Inbox>("direct.inbox")).toMatchObject([{ accountId: alice.account.id, displayName: "Owner" }]);
    const conversation = { accountId: alice.account.id };
    const history = await returned.rpc<Page>("direct.history", conversation);
    expect(history.messages).toHaveLength(2);
    expect(history.messages).toContainEqual(expect.objectContaining(expected));
    expect(history.messages).toContainEqual(expect.objectContaining({
      id: offline.id, ciphertext: offline.ciphertext, signature: offline.signature, nonce: offline.nonce,
    }));
    expect(history.next).toBeNull();

    const replies = Array.from({ length: 10 }, () => envelope(alice.account.id));
    for (const reply of replies) await returned.rpc("direct.send", reply);
    const firstPage = await returned.rpc<Page>("direct.history", conversation);
    expect(firstPage.messages).toHaveLength(10);
    expect(firstPage.next).not.toBeNull();
    const secondPage = await returned.rpc<Page>("direct.history", { ...conversation, before: firstPage.next });
    expect(secondPage.messages).toHaveLength(2);
    expect(secondPage.next).toBeNull();
    expect(new Set([...firstPage.messages, ...secondPage.messages].map(({ id }) => id))).toEqual(
      new Set([packet.id, offline.id, ...replies.map(({ id }) => id)]),
    );
  } finally { await server.cleanup(); }
});

test("live-only servers reject offline sends and return no direct message history", async () => {
  const server = await fixture();
  try {
    const alice = await server.owner();
    const bob = await server.register("Bobby");
    const sender = await server.ws(alice);
    const packet = envelope(bob.account.id);
    await expect(sender.rpc("direct.send", packet)).rejects.toThrow("CONFLICT");
    const recipient = await server.ws(bob);
    await sender.rpc("direct.send", packet);
    const event = await until(() => recipient.received.find(({ type }) => type === "direct.created"), Boolean);
    expect(event?.payload.id).toBe(packet.id);
    expect(await recipient.rpc<Inbox>("direct.inbox")).toEqual([]);
    expect(await recipient.rpc<Page>("direct.history", { accountId: alice.account.id })).toEqual({ messages: [], next: null });
  } finally { await server.cleanup(); }
});
