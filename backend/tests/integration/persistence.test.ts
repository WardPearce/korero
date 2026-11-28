import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { count } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { fixture, testIdentity, trusted, until, type Device } from "../server";
import { fingerprint } from "../../src/security/tls";
import { defaultPermissions, LOBBY, migrationHistory, openDatabase, permissions, roles } from "../../src/database";
import journal from "../../src/database/migrations/meta/_journal.json";

test("upgrading preserves inherited channel denials when the grants become server-wide", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-permissions-upgrade-"));
  const parent = crypto.randomUUID();
  const child = crypto.randomUUID();
  try {
    const migrationsFolder = join(directory, "migrations");
    await cp(join(import.meta.dir, "../../src/database/migrations"), migrationsFolder, { recursive: true });
    await Bun.write(join(migrationsFolder, "meta/_journal.json"), JSON.stringify({
      ...journal, entries: journal.entries.filter(({ idx }) => idx < 19),
    }));
    const sqlite = new Database(join(directory, "server.db"));
    try {
      migrate(drizzle(sqlite), { migrationsFolder });
      sqlite.run("INSERT INTO metadata VALUES ('serverId', ?)", [crypto.randomUUID()]);
      roles.forEach((role, rank) => {
        sqlite.run("INSERT INTO roles (name, rank) VALUES (?, ?)", [role, rank]);
        for (const permission of defaultPermissions[role]) {
          sqlite.run("INSERT OR IGNORE INTO permissions VALUES (?)", [permission]);
          sqlite.run("INSERT INTO role_permissions (role, permission) VALUES (?, ?)", [role, permission]);
        }
      });
      sqlite.run("INSERT INTO channels (id, name) VALUES (?, 'Lobby'), (?, 'Protected')", [LOBBY, parent]);
      sqlite.run("INSERT INTO channels (id, name, parent_id) VALUES (?, 'Protected child', ?)", [child, parent]);
      for (const permission of ["createChannels", "editChannels", "removeChannels", "move"]) {
        sqlite.run("INSERT INTO channel_overrides (channel_id, role, permission, allow) VALUES (?, 'Administrator', ?, 0)", [parent, permission]);
      }
    } finally { sqlite.close(); }

    const server = await fixture({ directory });
    try {
      const owner = await server.ws(await server.owner());
      const admin = await server.register("Administrator");
      const member = await server.ws(await server.register("Member"));
      await owner.rpc("role.add", { accountId: admin.account.id, role: "Administrator" });
      const editor = await server.ws(admin);
      await member.rpc("channel.join", { channelId: LOBBY });
      await expect(editor.rpc("channel.create", { name: "New child", parentId: child })).rejects.toThrow("FORBIDDEN");
      await expect(editor.rpc("channel.edit", { name: "Renamed", channelId: child })).rejects.toThrow("FORBIDDEN");
      await expect(editor.rpc("channel.delete", { channelId: child })).rejects.toThrow("FORBIDDEN");
      await expect(editor.rpc("channel.move", { channelId: child, connectionId: member.state.connectionId })).rejects.toThrow("FORBIDDEN");
      expect(await editor.rpc("channel.create", { name: "Top-level room" })).toHaveProperty("channelId");
    } finally { await server.cleanup(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("upgrading to multiple roles keeps each account's role, adds Member, and preserves access to Member-denied channels", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-multiple-roles-upgrade-"));
  const [parent, child, grandchild] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const accountIds = { guest: crypto.randomUUID(), member: crypto.randomUUID(), mod: crypto.randomUUID(),
    admin: crypto.randomUUID(), reader: crypto.randomUUID() };
  try {
    const migrationsFolder = join(directory, "migrations");
    await cp(join(import.meta.dir, "../../src/database/migrations"), migrationsFolder, { recursive: true });
    await Bun.write(join(migrationsFolder, "meta/_journal.json"), JSON.stringify({
      ...journal, entries: journal.entries.filter(({ idx }) => idx < 22),
    }));
    const sqlite = new Database(join(directory, "server.db"));
    try {
      migrate(drizzle(sqlite), { migrationsFolder });
      sqlite.run("INSERT INTO metadata VALUES ('serverId', ?)", [crypto.randomUUID()]);
      sqlite.run("INSERT OR IGNORE INTO permissions SELECT value FROM json_each(?)", [JSON.stringify(permissions)]);
      roles.forEach((role, rank) => {
        sqlite.run("INSERT INTO roles (name, rank) VALUES (?, ?)", [role, rank]);
        for (const permission of defaultPermissions[role]) {
          sqlite.run("INSERT INTO role_permissions (role, permission) VALUES (?, ?)", [role, permission]);
        }
      });
      sqlite.run("INSERT INTO roles (name, rank) VALUES ('Reader', -1)");
      sqlite.run("INSERT INTO role_permissions (role, permission) VALUES ('Reader', 'join')");
      const assigned: Record<keyof typeof accountIds, string> = { guest: "Guest", member: "Member", mod: "Moderator",
        admin: "Administrator", reader: "Reader" };
      for (const [key, id] of Object.entries(accountIds)) {
        sqlite.run("INSERT INTO accounts (id, display_name, created_at) VALUES (?, ?, 0)", [id, key]);
        sqlite.run("INSERT INTO account_roles (account_id, role) VALUES (?, ?)", [id, assigned[key as keyof typeof accountIds]]);
      }
      sqlite.run("INSERT INTO channels (id, name) VALUES (?, 'Lobby'), (?, 'Parent')", [LOBBY, parent]);
      sqlite.run("INSERT INTO channels (id, name, parent_id) VALUES (?, 'Child', ?), (?, 'Grandchild', ?)",
        [child, parent, grandchild, child]);
      const override = sqlite.prepare("INSERT INTO channel_overrides (channel_id, role, permission, allow) VALUES (?, ?, ?, ?)");
      override.run(parent, "Member", "join", 0);
      override.run(child, "Moderator", "join", 0);
      override.run(parent, "Member", "text", 0);
      override.run(parent, "Reader", "text", 1);
      override.run(grandchild, "Member", "join", 0);
    } finally { sqlite.close(); }

    const store = openDatabase(directory);
    try {
      const client = store.$client;
      const held = (id: string) => client.query<{ role: string }, [string]>(
        "SELECT role FROM account_roles WHERE account_id = ? ORDER BY role").all(id).map(({ role }) => role);
      expect(held(accountIds.guest)).toEqual(["Guest"]);
      expect(held(accountIds.member)).toEqual(["Member"]);
      expect(held(accountIds.mod)).toEqual(["Member", "Moderator"]);
      expect(held(accountIds.admin)).toEqual(["Administrator", "Member"]);
      expect(held(accountIds.reader)).toEqual(["Member", "Reader"]);

      const overrides = (channelId: string) => client.query<{ role: string; permission: string; allow: number }, [string]>(
        "SELECT role, permission, allow FROM channel_overrides WHERE channel_id = ? ORDER BY role, permission").all(channelId);
      expect(overrides(parent)).toEqual([
        { role: "Administrator", permission: "join", allow: 1 },
        { role: "Administrator", permission: "text", allow: 1 },
        { role: "Member", permission: "join", allow: 0 },
        { role: "Member", permission: "text", allow: 0 },
        { role: "Moderator", permission: "join", allow: 1 },
        { role: "Moderator", permission: "text", allow: 1 },
        { role: "Reader", permission: "join", allow: 1 },
        { role: "Reader", permission: "text", allow: 1 },
      ]);
      // The Moderator's own deny on Child is kept and nothing is added there.
      expect(overrides(child)).toEqual([{ role: "Moderator", permission: "join", allow: 0 }]);
      // Below Child the Moderator was denied before the upgrade, so no allow is written for it.
      expect(overrides(grandchild)).toEqual([
        { role: "Administrator", permission: "join", allow: 1 },
        { role: "Member", permission: "join", allow: 0 },
        { role: "Reader", permission: "join", allow: 1 },
      ]);

      const indexes = client.query<{ name: string }, []>("PRAGMA index_list('account_roles')").all().map(({ name }) => name);
      expect(indexes).toContain("account_roles_role");
      expect(() => client.run("INSERT INTO account_roles (account_id, role) VALUES (?, 'Member')", [accountIds.member])).toThrow();
      client.run("INSERT INTO account_roles (account_id, role) VALUES (?, 'Reader')", [accountIds.member]);
      expect(held(accountIds.member)).toEqual(["Member", "Reader"]);
    } finally { store.$client.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("stored messages share a byte budget and expiration releases it in successive batches", async () => {
  const budget = 1024 * 1024;
  const server = await fixture({ environment: { VOICE_MESSAGING_STORED_MESSAGE_BYTES: String(budget) } });
  try {
    const sender = await server.register("Sender");
    const recipient = await server.register("Offline recipient");
    const socket = await server.ws(sender);
    await socket.rpc("channel.join", { channelId: LOBBY });
    const sqlite = new Database(join(server.directory, "server.db"));
    try {
      const insert = sqlite.prepare("INSERT INTO messages (id, channel_id, sender_id, text, created_at) VALUES (?, ?, ?, ?, ?)");
      insert.run(crypto.randomUUID(), LOBBY, sender.account.id, "x".repeat(budget - 256 - 400), Date.now());
      const directId = crypto.randomUUID();
      await socket.rpc("direct.send", { accountId: recipient.account.id, id: directId,
        nonce: Buffer.alloc(12).toString("base64url"), ciphertext: Buffer.alloc(25).toString("base64url"),
        signature: Buffer.alloc(64).toString("base64url") });
      const channelMessage = { channelId: LOBBY, text: "Hello" };
      await expect(socket.rpc("message.send", channelMessage)).rejects.toThrow("LIMIT");
      await socket.rpc("direct.delete", { accountId: recipient.account.id, id: directId });
      expect(await socket.rpc("message.send", channelMessage)).toHaveProperty("messageId");

      const old = Date.now() - 8 * 24 * 3600000;
      const insertDirect = sqlite.prepare(
        "INSERT INTO direct_messages (id, sender_id, recipient_id, created_at, nonce, ciphertext, signature) VALUES (?, ?, ?, ?, '', '', '')",
      );
      sqlite.transaction(() => {
        for (let index = 0; index < 1001; index++) {
          insert.run(crypto.randomUUID(), LOBBY, sender.account.id, "old", old);
          insertDirect.run(crypto.randomUUID(), sender.account.id, recipient.account.id, old);
        }
      })();
      const remaining = sqlite.query<{ total: number }, [number, number]>(
        "SELECT (SELECT count(*) FROM messages WHERE created_at = ?) + (SELECT count(*) FROM direct_messages WHERE created_at = ?) AS total",
      );
      await until(() => remaining.get(old, old)!.total, (total) => total === 0);
      const usage = sqlite.query<{ bytes: number }, []>("SELECT bytes FROM stored_message_usage").get()!.bytes;
      expect(usage).toBe(budget - 400 + 256 + channelMessage.text.length);
    } finally { sqlite.close(); }
  } finally { await server.cleanup(); }
});

test("Drizzle migrations, server ID, account and channels survive restart and a coherent SQLite backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "voice-restore-"));
  const directory = join(root, "data");
  const backup = join(root, "backup");
  const backgroundImageUrl = "https://images.example/saved.jpg";
  const icon = "🎮";
  try {
    const original = await fixture({ directory });
    const key = testIdentity();
    let user: Device;
    let id: string;
    try {
      const info = await original.call<{ serverId: string }>("/api/v1/server/info");
      id = info.payload.serverId;
      user = await original.owner(key);
      const ws = await original.ws(user);
      const { channelId } = await ws.rpc<{ channelId: string }>("channel.create", { name: "Saved room", backgroundImageUrl, icon });
      const { messageId } = await ws.rpc<{ messageId: string }>("message.send", { channelId, text: "Saved pin" });
      await ws.rpc("message.pin", { channelId, messageId, pinned: true });
      const settings = await original.call("/api/v1/admin/preferences", {
        motd: "Saved welcome", defaultRole: "Guest", defaultAudioBitrate: 128000, maxAttachmentMiB: 12,
      }, user.accessToken, "PATCH");
      expect(settings.response.status).toBe(200);
      const conflict = Bun.spawn([...original.command, "backup", "--output", backup], { env: original.defaultEnv, stderr: "pipe" });
      expect(await conflict.exited).toBe(1);
      expect(await new Response(conflict.stderr).text()).toContain("already in use");
    } finally { await original.stop(); }
    const migrationStore = openDatabase(directory);
    expect(migrationStore.select({ total: count() }).from(migrationHistory).get()?.total).toBe(journal.entries.length);
    migrationStore.$client.close();
    const command = Bun.spawn([...original.command, "backup", "--output", backup], { env: original.defaultEnv, stderr: "pipe", stdout: "pipe" });
    expect(await command.exited).toBe(0);
    expect(await Bun.file(join(backup, "BACKUP_COMPLETE")).exists()).toBe(true);
    const restored = await fixture({ directory: backup, port: original.port, environment: { VOICE_TLS_NAMES: '["renewed.example"]' } });
    try {
      const info = await restored.call<{ serverId: string; setupRequired: boolean }>("/api/v1/server/info");
      expect(info.payload).toMatchObject({ serverId: id, setupRequired: false, maxAttachmentBytes: 12 * 1024 * 1024 });
      expect(restored.setupToken).toBe("");
      expect(fingerprint(restored.ca)).toBe(fingerprint(original.ca));
      expect(new X509Certificate(restored.ca).checkHost("renewed.example")).toBe("renewed.example");
      expect(restored.ca).not.toEqual(original.ca);
      const signedIn = await restored.call<Device>("/api/v1/auth/identity/login", await restored.proof("login", key, "Restored"));
      expect(signedIn.response.status).toBe(200);
      expect(signedIn.payload.account.id).toEqual(user.account.id);
      const ws = await restored.ws(signedIn.payload);
      expect(ws.state.channels).toContainEqual(expect.objectContaining({ name: "Saved room", backgroundImageUrl, icon }));
      const savedRoom = ws.state.channels.find(({ name }) => name === "Saved room")!;
      expect(await ws.rpc("message.pins", { channelId: savedRoom.id })).toMatchObject({ messages: [{ text: "Saved pin" }] });
      expect(ws.state).toMatchObject({ motd: "Saved welcome", targetAudioBitrate: 128000, maxAttachmentBytes: 12 * 1024 * 1024 });
      expect((await restored.register("New guest")).account.role).toBe("Guest");
      const audit = await restored.call("/api/v1/admin/audit?prefix=server", undefined, user.accessToken);
      expect(audit.payload).toMatchObject({ events: expect.arrayContaining([
        expect.objectContaining({ action: "server.voice_quality_changed", details: { previousBitrate: null, bitrate: 128000 } }),
      ]) });
      const proof = await restored.proof("login", key, "Untrusted");
      await expect(fetch(restored.origin + "/api/v1/auth/identity/login", { method: "POST", tls: trusted(restored.ca, "unexpected"),
        headers: { "content-type": "application/json" }, body: JSON.stringify(proof) })).rejects.toThrow();
      const sessions = await restored.call<{ deviceName: string }[]>("/api/v1/account/sessions", undefined, user.accessToken);
      expect(sessions.payload.map(({ deviceName }) => deviceName)).not.toContain("Untrusted");
    } finally { await restored.stop(); }
    const rotate = Bun.spawn([...original.command, "identity", "rotate", "--yes"], { env: original.defaultEnv, stdout: "pipe" });
    expect(await rotate.exited).toBe(0);
    expect((await new Response(rotate.stdout).text()).trim()).not.toBe(fingerprint(original.ca));
  } finally { await rm(root, { recursive: true, force: true }); }
}, 12000);
