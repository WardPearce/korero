import { expect, test } from "bun:test";
import { count } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import { fixture, testIdentity, trusted, type Device } from "../server";
import { fingerprint } from "../../src/security/tls";
import { migrationHistory, openDatabase } from "../../src/database";
import journal from "../../src/database/migrations/meta/_journal.json";

test("Drizzle migrations, server ID, account and channels survive restart and a coherent SQLite backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "voice-restore-"));
  const directory = join(root, "data");
  const backup = join(root, "backup");
  const backgroundImageUrl = "https://images.example/saved.jpg";
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
      await ws.rpc("channel.create", { name: "Saved room", backgroundImageUrl });
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
      expect(info.payload).toMatchObject({ serverId: id, setupRequired: false });
      expect(restored.setupToken).toBe("");
      expect(fingerprint(restored.ca)).toBe(fingerprint(original.ca));
      expect(new X509Certificate(restored.ca).checkHost("renewed.example")).toBe("renewed.example");
      expect(restored.ca).not.toEqual(original.ca);
      const signedIn = await restored.call<Device>("/api/v1/auth/identity/login", await restored.proof("login", key, "Restored"));
      expect(signedIn.response.status).toBe(200);
      expect(signedIn.payload.account.id).toEqual(user.account.id);
      const ws = await restored.ws(signedIn.payload);
      expect(ws.state.channels).toContainEqual(expect.objectContaining({ name: "Saved room", backgroundImageUrl }));
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
