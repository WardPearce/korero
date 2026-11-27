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
type Receipt = { messageId: string; queued?: boolean };
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
    expect(await sender.rpc<Receipt>("direct.send", packet)).toEqual({ messageId: packet.id, queued: false });
    for (const socket of [sender, recipient, secondDevice]) {
      const event = await until(() => socket.received.find(({ type }) => type === "direct.created"), Boolean);
      expect(event?.payload).toMatchObject(expected);
      expect(event?.payload).not.toHaveProperty("text");
    }
    expect(await sender.rpc<Receipt>("direct.send", packet)).toEqual({ messageId: packet.id, queued: false });
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
    const queued = await returned.rpc<Packet[]>("direct.pending");
    expect(queued.map(({ id }) => id)).toEqual([offline.id]);
    await returned.rpc("direct.ack", { ids: [offline.id] });
    expect(await returned.rpc<Packet[]>("direct.pending")).toEqual([]);
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

test("live-only servers queue offline sends until a recipient device acknowledges them", async () => {
  const server = await fixture({ environment: { VOICE_MESSAGING_PERSISTENCE: "false" } });
  try {
    const alice = await server.owner();
    const bob = await server.register("Bobby");
    const sender = await server.ws(alice);
    const queued = envelope(bob.account.id);
    expect(await sender.rpc<Receipt>("direct.send", queued)).toEqual({ messageId: queued.id, queued: true });
    expect(await sender.rpc<Receipt>("direct.send", queued)).toEqual({ messageId: queued.id, queued: true });
    await expect(sender.rpc("direct.send", { ...envelope(bob.account.id), id: queued.id })).rejects.toThrow("CONFLICT");

    const recipient = await server.ws(bob);
    expect((recipient.state as { directMessages?: unknown }).directMessages).toMatchObject({ persistent: false, offlineDelivery: true });
    const pending = await recipient.rpc<Packet[]>("direct.pending");
    expect(pending).toEqual([expect.objectContaining({ id: queued.id, ciphertext: queued.ciphertext,
      senderId: alice.account.id, recipientId: bob.account.id })]);
    expect(pending[0]).not.toHaveProperty("deliveredAt");
    expect(await sender.rpc<Packet[]>("direct.pending")).toEqual([]);
    await expect(recipient.rpc("direct.ack", { ids: [] })).rejects.toThrow("INVALID_REQUEST");
    await sender.rpc("direct.ack", { ids: [queued.id] });
    expect(await recipient.rpc<Packet[]>("direct.pending")).toHaveLength(1);
    await recipient.rpc("direct.ack", { ids: [queued.id] });
    expect(await recipient.rpc<Packet[]>("direct.pending")).toEqual([]);

    const live = envelope(bob.account.id);
    expect(await sender.rpc<Receipt>("direct.send", live)).toEqual({ messageId: live.id, queued: false });
    const event = await until(() => recipient.received.find(({ type }) => type === "direct.created"), Boolean);
    expect(event?.payload.id).toBe(live.id);
    expect(await recipient.rpc<Packet[]>("direct.pending")).toEqual([]);
    expect(await recipient.rpc<Inbox>("direct.inbox")).toEqual([]);
    expect(await recipient.rpc<Page>("direct.history", { accountId: alice.account.id })).toEqual({ messages: [], next: null });

    for (const original of [queued, live]) {
      const replacement = { ...envelope(bob.account.id), id: original.id };
      await sender.rpc("direct.edit", replacement);
      const edit = await until(() => recipient.received.find(({ type, payload }) => type === "direct.edited" && payload.id === original.id), Boolean);
      expect(edit?.payload).toMatchObject({ id: original.id, senderId: alice.account.id, recipientId: bob.account.id,
        ciphertext: replacement.ciphertext, editedAt: expect.any(Number),
        createdAt: original === queued ? pending[0]!.createdAt : event?.payload.createdAt });
      await sender.rpc("direct.delete", { accountId: bob.account.id, id: original.id });
      const deleted = await until(() => recipient.received.find(({ type, payload }) => type === "direct.deleted" && payload.id === original.id), Boolean);
      expect(deleted?.payload).toEqual({ id: original.id, senderId: alice.account.id, recipientId: bob.account.id });
      await expect(sender.rpc("direct.edit", replacement)).rejects.toThrow("NOT_FOUND");
    }
    expect(await recipient.rpc<Packet[]>("direct.pending")).toEqual([]);
    expect(await recipient.rpc<Page>("direct.history", { accountId: alice.account.id })).toEqual({ messages: [], next: null });
  } finally { await server.cleanup(); }
});

