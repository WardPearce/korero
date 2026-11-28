import { expect, test } from "bun:test";
import { Channel, ChannelMessage, KoreroClient, generateIdentity, type ServerSocket, type Snapshot, type Transport } from "../src/index.js";

test("follows a channel, handles live messages, and uses channel and message actions", async () => {
  const origin = "https://korero.example";
  const account = { id: "account", displayName: "Bot", role: "Member" };
  const snapshot: Snapshot = {
    account, connectionId: "connection", channelId: null, channels: [], members: [], presence: [], serverPermissions: [],
  };
  const requests: { type: string; payload: unknown }[] = [];
  const authHeaders: (string | null)[] = [];
  const transport: Transport = {
    async fetch(input, init) {
      const request = new Request(input, init);
      const { pathname } = new URL(request.url);
      if (pathname === "/api/v1/server/info") return Response.json({ serverId: "server" });
      if (pathname === "/api/v1/auth/identity/challenge") {
        return Response.json({ ...await request.json(), id: "challenge", serverId: "server", binding: "", expiresAt: Date.now() + 60000 });
      }
      if (pathname === "/api/v1/auth/identity/login") {
        const proof = await request.json();
        expect(proof.id).toBe("challenge");
        expect(proof.signature).toBeString();
        return Response.json({ account, accessToken: "access", refreshToken: "refresh", accessExpiresAt: Date.now() + 60000 });
      }
      authHeaders.push(request.headers.get("authorization"));
      if (pathname === "/api/v1/auth/connection-ticket") return Response.json({ ticket: "one-time-ticket" });
      if (pathname === "/api/v1/auth/logout") return Response.json({});
      throw new Error(`Unexpected HTTP request ${pathname}`);
    },
    openSocket(url) {
      expect(url).toBe("wss://korero.example/api/v1/ws");
      queueMicrotask(() => socket.onopen?.());
      return socket;
    },
  };
  function receive(frame: object) {
    socket.onmessage?.({ data: JSON.stringify({ version: 1, ...frame }) });
  }
  const socket: ServerSocket = {
    readyState: 1,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    close() { socket.onclose?.(); },
    send(data) {
      const { id, type, payload } = JSON.parse(String(data));
      requests.push({ type, payload });
      const response = type === "connection.authenticate" ? snapshot
        : type === "message.send" ? { messageId: "sent" }
        : type === "message.history" || type === "direct.pending" ? [] : {};
      queueMicrotask(() => receive({ type: "response", id, success: true, payload: response }));
    },
  };

  const client = new KoreroClient(origin, { transport });
  const ready: Snapshot[] = [];
  client.once("ready", (state) => ready.push(state));
  try {
    await client.connect({ identity: await generateIdentity(), deviceName: "Test bot" });
    expect(ready).toEqual([snapshot]);
    expect(client.state.phase).toBe("online");

    const channel = new Channel("channel", client);
    await channel.follow();
    expect(await client.channel(channel.id).send("Hello")).toEqual({ messageId: "sent" });

    const received: ChannelMessage[] = [];
    const onMessage = (message: ChannelMessage) => received.push(message);
    client.on("messageCreate", onMessage);
    const payload = { id: "sent", channelId: channel.id, senderId: account.id, createdAt: Date.now(), text: "Hello" };
    receive({ type: "message.created", payload });
    receive({ type: "message.created", payload });
    expect(received.map(({ text }) => text)).toEqual(["Hello"]);
    expect(received[0]?.channel.id).toBe(channel.id);
    await received[0]?.edit("Edited");
    client.off("messageCreate", onMessage);
    receive({ type: "message.created", payload: { ...payload, id: "second" } });
    expect(received).toHaveLength(1);

    expect(requests).toContainEqual({ type: "channel.view", payload: { channelId: channel.id } });
    expect(requests).toContainEqual({ type: "message.send", payload: { channelId: channel.id, text: "Hello" } });
    expect(requests).toContainEqual({ type: "message.edit", payload: { messageId: "sent", text: "Edited" } });
  } finally {
    await client.disconnect();
  }
  expect(authHeaders).toEqual(["Bearer access", "Bearer access"]);
  expect(client.state.phase).toBe("offline");
});
