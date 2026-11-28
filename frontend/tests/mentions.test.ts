import { expect, test } from "bun:test";
import { collectMentions, mentionCandidates, mentionQuery, mentionsMe, parseMention } from "../src/lib/chat/mentions";
import type { Message, Snapshot } from "../src/lib/connection/client";

test("mention queries start at an @ after whitespace and stop at spaces", () => {
  expect(mentionQuery("@")).toBe("");
  expect(mentionQuery("hey @al")).toBe("al");
  expect(mentionQuery("mail me@example")).toBeUndefined();
  expect(mentionQuery("@al ")).toBeUndefined();
  expect(parseMention("role:Game night")).toEqual({ kind: "role", target: "Game night" });
  expect(parseMention("channel:x")).toBeUndefined();
});

test("candidates list the reader, online people, recent authors and mentionable roles", () => {
  const snapshot = {
    account: { id: "me", displayName: "Me", role: "Member" },
    presence: [{ accountId: "me", displayName: "Me", connections: 1 }, { accountId: "a", displayName: "Alice", connections: 1 }],
    mentionableRoles: ["Moderator"],
  } as unknown as Snapshot;
  const messages = [{ id: "1", senderId: "b", senderName: "Albert", channelId: "c", createdAt: 1, text: "" }] as Message[];
  expect(mentionCandidates(snapshot, messages, "al").map(({ label }) => label)).toEqual(["Albert", "Alice"]);
  expect(mentionCandidates(snapshot, messages, "mod")).toEqual([{ kind: "role", target: "Moderator", label: "Moderator" }]);
  expect(mentionCandidates(snapshot, messages, "me")).toEqual([{ kind: "account", target: "me", label: "Me" }]);
});

test("a message mentions the reader directly or through a held role, never from themselves", () => {
  const message = { senderId: "x", mentions: { accounts: ["me"], roles: [] } };
  expect(mentionsMe(message, "me")).toBe(true);
  expect(mentionsMe({ senderId: "x", mentions: { accounts: [], roles: ["Moderator"] } }, "me", ["Member", "Moderator"])).toBe(true);
  expect(mentionsMe({ ...message, senderId: "me" }, "me")).toBe(false);
  expect(mentionsMe({ senderId: "x" }, "me")).toBe(false);
});

test("collected mentions are deduplicated and capped at the server limits", () => {
  const accounts = Array.from({ length: 25 }, (_, index) => ({ kind: "account" as const, target: `a${index}` }));
  const roles = Array.from({ length: 7 }, (_, index) => ({ kind: "role" as const, target: `r${index}` }));
  const collected = collectMentions([...accounts, accounts[0]!, ...roles])!;
  expect(collected.accounts).toHaveLength(20);
  expect(collected.roles).toHaveLength(5);
  expect(collectMentions([])).toBeUndefined();
});
