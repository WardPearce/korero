import { expect, test } from "bun:test";
import { fixture } from "../server";

test("channel ordering follows channel-scoped edit grants", async () => {
  const server = await fixture();
  try {
    const owner = await server.owner();
    const editor = await server.register("Channel editor");
    const roles = "/api/v1/admin/roles";
    expect((await server.call(roles, { name: "Channel editor", permissions: ["join"] }, owner.accessToken)).response.status).toBe(200);
    expect((await server.call(roles, { accountId: editor.account.id, role: "Channel editor" }, owner.accessToken, "PATCH")).response.status).toBe(200);

    const ownerWs = await server.ws(owner);
    const editorWs = await server.ws(editor);
    const create = async (name: string) => (await ownerWs.rpc<{ channelId: string }>("channel.create", { name })).channelId;
    const source = await create("Source");
    const target = await create("Target");
    for (const channelId of [source, target]) {
      await ownerWs.rpc("channel.override", { channelId, role: "Channel editor", permission: "editChannels", allow: true });
    }

    type EditorSnapshot = {
      canReorderChannels?: boolean;
      channels: { id: string; parentId: string | null; name: string; canEdit?: boolean }[];
    };
    const state = await editorWs.rpc<EditorSnapshot>("state.get");
    expect(state.canReorderChannels).toBe(true);
    expect(state.channels.filter(({ id }) => id === source || id === target).every(({ canEdit }) => canEdit)).toBe(true);

    const response = await server.call("/api/v1/channels/order",
      { channelId: source, targetId: target, placement: "inside", parentId: target }, editor.accessToken, "PATCH");
    expect(response.response.status).toBe(200);
    const nested = await editorWs.rpc<EditorSnapshot>("state.get");
    expect(nested.channels.find(({ id }) => id === source)?.parentId).toBe(target);
  } finally { await server.cleanup(); }
});
