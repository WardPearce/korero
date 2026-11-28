import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomToken } from "../../src/security/credentials";
import { fixture } from "../server";

const path = "/api/v1/hosted-account/";
test("hosted accounts preserve encrypted data and ignore voice registration and can sign in after registration closes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "korero-account-test-"));
  const credentials = { username: "member", credential: randomToken() };
  const original = "A".repeat(64);
  const updated = "B".repeat(64);
  try {
    const open = await fixture({ directory, environment: { VOICE_REMOTE_ACCOUNT_HOST_REGISTRATION: "open", VOICE_SERVER_REGISTRATION: "disabled" } });
    try {
      const registrations = await Promise.all([1, 2].map(() => open.call(path + "register", {
        ...credentials, encryptedData: original,
      })));
      expect(registrations.map(({ response }) => response.status).sort()).toEqual([201, 409]);
      expect(await open.fail(path + "login", { ...credentials, credential: randomToken() })).toMatchObject({ status: 401 });
      expect((await open.call(path + "login", credentials)).payload).toEqual({ revision: 1, encryptedData: original });
      expect((await open.call(path + "update", { ...credentials, revision: 1, encryptedData: updated })).payload)
        .toEqual({ revision: 2 });
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
