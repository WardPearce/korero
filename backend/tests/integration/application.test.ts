import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { fixture, openSocket, type Snapshot, until } from "../server";
import { LOBBY } from "../../src/database";
import type { SearchPage } from "../../src/modules/message-search-worker";

test("channel pins follow chat access, pin permissions and message deletion", async () => {
  const server = await fixture();
  try {
    const owner = await server.ws(await server.owner());
    const member = await server.register("Reader");
    const reader = await server.ws(member);
    const { channelId } = await owner.rpc<{ channelId: string }>("channel.create", { name: "Pinned discussion" });
    await reader.rpc("channel.view", { channelId });
    const first = await reader.rpc<{ messageId: string }>("message.send", { channelId, text: "First pin" });
    const second = await owner.rpc<{ messageId: string }>("message.send", { channelId, text: "Second pin" });
    const pin = (socket: typeof owner, messageId: string, pinned = true) => socket.rpc("message.pin", { channelId, messageId, pinned });
    const pins = (socket: typeof owner) => socket.rpc<{ messages: { id: string; senderName: string }[] }>("message.pins", { channelId });

    await expect(pin(reader, first.messageId)).rejects.toThrow("FORBIDDEN");
    await expect(owner.rpc("message.pin", { channelId: LOBBY, messageId: first.messageId, pinned: true })).rejects.toThrow("NOT_FOUND");
    await pin(owner, first.messageId);
    await pin(owner, second.messageId);
    await pin(owner, second.messageId);
    await until(() => reader.received.find(({ type, payload }) =>
      type === "message.pinChanged" && payload.messageId === first.messageId), Boolean);
    expect((await pins(reader)).messages.map(({ id }) => id).sort()).toEqual([first.messageId, second.messageId].sort());
    expect((await pins(owner)).messages).toContainEqual(expect.objectContaining({ id: first.messageId, senderName: "Reader" }));
    const context = await reader.rpc<{ id: string; pinnedAt: number }[]>("message.context", { channelId, ...first });
    expect(context).toContainEqual(expect.objectContaining({ id: first.messageId, senderName: "Reader", pinnedAt: expect.any(Number) }));
    expect(context).toHaveLength(2);
    await expect(pin(reader, first.messageId, false)).rejects.toThrow("FORBIDDEN");

    await owner.rpc("role.add", { accountId: member.account.id, role: "Moderator" });
    await owner.rpc("channel.override", { channelId, role: "Moderator", permission: "pinMessages", allow: false });
    await expect(pin(reader, second.messageId, false)).rejects.toThrow("FORBIDDEN");
    await owner.rpc("channel.override", { channelId, role: "Moderator", permission: "pinMessages", allow: null });
    await pin(reader, second.messageId, false);
    expect((await pins(reader)).messages).toMatchObject([{ id: first.messageId }]);
    await owner.rpc("channel.override", { channelId, role: "Moderator", permission: "text", allow: false });
    await expect(pins(reader)).rejects.toThrow("FORBIDDEN");
    await expect(reader.rpc("message.context", { channelId, ...first })).rejects.toThrow("FORBIDDEN");
    await owner.rpc("channel.override", { channelId, role: "Moderator", permission: "text", allow: null });

    await reader.rpc("message.delete", first);
    expect((await pins(owner)).messages).toEqual([]);
    await expect(owner.rpc("message.context", { channelId, ...first })).rejects.toThrow("NOT_FOUND");
  } finally { await server.cleanup(); }
});

