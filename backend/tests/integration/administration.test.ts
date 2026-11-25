import { expect, test } from "bun:test";
import { join } from "node:path";
import { fixture, testIdentity, type Device } from "../server";

test("identity enrollment, role hierarchy, and server administration are enforced by the API", async () => {
  const server = await fixture();
  try {
    const identity = testIdentity();
    const member = await server.register("Operator", identity);
    expect(member.account.role).toBe("Member");
    expect((await server.fail("/api/v1/admin/accounts", undefined, member.accessToken)).status).toBe(403);
    const owner = await server.owner(identity);
    expect(owner.account).toMatchObject({ id: member.account.id, role: "Owner" });

    const aliceIdentity = testIdentity();
    const alice = await server.register("Alice", aliceIdentity);
    const roles = "/api/v1/admin/roles";
    expect((await server.fail(roles, { accountId: owner.account.id, role: "Member" }, owner.accessToken, "PATCH")).status).toBe(403);
    const grant = await server.call(roles, { accountId: alice.account.id, role: "Administrator" }, owner.accessToken, "PATCH");
    expect(grant.response.status).toBe(200);
    expect((await server.fail(roles, { accountId: owner.account.id, role: "Member" }, alice.accessToken, "PATCH")).status).toBe(403);
    const accounts = await server.call("/api/v1/admin/accounts", undefined, alice.accessToken);
    expect(accounts.payload).toMatchObject({ accounts: expect.arrayContaining([{ id: owner.account.id,
      displayName: "Operator", role: "Owner", editable: false }]) });

    const configPath = "/api/v1/admin/configuration";
    const file = join(server.directory, "server.toml");
    const { payload: configuration } = await server.call<{ toml: string; revision: string }>(configPath, undefined, alice.accessToken);
    const save = (toml: string) => server.call(configPath, { toml, revision: configuration.revision }, alice.accessToken, "PATCH");
    expect((await save("this is not TOML")).response.status).toBe(400);
    expect(await Bun.file(file).text()).toBe(configuration.toml);
    const updated = configuration.toml.replace("Voice Server", "New name");
    expect((await save(updated)).response.status).toBe(200);
    expect(await Bun.file(file).text()).toBe(updated);
    expect((await save(updated + "\n# stale")).response.status).toBe(409);

    const passwordPath = "/api/v1/admin/password";
    expect((await server.call(passwordPath, { password: "private phrase" }, alice.accessToken, "PATCH")).payload)
      .toEqual({ passwordRequired: true });
    const publicInfo = await server.call("/api/v1/server/info");
    expect(publicInfo.payload).toMatchObject({ passwordRequired: true });
    const loginPath = "/api/v1/auth/identity/login";
    expect((await server.fail(loginPath, await server.proof("login", aliceIdentity))).status).toBe(401);
    const login = await server.call<Device>(loginPath, { ...await server.proof("login", aliceIdentity), password: "private phrase" });
    expect(login.payload.account.role).toBe("Administrator");
    const registration = await server.fail("/api/v1/auth/register", { displayName: "Bobby", deviceName: "Test",
      identity: await server.proof("register", testIdentity()), password: "incorrect" });
    expect(registration.status).toBe(401);
    expect((await server.call(passwordPath, { password: null }, alice.accessToken, "PATCH")).payload)
      .toEqual({ passwordRequired: false });
    expect((await server.call(loginPath, await server.proof("login", aliceIdentity))).response.status).toBe(200);
  } finally { await server.cleanup(); }
});
