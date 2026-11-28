import type { Channel } from "#lib/connection/client";

export function groupChannelsByParent(channels: readonly Channel[]) {
  const groups = new Map<string | null, Channel[]>();
  for (const channel of channels) {
    const siblings = groups.get(channel.parentId);
    if (siblings) siblings.push(channel);
    else groups.set(channel.parentId, [channel]);
  }
  return groups;
}