test("channel search matches stored text newest first and follows chat access", async () => {
  const server = await fixture();
  try {
    const owner = await server.ws(await server.owner());
    const member = await server.register("Searcher");
    const reader = await server.ws(member);
    const { channelId } = await owner.rpc<{ channelId: string }>("channel.create", { name: "Searchable" });
    expect(owner.state.channels.find(({ id }) => id === LOBBY)).toMatchObject({ messageSearch: true });
    await reader.rpc("channel.view", { channelId });
    const search = (query: string, before?: SearchPage["next"]) =>
      reader.rpc<SearchPage>("message.search", { channelId, query, before: before ?? undefined });
    const sent: string[] = [];
    for (let index = 0; index < 27; index++) {
      sent.push((await owner.rpc<{ messageId: string }>("message.send", { channelId, text: `Deploy note ${index}` })).messageId);
    }
    await owner.rpc("message.send", { channelId, text: "100% literal under_score" });
    const long = await owner.rpc<{ messageId: string }>("message.send", { channelId, text: "a".repeat(400) + " needle " + "b".repeat(400) });

    const first = await search("DEPLOY");
    expect(first.messages).toHaveLength(25);
    const second = await search("deploy", first.next);
    expect(first.next).not.toBeNull();
    expect(second.next).toBeNull();
    const found = [...first.messages, ...second.messages];
    expect(found.map(({ id }) => id).sort()).toEqual(sent.toSorted());
    expect(found).toEqual(found.toSorted((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)));
    expect((await search("0% l")).messages).toMatchObject([{ text: "100% literal under_score" }]);
    expect((await search("lit_ral")).messages).toEqual([]);
    expect((await search("r_s")).messages).toHaveLength(1);
    expect((await search("%")).messages).toHaveLength(1);
    const preview = (await search("needle")).messages[0]!;
    expect(preview.id).toBe(long.messageId);
    expect(preview.text).toStartWith("…");
    expect(preview.text).toEndWith("…");
    expect(preview.text).toContain(" needle ");
    await expect(search(" ")).rejects.toThrow("INVALID_REQUEST");

    await owner.rpc("message.delete", { messageId: sent[0] });
    expect((await search("Deploy note 0")).messages).toEqual([]);
    await owner.rpc("channel.override", { channelId, role: "Member", permission: "text", allow: false });
    await expect(search("deploy")).rejects.toThrow("FORBIDDEN");
  } finally { await server.cleanup(); }
});

test("channel search continues past empty windows and enforces both quotas", async () => {
  const server = await fixture({ environment: {
    VOICE_LIMITS_MESSAGE_SEARCHES_PER_MINUTE: "3",
    VOICE_LIMITS_MESSAGE_SEARCHES_GLOBAL_PER_MINUTE: "4",
  } });
  try {
    const owner = await server.owner();
    const reader = await server.ws(await server.register("First reader"));
    const other = await server.ws(await server.register("Second reader"));
    const search = (socket: typeof reader, before?: SearchPage["next"]) =>
      socket.rpc<SearchPage>("message.search", { channelId: LOBBY, query: "needle", before: before ?? undefined });
    const db = new Database(join(server.directory, "server.db"));
    try {
      db.run("PRAGMA busy_timeout = 3000");
      const insert = db.query("INSERT INTO messages (id, channel_id, sender_id, text, created_at) VALUES (?, ?, ?, ?, ?)");
      const createdAt = Date.now();
      db.transaction(() => {
        insert.run(crypto.randomUUID(), LOBBY, owner.account.id, "An older needle", createdAt - 1);
        for (let count = 0; count < 2048; count++) {
          insert.run(crypto.randomUUID(), LOBBY, owner.account.id, "Ordinary message", createdAt);
        }
      })();
    } finally { db.close(); }

    const page = await search(reader);
    expect(page.messages).toEqual([]);
    expect(page.next).not.toBeNull();
    expect(await search(reader, page.next)).toMatchObject({ messages: [{ text: "An older needle" }], next: null });
    expect(await search(reader)).toEqual(page);
    await expect(search(reader)).rejects.toThrow("RATE_LIMITED");
    expect(await search(other)).toEqual(page);
    await expect(search(other)).rejects.toThrow("RATE_LIMITED");
  } finally { await server.cleanup(); }
});

test("connection info keeps diagnostics scoped to the session and visible channel members", async () => {
  const server = await fixture();
  try {
    const owner = await server.owner();
    const member = await server.register("Viewer");
    const ownerWs = await server.ws(owner);
    const memberWs = await server.ws(member);
    try {
      const path = `/api/v1/connections/${ownerWs.state.connectionId}`;
      type ConnectionInfo = { displayName: string; channelName: string | null; connectedSeconds: number; latencyMs: number | null };
      const info = (token: string) => server.call<ConnectionInfo>(path, undefined, token);
      expect((await server.fail(path)).status).toBe(401);
      expect((await info(member.accessToken)).response.status).toBe(404);
      const own = await until(() => info(owner.accessToken), ({ response, payload }) => response.ok && payload.latencyMs !== null);
      expect(own.payload).toEqual({ displayName: "Owner", channelName: null, connectedSeconds: expect.any(Number), latencyMs: expect.any(Number) });

      const { channelId } = await ownerWs.rpc<{ channelId: string }>("channel.create", { name: "Studio" });
      await ownerWs.rpc("channel.join", { channelId });
      const visible = await info(member.accessToken);
      expect(visible.response.status).toBe(200);
      expect(visible.payload).toEqual({ displayName: "Owner", channelName: "Studio", connectedSeconds: expect.any(Number), latencyMs: expect.any(Number) });

      await ownerWs.rpc("channel.override", { channelId, role: "Member", permission: "join", allow: false });
      expect((await info(member.accessToken)).response.status).toBe(404);
      expect((await info(owner.accessToken)).response.status).toBe(200);
      ownerWs.close();
      await ownerWs.closed;
      expect((await info(owner.accessToken)).response.status).toBe(404);
    } finally {
      ownerWs.close();
      memberWs.close();
      await Promise.all([ownerWs.closed, memberWs.closed]);
    }
  } finally { await server.cleanup(); }
});

