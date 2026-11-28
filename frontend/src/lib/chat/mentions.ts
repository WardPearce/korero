import { Node } from "@tiptap/core";
import type { Message, Snapshot } from "#lib/connection/client";

export type MentionKind = "account" | "role";
export type MentionCandidate = { kind: MentionKind; target: string; label: string };
export type MessageMentions = { accounts: string[]; roles: string[] };

export const maxAccountMentions = 20;
export const maxRoleMentions = 5;
const mentionValue = /^(account|role):(.+)$/;

/** Splits a `data-mention` value such as `account:<id>` or `role:Moderator`. */
export function parseMention(value: string | null | undefined): { kind: MentionKind; target: string } | undefined {
  const match = value ? mentionValue.exec(value) : null;
  return match ? { kind: match[1] as MentionKind, target: match[2]! } : undefined;
}

/** The `@` query directly before the caret, or undefined when the caret is not inside one. */
export function mentionQuery(textBeforeCaret: string): string | undefined {
  return /(?:^|\s)@([^\s@]{0,32})$/.exec(textBeforeCaret)?.[1];
}

/** The reader, online members, recent chat authors, then mentionable roles, filtered by `query`. */
export function mentionCandidates(snapshot: Snapshot | null | undefined, messages: readonly Message[], query: string, limit = 8) {
  if (!snapshot) return [];
  const needle = query.toLocaleLowerCase();
  const accounts = new Map<string, string>();
  accounts.set(snapshot.account.id, snapshot.account.displayName);
  for (const { accountId, displayName } of snapshot.presence) accounts.set(accountId, displayName);
  for (const { senderId, senderName } of messages.toReversed()) {
    if (senderName && !accounts.has(senderId)) accounts.set(senderId, senderName);
  }
  const people: MentionCandidate[] = [...accounts].map(([target, label]) => ({ kind: "account", target, label }));
  const roles: MentionCandidate[] = (snapshot.mentionableRoles ?? []).map((role) => ({ kind: "role", target: role, label: role }));
  const matches = (candidate: MentionCandidate) => candidate.label.toLocaleLowerCase().includes(needle);
  const rank = (candidate: MentionCandidate) => candidate.label.toLocaleLowerCase().startsWith(needle) ? 0 : 1;
  return [...people, ...roles].filter(matches)
    .sort((first, second) => rank(first) - rank(second) || first.label.localeCompare(second.label)).slice(0, limit);
}

/** Whether a message mentions the account directly or through one of its roles. */
export function mentionsMe(message: Pick<Message, "mentions" | "senderId">, accountId: string | undefined, roles: readonly string[] = []) {
  if (!accountId || message.senderId === accountId || !message.mentions) return false;
  return message.mentions.accounts.includes(accountId) || message.mentions.roles.some((role) => roles.includes(role));
}

/** Deduplicates picked mentions and drops any beyond the server's per-message limits. */
export function collectMentions(picked: Iterable<{ kind: MentionKind; target: string }>): MessageMentions | undefined {
  const accounts = new Set<string>();
  const roles = new Set<string>();
  for (const { kind, target } of picked) {
    if (kind === "account" && accounts.size < maxAccountMentions) accounts.add(target);
    if (kind === "role" && roles.size < maxRoleMentions) roles.add(target);
  }
  return accounts.size || roles.size ? { accounts: [...accounts], roles: [...roles] } : undefined;
}

/** An inline, atomic `@name` pill stored as `<span data-mention="kind:target">@label</span>`. */
export const MentionNode = Node.create({
  name: "mention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,
  addAttributes() {
    return {
      mention: { default: null, parseHTML: (element) => element.getAttribute("data-mention"), renderHTML: () => ({}) },
      label: { default: "", parseHTML: (element) => element.textContent?.replace(/^@/, "") ?? "", renderHTML: () => ({}) },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-mention]" }];
  },
  renderHTML({ node }) {
    return ["span", { "data-mention": node.attrs.mention }, `@${node.attrs.label}`];
  },
  renderText({ node }) {
    return `@${node.attrs.label}`;
  },
});
