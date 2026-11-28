import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Config } from "../config";
import { fail, ProtocolError, RateLimit } from "../security/errors";
import type { SearchJob, SearchPage, SearchQuery, SearchResult } from "./message-search-worker";

type Pending = { resolve: (page: SearchPage) => void; reject: (error: ProtocolError) => void; timeout: ReturnType<typeof setTimeout> };
const embeddedWorker = "/$bunfs/root/modules/message-search-worker.js";

export class MessageSearch {
  private readonly databasePath: string;
  private readonly perAccount: RateLimit;
  private readonly global: RateLimit;
  private readonly pending = new Map<string, Pending>();
  private worker?: Worker;

  constructor(config: Config) {
    this.databasePath = join(config.directory, "server.db");
    this.perAccount = new RateLimit(config.limits.message_searches_per_minute);
    this.global = new RateLimit(config.limits.message_searches_global_per_minute, 1);
  }

  async run(accountId: string, query: SearchQuery) {
    if (this.pending.has(accountId) || this.pending.size >= 8) fail("RATE_LIMITED");
    this.perAccount.take(accountId);
    this.global.take("search");
    const worker = this.worker ?? this.startWorker();
    const job: SearchJob = { ...query, accountId, databasePath: this.databasePath };
    return new Promise<SearchPage>((resolve, reject) => {
      const timeout = setTimeout(() => this.close(), 5000);
      this.pending.set(accountId, { resolve, reject, timeout });
      try { worker.postMessage(job); }
      catch { this.close(); }
    });
  }

  private startWorker() {
    let worker: Worker;
    try { worker = new Worker(existsSync(embeddedWorker) ? embeddedWorker : new URL("./message-search-worker.ts", import.meta.url).href); }
    catch { fail("UNAVAILABLE"); }
    this.worker = worker;
    worker.onmessage = ({ data }: MessageEvent<SearchResult>) => {
      if (this.worker !== worker) return;
      const pending = this.pending.get(data.accountId);
      if (!pending) return;
      this.pending.delete(data.accountId);
      clearTimeout(pending.timeout);
      if (data.page) pending.resolve(data.page);
      else pending.reject(new ProtocolError("UNAVAILABLE"));
    };
    const stopped = () => { if (this.worker === worker) this.close(); };
    worker.addEventListener("error", stopped);
    worker.addEventListener("close", stopped);
    return worker;
  }

  close() {
    const worker = this.worker;
    this.worker = undefined;
    worker?.terminate();
    for (const { reject, timeout } of this.pending.values()) {
      clearTimeout(timeout);
      reject(new ProtocolError("UNAVAILABLE"));
    }
    this.pending.clear();
  }
}