test("attachments follow session ownership, channel permissions, history and deletion", async () => {
  const server = await fixture({ environment: { VOICE_MESSAGING_PERSISTENCE: "true",
    VOICE_LIMITS_ATTACHMENT_DOWNLOAD_BYTES_PER_MINUTE: "33554432" } });
  try {
    const owner = await server.owner();
    const member = await server.register("Member");
    const ownerWs = await server.ws(owner);
    const memberWs = await server.ws(member);
    const { channelId } = await ownerWs.rpc<{ channelId: string }>("channel.create", { name: "Files", audioBitrate: 56000 });
    await expect(memberWs.rpc("channel.edit", { channelId, audioBitrate: 32000 })).rejects.toThrow("FORBIDDEN");
    await expect(ownerWs.rpc("channel.edit", { channelId, audioBitrate: 128001 })).rejects.toThrow("INVALID_REQUEST");
    await ownerWs.rpc("channel.join", { channelId });
    await memberWs.rpc("channel.join", { channelId: LOBBY });
    const connectionId = ownerWs.state.connectionId;
    const name = "shared.txt";
    const bytes = Buffer.alloc(5 * 1024 * 1024, 65);
    const data = bytes.toString("base64");
    const upload = { connectionId, channelId, name, data, text: "Shared file", html: "<p><em>Shared file</em></p>" };
    const path = "/api/v1/chat/attachments";
    expect((await server.fail(path + "/", { data: "invalid" })).status).toBe(401);
    expect((await server.fail(path, { ...upload, data: "YQ==" }, member.accessToken)).status).toBe(403);
    expect((await server.fail(path, { ...upload, data: "YQ=" }, owner.accessToken)).status).toBe(400);
    expect(await server.fail(path, upload, owner.accessToken)).toMatchObject({ status: 429, payload: { error: { code: "LIMIT" } } });
    const preferences = "/api/v1/admin/preferences";
    expect((await server.call(preferences, { maxAttachmentMiB: 6 }, owner.accessToken, "PATCH")).response.status).toBe(200);
    const { response, payload } = await server.call<{ messageId: string }>(path, upload, owner.accessToken);
    expect(response.status).toBe(200);
    expect((await server.call(preferences, { maxAttachmentMiB: 1 }, owner.accessToken, "PATCH")).response.status).toBe(200);
    const download = path + "/" + payload.messageId + "?connectionId=" + memberWs.state.connectionId;
    await ownerWs.rpc("channel.override", { channelId, role: "Member", permission: "text", allow: false });
    expect((await server.fail(download, undefined, member.accessToken)).status).toBe(404);
    await ownerWs.rpc("channel.override", { channelId, role: "Member", permission: "text", allow: null });
    await memberWs.rpc("channel.join", { channelId });
    expect(await memberWs.rpc("message.history", { channelId })).toMatchObject([
      { id: payload.messageId, text: upload.text, html: upload.html, attachment: { name, size: bytes.length } },
    ]);
    const downloaded = await server.call<{ data: string }>(download, undefined, member.accessToken);
    expect(downloaded.payload.data === data).toBe(true);
    for (let index = 0; index < 5; index++) {
      const response = await fetch(server.origin + download, { tls: server.tls, headers: { authorization: `Bearer ${member.accessToken}` } });
      expect(response.ok).toBe(true);
      await response.arrayBuffer();
    }
    expect((await server.fail(download, undefined, member.accessToken)).status).toBe(429);
    await ownerWs.rpc("message.delete", payload);
    expect((await server.fail(download, undefined, member.accessToken)).status).toBe(404);
  } finally { await server.cleanup(); }
});