test("offline delivery limits the queue for each recipient", async () => {
  const server = await fixture({ environment: { VOICE_MESSAGING_OFFLINE_DELIVERY_QUEUE: "2" } });
  try {
    const alice = await server.owner();
    const bob = await server.register("Bobby");
    const sender = await server.ws(alice);
    await sender.rpc("direct.send", envelope(bob.account.id));
    await sender.rpc("direct.send", envelope(bob.account.id));
    await expect(sender.rpc("direct.send", envelope(bob.account.id))).rejects.toThrow("LIMIT");
    const recipient = await server.ws(bob);
    const pending = await recipient.rpc<Packet[]>("direct.pending");
    expect(pending).toHaveLength(2);
    await recipient.rpc("direct.ack", { ids: pending.map(({ id }) => id) });
    recipient.close();
    await recipient.closed;
    await until(() => sender.received.some(({ type, payload }) => type === "presence.offline" && payload.accountId === bob.account.id), Boolean);
    await sender.rpc("direct.send", envelope(bob.account.id));
  } finally { await server.cleanup(); }
});

test("offline delivery limits how much one sender can queue for a recipient", async () => {
  const server = await fixture({ environment: { VOICE_MESSAGING_OFFLINE_DELIVERY_PER_SENDER: "1" } });
  try {
    const alice = await server.owner();
    const bob = await server.register("Bobby");
    const carol = await server.register("Carol");
    const fromAlice = await server.ws(alice);
    const fromCarol = await server.ws(carol);
    await fromAlice.rpc("direct.send", envelope(bob.account.id));
    await expect(fromAlice.rpc("direct.send", envelope(bob.account.id))).rejects.toThrow("LIMIT");
    expect(await fromCarol.rpc<Receipt>("direct.send", envelope(bob.account.id))).toMatchObject({ queued: true });
  } finally { await server.cleanup(); }
});

test("senders edit and delete their own direct messages", async () => {
  const server = await fixture({ environment: { VOICE_MESSAGING_PERSISTENCE: "true" } });
  try {
    const alice = await server.owner();
    const bob = await server.register("Bobby");
    const sender = await server.ws(alice);
    const recipient = await server.ws(bob);
    const original = envelope(bob.account.id);
    await sender.rpc("direct.send", original);
    const replacement = { ...envelope(bob.account.id), id: original.id };
    await expect(recipient.rpc("direct.edit", { ...replacement, accountId: alice.account.id })).rejects.toThrow("NOT_FOUND");
    await expect(sender.rpc("direct.edit", { ...replacement, id: crypto.randomUUID() })).rejects.toThrow("NOT_FOUND");
    await sender.rpc("direct.edit", replacement);
    for (const socket of [sender, recipient]) {
      const event = await until(() => socket.received.find(({ type }) => type === "direct.edited"), Boolean);
      expect(event?.payload).toMatchObject({ id: original.id, ciphertext: replacement.ciphertext, senderId: alice.account.id });
      expect(typeof event?.payload.editedAt).toBe("number");
    }
    const stored = await recipient.rpc<Page>("direct.history", { accountId: alice.account.id });
    expect(stored.messages).toEqual([expect.objectContaining({ id: original.id, ciphertext: replacement.ciphertext, nonce: replacement.nonce })]);
    expect(stored.messages[0]).toHaveProperty("editedAt");

    await expect(recipient.rpc("direct.delete", { accountId: alice.account.id, id: original.id })).rejects.toThrow("NOT_FOUND");
    await sender.rpc("direct.delete", { accountId: bob.account.id, id: original.id });
    for (const socket of [sender, recipient]) {
      const event = await until(() => socket.received.find(({ type }) => type === "direct.deleted"), Boolean);
      expect(event?.payload).toEqual({ id: original.id, senderId: alice.account.id, recipientId: bob.account.id });
    }
    expect(await recipient.rpc<Page>("direct.history", { accountId: alice.account.id })).toEqual({ messages: [], next: null });
  } finally { await server.cleanup(); }
});
