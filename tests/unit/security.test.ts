import { expect, test } from "bun:test";
import { Credentials, normalizeRecovery, randomToken, recoveryCode } from "../../src/security/credentials";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../../src/config";
import { extractWorker, sha256 } from "../../src/security/files";
import { symlink, unlink } from "node:fs/promises";
import { decode } from "../../src/protocol";

test("recovery codes encode 32 bytes in 13 Crockford groups and accept human input", () => {
  const codes = Array.from({ length: 128 }, recoveryCode);
  expect(new Set(codes).size).toBe(128);
  for (const code of codes) {
    expect(code.split("-").map((group) => group.length)).toEqual(Array.from({ length: 13 }, () => 4));
    expect(normalizeRecovery(code)).toHaveLength(52);
    expect(normalizeRecovery(code.toLowerCase().replaceAll("-", " "))).toBe(normalizeRecovery(code));
  }
  expect(normalizeRecovery("a".repeat(52))).toBeNull();
  const credential = randomToken();
  expect(Buffer.from(credential, "base64url")).toHaveLength(32);
  const hmac = new Credentials(new Uint8Array(32).fill(7));
  expect(new Set(["access", "refresh", "recovery", "ticket", "setup", "invitation"].map((domain) =>
    hmac.digest(domain as Parameters<Credentials["digest"]>[0], credential))).size).toBe(6);
});

test("checks the complete TOML configuration before startup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-config-"));
  try {
    const file = join(directory, "server.toml");
    for (const [toml, reason] of [
      ['[server]\n typo = true', "Invalid configuration"],
      ['[server]\n host = "0.0.0.0"\n[tls]\n mode = "disabled"', "requires a loopback"],
      ['[media]\n port = 8443', "overlap"],
      ['[media]\n listen_ip = "0.0.0.0"', "requires an announced address"],
      ['[media]\n enable_tcp = false\n enable_udp = false', "at least one"],
    ] as const) {
      await Bun.write(file, toml);
      await expect(loadConfig({ file, directory })).rejects.toThrow(reason);
    }
    await Bun.write(file, '[server]\n host = "::1"\n[tls]\n mode = "disabled"');
    expect((await loadConfig({ file, directory })).server.host).toBe("::1");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("worker extraction checks the embedded digest, persisted digest and symlinks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-worker-"));
  const originalWorker = process.env.MEDIASOUP_WORKER_BIN;
  try {
    const worker = new TextEncoder().encode("worker-test-content");
    const digest = sha256(worker);
    await expect(extractWorker(directory, "test", worker, "invalid")).rejects.toThrow("integrity");
    const path = await extractWorker(directory, "test", worker, digest);
    expect(await extractWorker(directory, "test", worker, digest)).toBe(path);
    await Bun.write(path, "modified");
    await expect(extractWorker(directory, "test", worker, digest)).rejects.toThrow("integrity");
    await unlink(path);
    await symlink("/dev/null", path);
    await expect(extractWorker(directory, "test", worker, digest)).rejects.toThrow();
  } finally {
    if (originalWorker === undefined) delete process.env.MEDIASOUP_WORKER_BIN;
    else process.env.MEDIASOUP_WORKER_BIN = originalWorker;
    await rm(directory, { recursive: true, force: true });
  }
});

test("protocol rejects extra identities, invalid media and unknown negotiation versions", () => {
  expect(() => decode({ version: 2, id: 1, type: "heartbeat", payload: {} })).toThrow("Unsupported protocol");
  expect(() => decode({ version: 1, id: 1, type: "heartbeat", payload: { accountId: "forged" } })).toThrow("Invalid request");
  expect(() => decode({ version: 1, id: 1, type: "media.producer.create", payload: { kind: "video" } })).toThrow("Invalid request");
  expect(decode({ version: 1, id: 1, type: "heartbeat", payload: {} }).type).toBe("heartbeat");
});