test("members can read and send in channels they have not joined", async () => {
  const server = await fixture({ environment: { VOICE_MESSAGING_PERSISTENCE: "true" } });
  try {
    const owner = await server.owner();
    const member = await server.register("Outsider");
    const ownerWs = await server.ws(owner);
    const memberWs = await server.ws(member);
    const { channelId } = await ownerWs.rpc<{ channelId: string }>("channel.create", { name: "Studio" });
    await ownerWs.rpc("channel.join", { channelId });
    await memberWs.rpc("channel.join", { channelId: LOBBY });
    type ChatChannel = { id: string; canChat?: boolean; canAttachFiles?: boolean };
    const studio = async () => (await memberWs.rpc<{ channels: ChatChannel[] }>("state.get")).channels.find(({ id }) => id === channelId);
    expect(await studio()).toMatchObject({ canChat: true, canAttachFiles: true });

    const before = await ownerWs.rpc<{ messageId: string }>("message.send", { channelId, text: "Inside" });
    expect(await memberWs.rpc("message.history", { channelId })).toMatchObject([{ id: before.messageId, text: "Inside" }]);
    const outside = await memberWs.rpc<{ messageId: string }>("message.send", { channelId, text: "From outside" });
    const event = await until(() => ownerWs.received.find(({ type, payload }) => type === "message.created" && payload.id === outside.messageId), Boolean);
    expect(event?.payload).toMatchObject({ senderId: member.account.id, senderName: "Outsider" });
    expect(memberWs.received.some(({ payload }) => payload.id === outside.messageId)).toBe(false);

    await memberWs.rpc("channel.view", { channelId });
    const live = await ownerWs.rpc<{ messageId: string }>("message.send", { channelId, text: "Live" });
    await until(() => memberWs.received.find(({ type, payload }) => type === "message.created" && payload.id === live.messageId), Boolean);
    await memberWs.rpc("message.edit", { ...outside, text: "Edited outside" });
    await until(() => ownerWs.received.find(({ type, payload }) => type === "message.edited" && payload.messageId === outside.messageId), Boolean);
    await memberWs.rpc("message.delete", outside);
    await until(() => memberWs.received.find(({ type, payload }) => type === "message.deleted" && payload.messageId === outside.messageId), Boolean);
    await expect(memberWs.rpc("message.delete", live)).rejects.toThrow("FORBIDDEN");

    await ownerWs.rpc("channel.override", { channelId, role: "Member", permission: "text", allow: false });
    expect(await studio()).toMatchObject({ canChat: false, canAttachFiles: false });
    expect(memberWs.received.find(({ type }) => type === "channel.viewEnded")?.payload).toEqual({ channelId });
    await expect(memberWs.rpc("message.send", { channelId, text: "Denied" })).rejects.toThrow("FORBIDDEN");
    await expect(memberWs.rpc("channel.view", { channelId })).rejects.toThrow("FORBIDDEN");
    const hidden = await ownerWs.rpc<{ messageId: string }>("message.send", { channelId, text: "Hidden" });
    await ownerWs.rpc("channel.override", { channelId, role: "Member", permission: "text", allow: null });
    // Losing access drops the subscription, so restoring it needs a fresh view.
    const after = await ownerWs.rpc<{ messageId: string }>("message.send", { channelId, text: "After" });
    await until(() => ownerWs.received.find(({ type, payload }) => type === "message.created" && payload.id === after.messageId), Boolean);
    expect(memberWs.received.some(({ payload }) => payload.id === hidden.messageId || payload.id === after.messageId)).toBe(false);

    await memberWs.rpc("channel.view", { channelId });
    await ownerWs.rpc("channel.edit", { channelId, password: "secret phrase" });
    expect(await studio()).toMatchObject({ canChat: false });
    expect(memberWs.received.filter(({ type }) => type === "channel.viewEnded").map(({ payload }) => payload))
      .toEqual([{ channelId }, { channelId }]);
    const locked = await ownerWs.rpc<{ messageId: string }>("message.send", { channelId, text: "Locked" });
    await expect(memberWs.rpc("message.history", { channelId })).rejects.toThrow("FORBIDDEN");
    await memberWs.rpc("channel.join", { channelId, password: "secret phrase" });
    expect(await studio()).toMatchObject({ canChat: true });
    expect(memberWs.received.some(({ payload }) => payload.id === locked.messageId)).toBe(false);
    await memberWs.rpc("channel.view", { channelId: null });
  } finally { await server.cleanup(); }
});

test("live attachment quotas apply per sender and release capacity on deletion", async () => {
  const server = await fixture({ environment: { VOICE_MESSAGING_PERSISTENCE: "false" } });
  try {
    const alice = await server.register("Alice");
    const bob = await server.register("Bobby");
    const aliceWs = await server.ws(alice);
    const bobWs = await server.ws(bob);
    await aliceWs.rpc("channel.join", { channelId: LOBBY });
    await bobWs.rpc("channel.join", { channelId: LOBBY });
    const data = Buffer.alloc(3 * 1024 * 1024).toString("base64");
    const upload = (connectionId: string, accessToken: string) => server.call<{ messageId: string }>("/api/v1/chat/attachments",
      { connectionId, channelId: LOBBY, name: "file.bin", data, text: "" }, accessToken);
    const aliceUpload = () => upload(aliceWs.state.connectionId, alice.accessToken);
    const first = await aliceUpload();
    expect(first.response.status).toBe(200);
    expect((await aliceUpload()).response.status).toBe(200);
    expect((await aliceUpload()).response.status).toBe(429);
    expect((await upload(bobWs.state.connectionId, bob.accessToken)).response.status).toBe(200);
    await aliceWs.rpc("message.delete", first.payload);
    expect((await aliceUpload()).response.status).toBe(200);
  } finally { await server.cleanup(); }
});

