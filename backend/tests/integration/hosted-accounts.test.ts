import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomToken } from "../../src/security/credentials";
import { fixture } from "../server";

const path = "/api/v1/hosted-account/";
test("hosted account storage budgets roll back writes and reuse freed bytes", async () => {
  const server = await fixture({ environment: { VOICE_REMOTE_ACCOUNT_HOST_REGISTRATION: "open", VOICE_LIMITS_HOSTED_ACCOUNT_BYTES: "700" } });
  const first = { username: "first", credential: randomToken() };
  const second = { username: "second", credential: randomToken() };
  const payload = "A".repeat(64);
  const larger = "A".repeat(128);
  try {
    expect((await server.call(path + "register", { ...first, encryptedData: payload })).response.status).toBe(201);
    expect((await server.call(path + "register", { ...second, encryptedData: payload })).response.status).toBe(201);
    expect((await server.fail(path + "register", { username: "third", credential: randomToken(), encryptedData: payload })).status).toBe(429);
    expect((await server.fail(path + "update", { ...first, revision: 1, encryptedData: larger })).status).toBe(429);
    expect((await server.call(path + "login", first)).payload).toEqual({ revision: 1, encryptedData: payload });
    expect((await server.call(path + "update", { ...second, revision: 1, encryptedData: "B".repeat(40) })).payload).toEqual({ revision: 2 });
    expect((await server.call(path + "update", { ...first, revision: 1, encryptedData: larger })).payload).toEqual({ revision: 2 });
  } finally { await server.cleanup(); }
});

test("hosted registration policy and rate limits precede body validation", async () => {
  const server = await fixture({ environment: { VOICE_LIMITS_AUTH_PER_MINUTE: "1" } });
  try {
    expect((await server.fail(path + "register", {})).status).toBe(403);
    expect((await server.fail(path + "update", {})).status).toBe(400);
    expect(await server.fail(path + "update", {})).toMatchObject({
      status: 429, payload: { error: { code: "RATE_LIMITED" } },
    });
  } finally { await server.cleanup(); }
});

test("hosted accounts preserve encrypted data and ignore voice registration and password and can sign in after registration closes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "korero-account-test-"));
  const credentials = { username: "member", credential: randomToken() };
  const original = "A".repeat(64);
  const updated = "B".repeat(4 * 1024 * 1024);
  try {
    const open = await fixture({ directory, environment: { VOICE_REMOTE_ACCOUNT_HOST_REGISTRATION: "open", VOICE_SERVER_REGISTRATION: "disabled", VOICE_SERVER_PASSWORD: "voice-server-secret" } });
    try {
      const registrations = await Promise.all([1, 2].map(() => open.call(path + "register", {
        ...credentials, encryptedData: original,
      })));
      expect(registrations.map(({ response }) => response.status).sort()).toEqual([201, 409]);
      expect(await open.fail(path + "login", { ...credentials, credential: randomToken() })).toMatchObject({ status: 401 });
      expect((await open.call(path + "login", credentials)).payload).toEqual({ revision: 1, encryptedData: original });
      expect((await open.call(path + "update", { ...credentials, revision: 1, encryptedData: updated })).payload)
        .toEqual({ revision: 2 });
      expect(await open.fail(path + "update", { ...credentials, revision: 2, encryptedData: updated + "B" }))
        .toMatchObject({ status: 400 });
      expect(await open.fail(path + "update", { ...credentials, revision: 1, encryptedData: original })).toMatchObject({ status: 409 });
    } finally { await open.cleanup(); }

    const closed = await fixture({ directory, environment: { VOICE_REMOTE_ACCOUNT_HOST_REGISTRATION: "closed" } });
    try {
      expect(await closed.fail(path + "register", {
        username: "new-member", credential: randomToken(), encryptedData: original,
      })).toMatchObject({ status: 403 });
      expect((await closed.call(path + "login", credentials)).payload).toEqual({ revision: 2, encryptedData: updated });
    } finally { await closed.cleanup(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 20000);
