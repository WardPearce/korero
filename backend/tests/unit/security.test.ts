import { expect, test } from "bun:test";
import { Credentials, randomToken } from "../../src/security/credentials";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../../src/config";
import { extractWorker, sha256 } from "../../src/security/files";
import { symlink, unlink } from "node:fs/promises";
import { decode } from "../../src/protocol";

test("tokens encode 32 bytes and credential verifiers are domain-separated", () => {
  const credential = randomToken();
  expect(Buffer.from(credential, "base64url")).toHaveLength(32);
  const hmac = new Credentials(new Uint8Array(32).fill(7));
  const domains = ["access", "refresh", "ticket", "setup", "invitation"] as const;
  expect(new Set(domains.map((domain) => hmac.digest(domain, credential))).size).toBe(domains.length);
});

test("checks the complete TOML configuration before startup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-config-"));
  try {
    const file = join(directory, "server.toml");
    for (const [toml, reason] of [
      ['[server]\n typo = true', "Invalid configuration"],
      ['[server]\n host = "0.0.0.0"\n[tls]\n mode = "disabled"', "Invalid configuration"],
      ['[tls]\n mode = "proxy"', "explicitly trusted proxies"],
      ['[media]\n port = 8443', "overlap"],
      ['[media]\n listen_ip = "0.0.0.0"', "requires an announced address"],
      ['[media]\n enable_tcp = false\n enable_udp = false', "at least one"],
    ] as const) {
      await Bun.write(file, toml);
      await expect(loadConfig({ file, directory })).rejects.toThrow(reason);
    }
    await Bun.write(file, '[server]\n host = "::1"\n trusted_proxies = ["::1"]\n[tls]\n mode = "proxy"');
    const config = await loadConfig({ file, directory });
    expect(config.server.trusted_proxies).toEqual(["::1"]);
    expect(config.tls.mode).toBe("proxy");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("realtime and attachment rate limits have relaxed defaults and accept host overrides", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-limits-"));
  try {
    const defaults = await loadConfig({ directory });
    expect(defaults.limits).toMatchObject({ websocket_requests_per_minute: 3600, media_per_minute: 1800,
      ice_restarts_per_minute: 30, channel_joins_per_minute: 60, attachment_uploads_per_minute: 120,
      attachment_downloads_per_minute: 240, attachment_download_bytes_per_minute: 134217728,
      attachment_uploads_concurrent: 32 });
    expect(defaults.messaging.per_minute).toBe(120);
    expect(defaults.limits.auth_per_minute).toBe(30);
    const file = join(directory, "server.toml");
    await Bun.write(file, `[limits]
channel_joins_per_minute = 90
attachment_download_bytes_per_minute = 268435456
[messaging]
per_minute = 150
`);
    const configured = await loadConfig({ file, directory });
    expect(configured.limits.channel_joins_per_minute).toBe(90);
    expect(configured.limits.attachment_download_bytes_per_minute).toBe(268435456);
    expect(configured.messaging.per_minute).toBe(150);
    await Bun.write(file, "[limits]\nchannel_joins_per_minute = 0");
    await expect(loadConfig({ file, directory })).rejects.toThrow("Invalid configuration");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("message history is kept for one week by default", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-persistence-"));
  try {
    const defaults = await loadConfig({ directory });
    expect(defaults.messaging.persistence).toBe(true);
    expect(defaults.messaging.retention_hours).toBe(168);
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

test("rate limits group IPv6 clients by /64 and evict the oldest bucket when full", async () => {
  const { clientKey } = await import("../../src/app");
  const { RateLimit } = await import("../../src/security/errors");
  expect(clientKey("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
  expect(clientKey("2001:db8:1:2:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
  expect(clientKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
  expect(clientKey("::1")).toBe("0:0:0:0::/64");
  expect(clientKey("64:ff9b::1.2.3.4")).toBe("64:ff9b:0:0::/64");
  expect(clientKey("192.0.2.7")).toBe("192.0.2.7");
  const limit = new RateLimit(1, 2);
  limit.take("a");
  limit.take("b");
  expect(() => limit.take("a")).toThrow();
  limit.take("c");
  limit.take("d");
  limit.take("a");
});

test("server-side chat markup keeps only the client allowlist", async () => {
  const { sanitizeChatHtml } = await import("../../src/security/html");
  expect(sanitizeChatHtml('<p onclick="x()">Hi <a href="https://example.com" style="x">there</a></p>'))
    .toBe('<p>Hi <a href="https://example.com">there</a></p>');
  expect(sanitizeChatHtml('<a href="javascript:alert(1)">x</a><img src=x onerror=alert(1)>')).toBe("<a>x</a>");
  expect(sanitizeChatHtml("<script>alert(1)</script><style>p{}</style>")).toBeNull();
  expect(sanitizeChatHtml("<<x>script>alert(1)<</x>/script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(sanitizeChatHtml("<!-- hidden --><b>&amp;</b>")).toBe("<b>&amp;</b>");
  expect(sanitizeChatHtml('<ol start="3" type="a"><li>x</li></ol>')).toBe('<ol start="3"><li>x</li></ol>');
});

test("password work queues fairly and limits each client", async () => {
  const { PasswordWork } = await import("../../src/security/work");
  const work = new PasswordWork(1, 1, 1);
  let release!: () => void;
  const first = work.run("a", () => new Promise<number>((resolve) => { release = () => resolve(1); }));
  await expect(work.run("a", async () => 2)).rejects.toThrow();
  const second = work.run("b", async () => 2);
  await expect(work.run("c", async () => 3)).rejects.toThrow();
  release();
  expect(await Promise.all([first, second])).toEqual([1, 2]);
  expect(await work.run("a", async () => 4)).toBe(4);
});
