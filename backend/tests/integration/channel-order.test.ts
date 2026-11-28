import { expect, test } from "bun:test";
import { fixture } from "../server";

const accountRoles = "/api/v1/admin/accounts/roles";

test("channel ordering requires a server-wide edit grant", async () => {
  const server = await fixture();
  try {
    const owner = await server.owner();
    const editor = await server.register("Channel editor");
    const roles = "/api/v1/admin/roles";
    expect((await server.call(roles, { name: "Channel editor", permissions: ["join"] }, owner.accessToken)).response.status).toBe(200);
    expect((await server.call(accountRoles, { accountId: editor.account.id, role: "Channel editor" }, owner.accessToken, "POST")).response.status).toBe(200);

    const ownerWs = await server.ws(owner);
    const editorWs = await server.ws(editor);
    const create = async (name: string) => (await ownerWs.rpc<{ channelId: string }>("channel.create", { name })).channelId;
    const source = await create("Source");
    const target = await create("Target");

    type EditorSnapshot = {
      canReorderChannels?: boolean;
      channels: { id: string; parentId: string | null; name: string; canEdit?: boolean }[];
    };
    const state = await editorWs.rpc<EditorSnapshot>("state.get");
    expect(state.canReorderChannels).toBe(false);
    expect(state.channels.filter(({ id }) => id === source || id === target).every(({ canEdit }) => !canEdit)).toBe(true);

    expect((await server.call("/api/v1/channels/order",
      { channelId: source, targetId: target, placement: "inside", parentId: target }, editor.accessToken, "PATCH")).response.status).toBe(403);

    expect((await server.call(`${roles}/definition`, { name: "Channel editor", permissions: ["join", "editChannels"] }, owner.accessToken, "PATCH")).response.status).toBe(200);
    expect(await editorWs.rpc<EditorSnapshot>("state.get")).toMatchObject({ canReorderChannels: true });

    const response = await server.call("/api/v1/channels/order",
      { channelId: source, targetId: target, placement: "inside", parentId: target }, editor.accessToken, "PATCH");
    expect(response.response.status).toBe(200);
    const nested = await editorWs.rpc<EditorSnapshot>("state.get");
    expect(nested.channels.find(({ id }) => id === source)?.parentId).toBe(target);
  } finally { await server.cleanup(); }
});
