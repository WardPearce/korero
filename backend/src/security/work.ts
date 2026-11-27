import { fail } from "./errors";

/**
 * Bounds concurrent password hashing. Work beyond `concurrency` waits in a short queue
 * instead of failing, and each client may have only `perClient` jobs queued or running,
 * so one client cannot keep every slot busy.
 */
export class PasswordWork {
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly clients = new Map<string, number>();
  constructor(private readonly concurrency = 2, private readonly maxWaiting = 64, private readonly perClient = 1) {}

  async run<T>(client: string, work: () => Promise<T>): Promise<T> {
    const held = this.clients.get(client) ?? 0;
    if (held >= this.perClient || this.waiting.length >= this.maxWaiting) fail("RATE_LIMITED");
    this.clients.set(client, held + 1);
    try {
      if (this.running < this.concurrency) this.running++;
      else await new Promise<void>((resolve) => this.waiting.push(resolve));
      try { return await work(); } finally {
        // Hand the slot straight to the next waiter.
        const next = this.waiting.shift();
        if (next) next(); else this.running--;
      }
    } finally {
      const remaining = this.clients.get(client)! - 1;
      if (remaining) this.clients.set(client, remaining);
      else this.clients.delete(client);
    }
  }
}
