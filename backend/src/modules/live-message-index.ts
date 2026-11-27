export const liveMessageLifetime = 60 * 60_000;
const maxLiveMessages = 10_000;

/** Keeps enough information to authorize changes to recently delivered messages. */
export class LiveMessageIndex<T extends { id: string }> {
  private readonly entries = new Map<string, { message: T; expiresAt: number }>();

  add(message: T) {
    this.entries.set(message.id, { message, expiresAt: Date.now() + liveMessageLifetime });
    if (this.entries.size > maxLiveMessages) this.entries.delete(this.entries.keys().next().value!);
  }

  get(id: string) {
    const entry = this.entries.get(id);
    if (entry && entry.expiresAt > Date.now()) return entry.message;
    this.entries.delete(id);
  }

  delete(id: string) {
    this.entries.delete(id);
  }

  removeMatching(matches: (message: T) => boolean) {
    for (const [id, { message }] of this.entries) {
      if (matches(message)) this.entries.delete(id);
    }
  }

  prune(now: number) {
    for (const [id, { expiresAt }] of this.entries) {
      if (expiresAt <= now) this.entries.delete(id);
    }
  }
}
