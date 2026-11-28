const storageKey = "korero:recent-emoji";
export const recentEmojiLimit = 8;

export function pushRecentEmoji(recent: readonly string[], emoji: string, limit = recentEmojiLimit): string[] {
  return [emoji, ...recent.filter((entry) => entry !== emoji)].slice(0, limit);
}

export function readRecentEmoji(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null") as unknown;
    if (!Array.isArray(saved)) return [];
    return saved.filter((entry): entry is string => typeof entry === "string" && entry.length > 0).slice(0, recentEmojiLimit);
  } catch {
    return [];
  }
}

export function saveRecentEmoji(recent: readonly string[]): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(recent));
  } catch {}
}
