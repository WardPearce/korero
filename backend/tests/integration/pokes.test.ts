import { expect, test } from "bun:test";
import { fixture, testIdentity, until, type Device } from "../server";

test("pokes notify only the recipient's active devices and do not enter direct message history", async () => {
  const server = await fixture({ environment: { VOICE_MESSAGING_PERSISTENCE: "true" } });
  const sockets: Awaited<ReturnType<typeof server.ws>>[] = [];
  async function connect(device: Device) {
    const socket = await server.ws(device);
    sockets.push(socket);
    return socket;
  }
  try {
    const alice = await server.owner();
    const identity = testIdentity();
    const bob = await server.register("Bobby", identity);
    const carol = await server.register("Carol");
    const { payload: secondDevice } = await server.call<Device>("/api/v1/auth/identity/login", await server.proof("login", identity));
    const sender = await connect(alice);
    const recipient = await connect(bob);
    const recipientOtherDevice = await connect(secondDevice);
    const bystander = await connect(carol);
    const accountId = bob.account.id;
    const pokes = (socket: typeof sender) => socket.received.filter(({ type }) => type === "direct.poked");

    await expect(sender.rpc("direct.poke", { accountId: alice.account.id })).rejects.toThrow("INVALID_REQUEST");
    await expect(sender.rpc("direct.poke", { accountId, message: "x".repeat(201) })).rejects.toThrow("INVALID_REQUEST");
    const payload = { accountId, message: "  Ready to talk?  " };
    expect(await sender.rpc("direct.poke", payload)).toEqual({});
    expect(await sender.rpc("direct.poke", payload, 4)).toEqual({});
    expect(await sender.rpc("direct.poke", { accountId })).toEqual({});

    for (const socket of [recipient, recipientOtherDevice]) {
      const events = await until(() => pokes(socket), (events) => events.length >= 2);
      expect(events).toHaveLength(2);
      expect(events[0]!.payload).toMatchObject({
        senderId: alice.account.id, senderName: "Owner", recipientId: accountId, message: "Ready to talk?",
      });
      expect(events[1]!.payload).not.toHaveProperty("message");
    }
    expect(pokes(sender)).toHaveLength(0);
    expect(pokes(bystander)).toHaveLength(0);
    expect(await recipient.rpc<unknown>("direct.inbox")).toEqual([]);
    expect(await recipient.rpc<unknown>("direct.history", { accountId: alice.account.id })).toEqual({ messages: [], next: null });

    recipient.close();
    recipientOtherDevice.close();
    await Promise.all([recipient.closed, recipientOtherDevice.closed]);
    await until(() => sender.received.some(({ type, payload }) => type === "presence.offline" && payload.accountId === accountId), Boolean);
    await expect(sender.rpc("direct.poke", { accountId })).rejects.toThrow("CONFLICT");
  } finally {
    for (const socket of sockets) socket.close();
    await Promise.all(sockets.map(({ closed }) => closed));
    await server.cleanup();
  }
});
