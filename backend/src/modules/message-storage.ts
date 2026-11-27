import { eq, inArray, isNotNull, lt } from "drizzle-orm";
import type { Config } from "../config";
import type { Queries, Store } from "../database";
import { attachments, directMessages, messages, storedMessageUsage } from "../database/schema";
import { bytesPerMiB, maxSupportedAttachmentMiB } from "../protocol";
import { fail } from "../security/errors";

const rowsPerSweep = 1000;
const attachmentBytesPerSweep = maxSupportedAttachmentMiB * bytesPerMiB;

export class MessageStorage {
  constructor(private readonly db: Store, private readonly config: Config["messaging"]) {}

  write<T>(run: (tx: Queries) => T) {
    return this.db.transaction((tx) => {
      const usage = () => tx.select({ bytes: storedMessageUsage.bytes }).from(storedMessageUsage).get()!.bytes;
      // Databases already over budget can still accept edits that do not increase usage.
      const limit = Math.max(this.config.stored_message_bytes, usage());
      const result = run(tx);
      if (usage() > limit) fail("LIMIT");
      return result;
    }, { behavior: "immediate" });
  }

  channelCutoff(now = Date.now()) {
    return now - this.config.retention_hours * 3600000;
  }

  directCutoff(now = Date.now()) {
    const { persistence, retention_hours, offline_delivery_hours } = this.config;
    return now - (persistence ? retention_hours : offline_delivery_hours) * 3600000;
  }

  prune(now: number) {
    const expired = this.db.select({ id: messages.id, size: attachments.size }).from(messages)
      .leftJoin(attachments, eq(attachments.messageId, messages.id))
      .where(lt(messages.createdAt, this.channelCutoff(now))).orderBy(messages.createdAt).limit(rowsPerSweep).all();
    const ids: string[] = [];
    let attachmentBytes = 0;
    for (const { id, size } of expired) {
      attachmentBytes += size ?? 0;
      if (ids.length && attachmentBytes > attachmentBytesPerSweep) break;
      ids.push(id);
    }
    if (ids.length) this.db.delete(messages).where(inArray(messages.id, ids)).run();

    const { id, createdAt, deliveredAt } = directMessages;
    const stale = this.db.select({ id }).from(directMessages)
      .where(lt(createdAt, this.directCutoff(now))).orderBy(createdAt).limit(rowsPerSweep);
    this.db.delete(directMessages).where(inArray(id, stale)).run();
    if (!this.config.persistence) {
      const delivered = this.db.select({ id }).from(directMessages)
        .where(isNotNull(deliveredAt)).orderBy(deliveredAt).limit(rowsPerSweep);
      this.db.delete(directMessages).where(inArray(id, delivered)).run();
    }
  }
}