test("live channel messages can be edited and deleted without entering history", async () => {
  const server = await fixture({ environment: { VOICE_MESSAGING_PERSISTENCE: "false" } });
  try {
    const moderator = await server.ws(await server.owner());
    const sender = await server.ws(await server.register("Alice"));
    for (const socket of [moderator, sender]) await socket.rpc("channel.join", { channelId: LOBBY });

    const sent = await sender.rpc<{ messageId: string }>("message.send", { channelId: LOBBY, text: "Original" });
    await sender.rpc("message.edit", { ...sent, text: "Updated" });
    const edit = await until(() => moderator.received.find(({ type }) => type === "message.edited"), Boolean);
    expect(edit?.payload).toEqual({ ...sent, text: "Updated", editedAt: expect.any(Number) });
    expect(await sender.rpc<unknown[]>("message.history", { channelId: LOBBY })).toEqual([]);

    await moderator.rpc("message.delete", sent);
    const deletion = await until(() => sender.received.find(({ type }) => type === "message.deleted"), Boolean);
    expect(deletion?.payload).toEqual(sent);
    await expect(sender.rpc("message.edit", { ...sent, text: "Restored" })).rejects.toThrow("NOT_FOUND");
  } finally { await server.cleanup(); }
});

test("WebSocket upgrades share a rate limit across route forms and pending slots are released", async () => {
  const server = await fixture({ environment: { VOICE_LIMITS_PENDING_CONNECTIONS_PER_IP: "1", VOICE_LIMITS_UPGRADES_PER_MINUTE: "3" } });
  try {
    const first = await openSocket(server.origin, server.tls);
    const second = await openSocket(server.origin, server.tls, undefined, "/api/v1/ws/");
    expect((await second.closed).code).toBe(4429);
    first.close();
    await first.closed;
    const third = await openSocket(server.origin, server.tls);
    await expect(openSocket(server.origin, server.tls, undefined, "/api/v1/ws/")).rejects.toThrow("WebSocket upgrade failed");
    third.close();
    expect((await third.closed).code).not.toBe(4429);
  } finally { await server.cleanup(); }
});

