import { expect, test } from "bun:test";
import { browserIdentity } from "../src/lib/identity/browser-identity";
import { directConversation } from "../src/lib/chat/direct-crypto";

test("both identities can read direct messages and detect altered content or routing", async () => {
  const [alice, bob, stranger] = await Promise.all([browserIdentity(), browserIdentity(), browserIdentity()]);
  const serverId = crypto.randomUUID();
  const from = { accountId: crypto.randomUUID(), displayName: "Alice", publicKey: alice.publicKey };
  const to = { accountId: crypto.randomUUID(), displayName: "Bob", publicKey: bob.publicKey };
  const [sender, receiver, differentServer, replacement] = await Promise.all([
    directConversation(serverId, from.accountId, alice, to),
    directConversation(serverId, to.accountId, bob, from),
    directConversation(crypto.randomUUID(), to.accountId, bob, from),
    directConversation(serverId, to.accountId, stranger, from),
  ]);

  expect(sender.safetyCode).toBe(receiver.safetyCode);
  expect(sender.safetyCode).not.toBe(replacement.safetyCode);
  expect(sender.safetyCode).not.toBe(differentServer.safetyCode);
  const text = "Private kōrero 🔒";
  const { accountId, ...sealed } = await sender.encrypt(text);
  expect(JSON.stringify(sealed)).not.toContain(text);
  const message = { ...sealed, senderId: from.accountId, recipientId: accountId, createdAt: Date.now() };
  expect(await sender.decrypt(message)).toBe(text);
  expect(await receiver.decrypt(message)).toBe(text);
  const ciphertext = (sealed.ciphertext[0] === "A" ? "B" : "A") + sealed.ciphertext.slice(1);
  await expect(receiver.decrypt({ ...message, ciphertext })).rejects.toThrow();
  await expect(receiver.decrypt({ ...message, id: crypto.randomUUID() })).rejects.toThrow();
  await expect(receiver.decrypt({ ...message, senderId: to.accountId, recipientId: from.accountId })).rejects.toThrow();
  await expect(differentServer.decrypt(message)).rejects.toThrow();
  await expect(replacement.decrypt(message)).rejects.toThrow();
});
