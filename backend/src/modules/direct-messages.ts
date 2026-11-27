import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lt, max, or } from "drizzle-orm";
import type { Config } from "../config";
import type { Store } from "../database";
import { accountIdentities, accounts, directMessages } from "../database/schema";
import type { Request } from "../protocol";
import { fail } from "../security/errors";

type Send = Extract<Request, { type: "direct.send" }>["payload"];
type Edit = Extract<Request, { type: "direct.edit" }>["payload"];
type Cursor = Extract<Request, { type: "direct.history" }>["payload"]["before"];

const pageSize = 10;
const pendingPageSize = 100;
const { id: packetId, senderId: packetSender, recipientId: packetRecipient, createdAt: packetCreated, editedAt: packetEdited, nonce, ciphertext, signature } = directMessages;
const packet = { id: packetId, senderId: packetSender, recipientId: packetRecipient, createdAt: packetCreated, editedAt: packetEdited, nonce, ciphertext, signature };
const tagBytes = 16;

function byteLength(value: string) {
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) fail("INVALID_REQUEST");
  return bytes.length;
}

export class DirectMessages {
  constructor(private readonly db: Store, private readonly config: Config) {}

  get maxBytes() {
    // Reserve room for the request envelope and base64url expansion.
    return Math.min(this.config.messaging.max_length, Math.floor((this.config.limits.websocket_bytes - 512) * 3 / 4) - tagBytes);
  }

  peer(actorId: string, accountId: string) {
    if (actorId === accountId) fail("INVALID_REQUEST");
    return this.db.select({ accountId: accounts.id, displayName: accounts.displayName, publicKey: accountIdentities.publicKey })
      .from(accounts).innerJoin(accountIdentities, eq(accounts.id, accountIdentities.accountId))
      .where(eq(accounts.id, accountId)).get() ?? fail("NOT_FOUND");
  }

  identities(actorId: string, accountId: string) {
    const peer = this.peer(actorId, accountId);
    const own = this.db.select({ publicKey: accountIdentities.publicKey }).from(accountIdentities)
      .where(eq(accountIdentities.accountId, actorId)).get() ?? fail("NOT_FOUND");
    return { ...peer, ownPublicKey: own.publicKey };
  }

  inbox(actorId: string) {
    if (!this.config.messaging.persistence) return [];
    const { senderId, recipientId, createdAt } = directMessages;
    const cutoff = this.cutoff();
    const partners = this.db.select({ accountId: recipientId, createdAt }).from(directMessages)
      .where(and(eq(senderId, actorId), gte(createdAt, cutoff)))
      .unionAll(this.db.select({ accountId: senderId, createdAt }).from(directMessages)
        .where(and(eq(recipientId, actorId), gte(createdAt, cutoff))))
      .as("direct_partners");
    const latest = max(partners.createdAt);
    return this.db.select({ accountId: accounts.id, displayName: accounts.displayName, lastMessageAt: latest })
      .from(partners).innerJoin(accounts, eq(accounts.id, partners.accountId))
      .groupBy(accounts.id).orderBy(desc(latest), accounts.id).limit(50).all();
  }

  history(actorId: string, accountId: string, before?: Cursor) {
    if (!this.config.messaging.persistence) return { messages: [], next: null };
    const { id, senderId, recipientId, createdAt } = directMessages;
    const scope = or(and(eq(senderId, actorId), eq(recipientId, accountId)), and(eq(senderId, accountId), eq(recipientId, actorId)));
    const cursor = before && or(lt(createdAt, before.createdAt), and(eq(createdAt, before.createdAt), lt(id, before.id)));
    const messages = this.db.select(packet).from(directMessages).where(and(scope, gte(createdAt, this.cutoff()), cursor))
      .orderBy(desc(createdAt), desc(id)).limit(pageSize + 1).all();
    const extra = messages.length > pageSize;
    if (extra) messages.pop();
    const oldest = messages.at(-1);
    return { messages, next: extra && oldest ? { id: oldest.id, createdAt: oldest.createdAt } : null };
  }