test("channels, inheritance, password membership, moderation and text are permission-scoped", async () => {
  const server = await fixture({ environment: { VOICE_MESSAGING_PERSISTENCE: "true" } });
  try {
    const owner = await server.owner();
    const alice = await server.register("Alice");
    const bob = await server.register("Bobby");
    const adminWs = await server.ws(owner);
    const aliceWs = await server.ws(alice);
    const bobWs = await server.ws(bob);
    const create = (payload: object) => adminWs.rpc<{ channelId: string; state: Snapshot }>("channel.create", payload);
    const parent = await create({ name: "Parent", position: 1 });
    const child = await create({ name: "Child", parentId: parent.channelId, password: "private phrase" });
    await expect(aliceWs.rpc("channel.create", { name: "Unauthorized" })).rejects.toThrow("FORBIDDEN");
    const backgroundImageUrl = "https://images.example/room.jpg";
    await expect(aliceWs.rpc("channel.edit", { channelId: parent.channelId, backgroundImageUrl })).rejects.toThrow("FORBIDDEN");
    await expect(adminWs.rpc("channel.edit", { channelId: parent.channelId, backgroundImageUrl: "http://images.example/room.jpg" }))
      .rejects.toThrow("INVALID_REQUEST");
    await adminWs.rpc("channel.edit", { channelId: parent.channelId, backgroundImageUrl });
    await adminWs.rpc("channel.edit", { channelId: parent.channelId, name: "Renamed parent" });
    expect((await aliceWs.rpc<Snapshot>("state.get")).channels).toContainEqual(expect.objectContaining({ id: parent.channelId, backgroundImageUrl }));
    await adminWs.rpc("channel.edit", { channelId: parent.channelId, backgroundImageUrl: null });
    expect((await aliceWs.rpc<Snapshot>("state.get")).channels).toContainEqual(expect.objectContaining({
      id: parent.channelId, backgroundImageUrl: null,
    }));
    const icon = "🎮";
    await adminWs.rpc("channel.edit", { channelId: parent.channelId, icon });
    expect((await aliceWs.rpc<Snapshot>("state.get")).channels).toContainEqual(expect.objectContaining({ id: parent.channelId, icon }));
    await expect(adminWs.rpc("channel.edit", { channelId: parent.channelId, icon: " " })).rejects.toThrow("INVALID_REQUEST");
    await adminWs.rpc("channel.edit", { channelId: parent.channelId, icon: null });
    expect((await aliceWs.rpc<Snapshot>("state.get")).channels).toContainEqual(expect.objectContaining({
      id: parent.channelId, icon: null,
    }));
    await expect(aliceWs.rpc("role.add", { accountId: alice.account.id, role: "Owner" })).rejects.toThrow("FORBIDDEN");
    await expect(adminWs.rpc("role.add", { accountId: owner.account.id, role: "Member" })).rejects.toThrow("FORBIDDEN");
    await adminWs.rpc("channel.override", { channelId: parent.channelId, role: "Member", permission: "join", allow: false });
    await expect(aliceWs.rpc("channel.join", { channelId: child.channelId, password: "private phrase" })).rejects.toThrow("FORBIDDEN");
    await adminWs.rpc("channel.override", { channelId: child.channelId, role: "Member", permission: "join", allow: true });
    await expect(aliceWs.rpc("channel.join", { channelId: child.channelId, password: "wrong" })).rejects.toThrow("FORBIDDEN");
    expect((await aliceWs.rpc<Snapshot>("channel.join", { channelId: child.channelId, password: "private phrase" })).channelId).toBe(child.channelId);
    await expect(bobWs.rpc("message.history", { channelId: child.channelId })).rejects.toThrow("FORBIDDEN");
    await bobWs.rpc("channel.join", { channelId: child.channelId, password: "private phrase" });
    await until(() => aliceWs.received.find((event) => event.type === "channel.userJoined" && event.payload.accountId === bob.account.id), Boolean);
    const sent = await aliceWs.rpc<{ messageId: string }>("message.send", { channelId: child.channelId, text: "Hello" });
    const history = { channelId: child.channelId };
    expect(await bobWs.rpc("message.history", history)).toMatchObject([{ id: sent.messageId, text: "Hello" }]);
    const rich = { channelId: child.channelId, text: "Formatted", html: "<p><strong>Formatted</strong></p>" };
    const sentRich = await aliceWs.rpc<{ messageId: string }>("message.send", rich);
    await until(() => bobWs.received.find((event) => event.type === "message.created" && event.payload.id === sentRich.messageId), Boolean);
    expect(bobWs.received.find((event) => event.payload.id === sentRich.messageId)?.payload).toMatchObject(rich);
    const messages = await bobWs.rpc<Array<{ id: string; text: string; html?: string }>>("message.history", history);
    expect(messages.find(({ id }) => id === sentRich.messageId)).toMatchObject(rich);
    expect(messages.find(({ id }) => id === sent.messageId)).toMatchObject({ text: "Hello" });
    expect(messages.find(({ id }) => id === sent.messageId)).not.toHaveProperty("html");
    await expect(aliceWs.rpc("message.send", { ...rich, html: "a".repeat(32769) })).rejects.toThrow("INVALID_REQUEST");
    await expect(bobWs.rpc("message.edit", { messageId: sent.messageId, text: "Hijacked" })).rejects.toThrow("NOT_FOUND");
    await aliceWs.rpc("message.edit", { messageId: sent.messageId, text: "Hello again", html: "<p>Hello <em>again</em></p><script>x</script>" });
    const edited = await until(() => bobWs.received.find((event) => event.type === "message.edited"), Boolean);
    expect(edited?.payload).toMatchObject({ messageId: sent.messageId, text: "Hello again", html: "<p>Hello <em>again</em></p>" });
    expect(typeof edited?.payload.editedAt).toBe("number");
    expect((await bobWs.rpc<Array<{ id: string; text: string; editedAt: number | null }>>("message.history", history))
      .find(({ id }) => id === sent.messageId)).toMatchObject({ text: "Hello again", editedAt: edited?.payload.editedAt });
    await expect(aliceWs.rpc("message.edit", { messageId: sent.messageId, text: " " })).rejects.toThrow("INVALID_REQUEST");
    await aliceWs.rpc("message.delete", sentRich);
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
    await expect(server.ws(bob)).rejects.toThrow("FORBIDDEN");
  } finally { await server.cleanup(); }
});

