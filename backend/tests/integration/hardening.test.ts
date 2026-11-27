import { expect, test } from "bun:test";
import { randomToken } from "../../src/security/credentials";
import { fixture, testIdentity, until } from "../server";

test("bodies without a content-length are bounded before parsing", async () => {
  const server = await fixture();
  try {
    const chunk = new TextEncoder().encode(" ".repeat(65536));
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 16) controller.enqueue(chunk);
        else { controller.enqueue(new TextEncoder().encode("{}")); controller.close(); }
      },
    });
    const response = await fetch(server.origin + "/api/v1/auth/refresh", {
      method: "POST", body, tls: server.tls, headers: { "content-type": "application/json" },
    });
    expect(response.status).toBe(429);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("LIMIT");
    // Requests without a body still reach their handlers.
    expect((await server.fail("/api/v1/auth/logout", undefined, undefined, "POST")).status).toBe(401);
  } finally { await server.cleanup(); }
});

test("server passwords are checked only for known identities and gate hosted registration", async () => {
  const password = "correct horse battery";
  const server = await fixture({ environment: { VOICE_SERVER_PASSWORD: password, VOICE_LIMITS_HOSTED_ACCOUNTS: "1" } });
  try {
    const login = async (identity: ReturnType<typeof testIdentity>, attempt: string) =>
      server.fail("/api/v1/auth/identity/login", { ...await server.proof("login", identity), password: attempt });
    const stranger = testIdentity();
    expect((await login(stranger, "wrong")).status).toBe(404);
    expect((await login(stranger, password)).status).toBe(404);
    const owner = testIdentity();
    const created = await server.call("/api/v1/admin/bootstrap", {
      displayName: "Owner", deviceName: "Test", token: server.setupToken, password, identity: await server.proof("bootstrap", owner),
    });
    expect(created.response.status).toBe(201);
    expect((await login(owner, "wrong")).status).toBe(401);

    const hosted = (username: string, extra: Record<string, string> = {}) =>
      server.fail("/api/v1/hosted-account/register", { username, credential: randomToken(), encryptedData: "A".repeat(64), ...extra });
    expect((await hosted("member")).status).toBe(403);
    expect((await hosted("member", { password: "wrong" })).status).toBe(401);
    expect((await hosted("member", { password })).status).toBe(201);
    expect((await hosted("another", { password })).status).toBe(429);
  } finally { await server.cleanup(); }
}, 20000);

test("image hosts, chat markup and kicks are enforced by the server", async () => {
  const server = await fixture({ environment: { VOICE_SERVER_IMAGE_HOSTS: JSON.stringify(["images.example.com"]) } });
  try {
    const owner = await server.owner();
    const member = await server.register("Member");
    const banner = (url: string) => server.fail("/api/v1/admin/banner", { bannerImageUrl: url }, owner.accessToken, "PATCH");
    expect((await banner("https://tracker.example.net/a.png")).status).toBe(403);
    expect((await banner("https://images.example.com/a.png")).status).toBe(200);

    const ownerWs = await server.ws(owner);
    const memberWs = await server.ws(member);
    await expect(ownerWs.rpc("channel.create", { name: "Elsewhere", backgroundImageUrl: "https://tracker.example.net/b.png" }))
      .rejects.toThrow("FORBIDDEN");
    const lobby = ownerWs.state.channels[0]!.id;
    await ownerWs.rpc("channel.join", { channelId: lobby });
    await memberWs.rpc("channel.join", { channelId: lobby });
    await ownerWs.rpc("message.send", { channelId: lobby, text: "hi", html: '<p onclick="x()">hi<script>alert(1)</script></p>' });
    const event = await until(() => memberWs.received.find(({ type }) => type === "message.created"), Boolean);
    expect(event?.payload.html).toBe("<p>hi</p>");

    await ownerWs.rpc("moderation.kick", { accountId: member.account.id });
    expect((await memberWs.closed).code).toBe(4403);
    await expect(server.ws(member)).rejects.toThrow("FORBIDDEN");
  } finally { await server.cleanup(); }
}, 20000);