  /**
   * Accepts a packet. `delivered` is true when a recipient device is connected and
   * receives `direct.created` immediately. Otherwise the server queues the packet
   * until a recipient device fetches and acknowledges it.
   */
  send(senderId: string, { accountId: recipientId, ...packet }: Send, delivered: boolean) {
    this.validate(packet);
    const createdAt = Date.now();
    const message = { ...packet, senderId, recipientId, createdAt };
    if (!this.config.messaging.persistence && delivered) return message;
    if (!delivered) {
      const { queued } = this.db.select({ queued: count() }).from(directMessages)
        .where(and(eq(directMessages.recipientId, recipientId), isNull(directMessages.deliveredAt))).get()!;
      if (queued >= this.config.messaging.offline_delivery_queue) fail("LIMIT");
      // One sender must not be able to fill a recipient's whole queue.
      const { fromSender } = this.db.select({ fromSender: count() }).from(directMessages)
        .where(and(eq(directMessages.senderId, senderId), eq(directMessages.recipientId, recipientId), isNull(directMessages.deliveredAt))).get()!;
      if (fromSender >= this.config.messaging.offline_delivery_per_sender) fail("LIMIT");
    }
    const inserted = this.db.insert(directMessages).values({ ...message, deliveredAt: delivered ? createdAt : null })
      .onConflictDoNothing().returning({ id: directMessages.id }).get();
    if (!inserted) {
      const existing = this.db.select().from(directMessages).where(eq(directMessages.id, packet.id)).get();
      if (existing?.senderId !== senderId || existing.recipientId !== recipientId ||
          existing.nonce !== packet.nonce || existing.ciphertext !== packet.ciphertext || existing.signature !== packet.signature) fail("CONFLICT");
      return null;
    }
    return message;
  }

  private validate(packet: Pick<Send, "nonce" | "ciphertext" | "signature">) {
    const size = byteLength(packet.ciphertext) - tagBytes;
    if (size < 1 || size > this.maxBytes || byteLength(packet.nonce) !== 12 || byteLength(packet.signature) !== 64) fail("INVALID_REQUEST");
  }

  /**
   * Replaces a packet the actor sent and returns the edited packet. Without persistence
   * the server holds no delivered packets, so it relays the edit when `relay` is true.
   * The recipient verifies the sender's signature before applying it.
   */
  edit(senderId: string, { accountId: recipientId, ...replacement }: Edit, relay: boolean) {
    this.validate(replacement);
    const editedAt = Date.now();
    const { id, nonce: newNonce, ciphertext: newCiphertext, signature: newSignature } = replacement;
    const scope = and(eq(directMessages.id, id), eq(directMessages.senderId, senderId), eq(directMessages.recipientId, recipientId),
      gte(directMessages.createdAt, this.cutoff()));
    const updated = this.db.update(directMessages).set({ nonce: newNonce, ciphertext: newCiphertext, signature: newSignature, editedAt })
      .where(scope).returning(packet).get();
    if (updated) return updated;
    if (this.config.messaging.persistence || !relay) fail("NOT_FOUND");
    // The server does not know when the original was created, so the packet has no `createdAt`.
    return { ...replacement, senderId, recipientId, editedAt };
  }

  /** Removes a packet the actor sent. Without persistence, `relay` lets the delete reach a recipient that already holds it. */
  delete(senderId: string, recipientId: string, id: string, relay: boolean) {
    const removed = this.db.delete(directMessages).where(and(eq(directMessages.id, id), eq(directMessages.senderId, senderId),
      eq(directMessages.recipientId, recipientId))).returning({ id: directMessages.id }).get();
    if (removed) return;
    if (this.config.messaging.persistence || !relay) fail("NOT_FOUND");
  }

  /** Returns the oldest packets still waiting for one of the actor's devices. */
  pending(actorId: string) {
    const { recipientId, deliveredAt, createdAt, id } = directMessages;
    return this.db.select({ ...packet, senderName: accounts.displayName }).from(directMessages)
      .innerJoin(accounts, eq(accounts.id, directMessages.senderId))
      .where(and(eq(recipientId, actorId), isNull(deliveredAt), gte(createdAt, this.cutoff())))
      .orderBy(asc(createdAt), asc(id)).limit(pendingPageSize).all();
  }

  /** Marks queued packets as delivered. Without persistence the server no longer needs them. */
  acknowledge(actorId: string, ids: string[]) {
    const { recipientId, deliveredAt, id } = directMessages;
    const scope = and(eq(recipientId, actorId), isNull(deliveredAt), inArray(id, ids));
    if (this.config.messaging.persistence) this.db.update(directMessages).set({ deliveredAt: Date.now() }).where(scope).run();
    else this.db.delete(directMessages).where(scope).run();
  }

  prune() {
    const { id, createdAt, deliveredAt } = directMessages;
    const stale = lt(createdAt, this.cutoff());
    // Packets kept while persistence was enabled are history and are not retained once it is off.
    const expired = this.db.select({ id }).from(directMessages)
      .where(this.config.messaging.persistence ? stale : or(stale, isNotNull(deliveredAt))).limit(1000);
    this.db.delete(directMessages).where(inArray(directMessages.id, expired)).run();
  }

  private cutoff() {
    const { persistence, retention_hours, offline_delivery_hours } = this.config.messaging;
    return Date.now() - (persistence ? retention_hours : offline_delivery_hours) * 3600000;
  }
}