test("member moves enforce capacity and server mute members placed without channel permissions", async () => {
  const server = await fixture();
  try {
    const owner = await server.owner();
    const moderator = await server.register("Moderator");
    const aliceWs = await server.ws(await server.register("Alice"));
    const bobWs = await server.ws(await server.register("Bobby"));
    const adminWs = await server.ws(owner);
    const moderatorWs = await server.ws(moderator);
    await adminWs.rpc("role.add", { accountId: moderator.account.id, role: "Moderator" });
    const create = (payload: object) => adminWs.rpc<{ channelId: string }>("channel.create", payload);
    const source = await create({ name: "Source" });
    const destination = await create({ name: "Destination", capacity: 1, password: "private phrase" });
    const alice = await aliceWs.rpc<Snapshot>("channel.join", { channelId: source.channelId });
    const bob = await bobWs.rpc<Snapshot>("channel.join", { channelId: LOBBY });
    const payload = { channelId: destination.channelId, connectionIds: [alice.connectionId, bob.connectionId] };
    const move = () => moderatorWs.rpc("channel.move", payload);
    const channelOf = async (ws: typeof aliceWs) => (await ws.rpc<Snapshot>("state.get")).channelId;
    expect((await moderatorWs.rpc<Snapshot>("state.get")).channels).toContainEqual(
      expect.objectContaining({ id: destination.channelId, canMove: true }));
    await expect(aliceWs.rpc("channel.move", payload)).rejects.toThrow("FORBIDDEN");
    await expect(move()).rejects.toThrow("LIMIT");
    expect(await channelOf(aliceWs)).toBe(source.channelId);
    expect(await channelOf(bobWs)).toBe(LOBBY);

    await adminWs.rpc("channel.edit", { channelId: destination.channelId, capacity: 2 });
    await adminWs.rpc("channel.override", { channelId: destination.channelId, role: "Member", permission: "join", allow: false });
    const ownMember = async (ws: typeof aliceWs) => {
      const state = await ws.rpc<Snapshot>("state.get");
      return state.members.find(({ connectionId }) => connectionId === state.connectionId)!;
    };

    await move();
    expect(await channelOf(aliceWs)).toBe(destination.channelId);
    expect(await channelOf(bobWs)).toBe(destination.channelId);
    expect(bobWs.received).toContainEqual(expect.objectContaining({
      type: "channel.changed", payload: { channelId: destination.channelId },
    }));
    expect((await aliceWs.rpc<Snapshot>("state.get")).channels.map(({ id }) => id)).toContain(destination.channelId);
    expect(await ownMember(aliceWs)).toMatchObject({ adminMuted: true });
    expect(await ownMember(bobWs)).toMatchObject({ adminMuted: true });
    await expect(aliceWs.rpc("channel.join", { channelId: destination.channelId })).rejects.toThrow("FORBIDDEN");
    const codec = { mimeType: "audio/opus", clockRate: 48000, channels: 2, payloadType: 111 };
    expect(await aliceWs.rpc("media.transport.create", { direction: "receive" })).toHaveProperty("id");
    const outgoing = await aliceWs.rpc<{ id: string }>("media.transport.create", { direction: "send" });
    const produce = (ws: typeof aliceWs, ssrc: number) => ws.rpc<{ id: string }>("media.producer.create", {
      kind: "audio", transportId: outgoing.id, rtpParameters: { codecs: [codec], encodings: [{ ssrc }] } });
    await expect(produce(aliceWs, 1001)).rejects.toThrow("FORBIDDEN");

    await adminWs.rpc("moderation.mute", { connectionId: alice.connectionId, muted: false });
    expect(await ownMember(aliceWs)).toMatchObject({ adminMuted: false });
    expect(await ownMember(bobWs)).toMatchObject({ adminMuted: true });
    expect(await produce(aliceWs, 1002)).toHaveProperty("id");
    expect(await channelOf(aliceWs)).toBe(destination.channelId);
    await adminWs.rpc("channel.override", { channelId: destination.channelId, role: "Member", permission: "join", allow: null });

    await moderatorWs.rpc("channel.move", { channelId: LOBBY, connectionId: alice.connectionId });
    expect(await channelOf(aliceWs)).toBe(LOBBY);
    expect(await ownMember(aliceWs)).toMatchObject({ adminMuted: false });
    await moderatorWs.rpc("channel.move", { channelId: destination.channelId, connectionId: alice.connectionId });
    expect(await ownMember(aliceWs)).toMatchObject({ adminMuted: false });
  } finally { await server.cleanup(); }
});

test("server deafen follows the moderation hierarchy and survives reconnects", async () => {
  const server = await fixture();
  const sockets: Awaited<ReturnType<typeof server.ws>>[] = [];
  const connect = async (device: Parameters<typeof server.ws>[0]) => {
    const socket = await server.ws(device);
    sockets.push(socket);
    return socket;
  };
  try {
    const owner = await connect(await server.owner());
    const member = await server.register("Listener");
    const moderator = await server.register("Moderator");
    await owner.rpc("role.add", { accountId: moderator.account.id, role: "Moderator" });
    const moderatorWs = await connect(moderator);
    const listener = await connect(member);
    const otherDevice = await connect(member);
    const join = (socket: typeof listener) => socket.rpc<Snapshot>("channel.join", { channelId: LOBBY });
    await join(owner);
    await join(moderatorWs);
    await join(listener);
    await join(otherDevice);
    const target = { connectionId: listener.state.connectionId };
    const deafen = (deafened: boolean) => owner.rpc("moderation.deafen", { ...target, deafened });
    await expect(listener.rpc("moderation.deafen", { connectionId: owner.state.connectionId, deafened: true }))
      .rejects.toThrow("FORBIDDEN");
    await owner.rpc("moderation.mute", { ...target, muted: true });
    await deafen(true);
    await expect(moderatorWs.rpc("moderation.mute", { ...target, muted: false })).rejects.toThrow("FORBIDDEN");
    await expect(moderatorWs.rpc("moderation.deafen", { ...target, deafened: false })).rejects.toThrow("FORBIDDEN");
    const ownPresence = await listener.rpc("presence.set", { deafened: false });
    expect(ownPresence).toMatchObject({ deafened: false, adminDeafened: true, adminMuted: true });
    const consumer = { consumerId: crypto.randomUUID() };
    await expect(otherDevice.rpc("media.consumer.resume", consumer)).rejects.toThrow("FORBIDDEN");
    otherDevice.close();
    await otherDevice.closed;
    const reconnected = await connect(member);
    expect((await join(reconnected)).members).toContainEqual(expect.objectContaining({
      connectionId: reconnected.state.connectionId, adminDeafened: true,
    }));
    await deafen(false);
    expect(await reconnected.rpc("presence.set")).toMatchObject({ adminDeafened: false, adminMuted: true });
    await expect(reconnected.rpc("media.consumer.resume", consumer)).rejects.toThrow("NOT_FOUND");
    await moderatorWs.rpc("moderation.deafen", { ...target, deafened: true });
    await moderatorWs.rpc("moderation.deafen", { ...target, deafened: false });
  } finally {
    for (const socket of sockets) socket.close();
    await Promise.all(sockets.map((socket) => socket.closed));
    await server.cleanup();
  }
});

test("a receiving connection has one audio consumer per producer and can replace it after closing", async () => {
  const server = await fixture();
  try {
    const sender = await server.ws(await server.register("Sender"));
    const listener = await server.ws(await server.register("Listener"));
    await sender.rpc("channel.join", { channelId: LOBBY });
    await listener.rpc("channel.join", { channelId: LOBBY });
    const outgoing = await sender.rpc<{ id: string }>("media.transport.create", { direction: "send" });
    const incoming = await listener.rpc<{ id: string }>("media.transport.create", { direction: "receive" });
    const other = await listener.rpc<{ id: string }>("media.transport.create", { direction: "receive" });
    const codec = { mimeType: "audio/opus", clockRate: 48000, channels: 2 };
    const producer = await sender.rpc<{ id: string }>("media.producer.create", {
      kind: "audio", transportId: outgoing.id, rtpParameters: { codecs: [{ ...codec, payloadType: 111 }], encodings: [{ ssrc: 12345 }] },
    });
    const consume = (transportId: string) => listener.rpc<{ id: string }>("media.consumer.create", {
      transportId, producerId: producer.id, rtpCapabilities: { codecs: [{ ...codec, kind: "audio", preferredPayloadType: 111 }] },
    });
    const consumer = await consume(incoming.id);
    await expect(consume(other.id)).rejects.toThrow("LIMIT");
    await listener.rpc("media.consumer.close", { consumerId: consumer.id });
    expect((await consume(other.id)).id).not.toBe(consumer.id);
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

test("Capacitor origins can be explicitly allowed without opening access to other origins", async () => {
  const server = await fixture({ environment: { VOICE_SERVER_ORIGINS: '["https://localhost","capacitor://localhost"]' } });
  try {
    const preflight = (origin: string) => fetch(server.origin + "/api/v1/server/info", {
      method: "OPTIONS", tls: server.tls, headers: { origin, "access-control-request-method": "GET" },
    });
    for (const origin of ["https://localhost", "capacitor://localhost"]) {
      const response = await preflight(origin);
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    }
    for (const origin of ["null", "capacitor://other", "https://other.example"]) {
      const response = await preflight(origin);
      expect(response.status).toBe(403);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
  } finally { await server.cleanup(); }
});
