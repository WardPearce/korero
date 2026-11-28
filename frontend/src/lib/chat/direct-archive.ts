import Dexie, { liveQuery, type Table } from "dexie";
import { directRequest, isSameDirectMessage, type DirectMessage, type DirectMessageChange, type DirectMessageReference } from "../connection/client";
import { getIdentity } from "../identity/identity";
import { preferences } from "../preferences";
import { decodeDirectContent, directConversation, type DirectPeer } from "./direct-crypto";

/**
 * A direct message this device decrypted and verified. The archive keeps plaintext so
 * conversations outlive the server's retention and can be searched locally.
 */
export interface ArchivedDirectMessage extends DirectMessageReference {
  /** `serverId/senderId/recipientId/id` */
  key: string;
  serverId: string;
  /** The signed-in account the message was archived for. */
  ownerId: string;
  /** The device identity public key that decrypted the message. */
  identity: string;
  peerId: string;
  peerName: string;
  createdAt: number;
  editedAt: number | null;
  text: string;
  html?: string;
  /** Lowercased `text` for substring search. */
  folded: string;
}

/** Identifies one signed-in session whose direct messages are archived. */
export interface ArchiveScope {
  serverId: string;
  ownerId: string;
  connectionId: string;
}

class DirectArchiveDatabase extends Dexie {
  declare messages: Table<ArchivedDirectMessage, string>;

  constructor() {
    super("korero-direct-messages");
    this.version(1).stores({
      messages: "&key, [serverId+ownerId+createdAt], [serverId+ownerId+peerId+createdAt], serverId, identity",
    });
  }
}

const database = new DirectArchiveDatabase();
type Conversation = Awaited<ReturnType<typeof directConversation>>;
export type OpenedConversation = { peer: DirectPeer; conversation: Conversation; pinKey: string; verified: boolean };
const conversations = new Map<string, Promise<OpenedConversation>>();
const maxCachedConversations = 200;
// Writes run in order so a late decryption cannot revive a message deleted after it arrived.
let writes = Promise.resolve();

function archiveKey(serverId: string, { senderId, recipientId, id }: DirectMessageReference) {
  return `${serverId}/${senderId}/${recipientId}/${id}`;
}

function peerOf(ownerId: string, { senderId, recipientId }: DirectMessageReference) {
  return senderId === ownerId ? recipientId : senderId;
}

function enqueue<T>(work: () => Promise<T>) {
  const result = writes.then(work);
  writes = result.then(() => undefined, () => undefined);
  return result;
}

/**
 * Resolves the contact's identity and derives the conversation keys. It fails when the
 * contact's identity differs from a safety code verified on this device.
 */
export function openConversation({ serverId, ownerId, connectionId }: ArchiveScope, peerId: string) {
  const cacheKey = `${serverId}/${ownerId}/${connectionId}/${peerId}`;
  let opened = conversations.get(cacheKey);
  if (!opened) {
    opened = (async () => {
      const identity = getIdentity();
      const contact = await directRequest<DirectPeer & { ownPublicKey: string }>(connectionId, "direct.peer", { accountId: peerId });
      if (!identity || contact.accountId !== peerId) throw new Error("The conversation identity is unavailable.");
      if (identity.publicKey !== contact.ownPublicKey) throw new Error("Reconnect with this account’s identity to open direct messages.");
      const conversation = await directConversation(serverId, ownerId, identity, contact);
      const pinKey = `direct-safety-code:${JSON.stringify([serverId, identity.publicKey, ownerId, peerId])}`;
      const pinned = await preferences.local.get(pinKey);
      if (pinned && pinned.value !== conversation.safetyCode) {
        throw new Error("This contact’s identity differs from the verified identity on this device.");
      }
      return { peer: contact, conversation, pinKey, verified: Boolean(pinned) };
    })();
    // A failure, such as a dropped connection, must not stick.
    opened.catch(() => { if (conversations.get(cacheKey) === opened) conversations.delete(cacheKey); });
    conversations.set(cacheKey, opened);
    if (conversations.size > maxCachedConversations) conversations.delete(conversations.keys().next().value!);
  }
  return opened;
}

async function decrypt(scope: ArchiveScope, message: DirectMessage): Promise<ArchivedDirectMessage | undefined> {
  const peerId = peerOf(scope.ownerId, message);
  const identity = getIdentity();
  if (!identity || peerId === scope.ownerId) return undefined;
  try {
    const { peer, conversation } = await openConversation(scope, peerId);
    const { text, html } = decodeDirectContent(await conversation.decrypt(message));
    return {
      key: archiveKey(scope.serverId, message), serverId: scope.serverId, ownerId: scope.ownerId, identity: identity.publicKey,
      id: message.id, senderId: message.senderId, recipientId: message.recipientId, peerId, peerName: peer.displayName,
      createdAt: message.createdAt, editedAt: message.editedAt ?? null, text, ...(html ? { html } : {}), folded: text.toLocaleLowerCase(),
    };
  } catch {
    // Unverifiable packets stay out of the archive. The conversation reports them.
    return undefined;
  }
}

/**
 * Decrypts and stores packets from history, live delivery or the offline queue. Returns the
 * packets that could not be verified or decrypted.
 */
export function archiveMessages(scope: ArchiveScope, messages: readonly DirectMessage[]) {
  return enqueue(async () => {
    const failed: DirectMessage[] = [];
    const entries: ArchivedDirectMessage[] = [];
    const stored = await database.messages.bulkGet(messages.map((message) => archiveKey(scope.serverId, message)));
    for (const [index, message] of messages.entries()) {
      const known = stored[index];
      if (known && (known.editedAt ?? 0) >= (message.editedAt ?? 0)) continue;
      const entry = await decrypt(scope, message);
      if (entry) entries.push(entry);
      else failed.push(message);
    }
    if (entries.length) {
      await database.transaction("rw", database.messages, async () => {
        const known = await database.messages.bulkGet(entries.map(({ key }) => key));
        // Keep a newer edit already stored. History pages can be older than live edits.
        const fresh = entries.filter((entry, index) => (known[index]?.editedAt ?? 0) <= (entry.editedAt ?? 0));
        if (fresh.length) await database.messages.bulkPut(fresh);
      });
    }
    return failed;
  });
}

/** Applies a live edit or delete. An edit of a message missing from the archive needs its `createdAt`. */
export function archiveChange(scope: ArchiveScope, change: DirectMessageChange) {
  const key = archiveKey(scope.serverId, change.message);
  if (change.type === "delete") return enqueue(() => database.messages.delete(key));
  return enqueue(async () => {
    const known = await database.messages.get(key);
    const createdAt = known?.createdAt ?? change.message.createdAt;
    if (createdAt === undefined) return;
    const entry = await decrypt(scope, { ...change.message, createdAt });
    if (entry && (known?.editedAt ?? 0) <= (entry.editedAt ?? 0)) await database.messages.put(entry);
  });
}

/** Drops packets the caller saw deleted while a history page was in flight. */
export function withoutDeleted(messages: DirectMessage[], changes: readonly DirectMessageChange[]) {
  const deleted = changes.filter(({ type }) => type === "delete").map(({ message }) => message);
  return messages.filter((message) => !deleted.some((reference) => isSameDirectMessage(message, reference)));
}

/** Watches the latest `limit` archived messages of a conversation, oldest first, and how many are archived in total. */
export function watchConversation(serverId: string, ownerId: string, peerId: string, limit: number) {
  return liveQuery(async () => {
    const range = () => database.messages.where("[serverId+ownerId+peerId+createdAt]")
      .between([serverId, ownerId, peerId, Dexie.minKey], [serverId, ownerId, peerId, Dexie.maxKey]);
    const [rows, total] = await Promise.all([range().reverse().limit(limit).toArray(), range().count()]);
    return { messages: rows.reverse(), total };
  });
}

/** Counts archived messages in a conversation at or after `createdAt`, to size a view that includes it. */
export function countSince(serverId: string, ownerId: string, peerId: string, createdAt: number) {
  return database.messages.where("[serverId+ownerId+peerId+createdAt]")
    .between([serverId, ownerId, peerId, createdAt], [serverId, ownerId, peerId, Dexie.maxKey]).count();
}

/** Finds archived messages containing `query` across every conversation, newest first. */
export async function searchArchive(serverId: string, ownerId: string, query: string, limit = 50) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  return database.messages.where("[serverId+ownerId+createdAt]")
    .between([serverId, ownerId, Dexie.minKey], [serverId, ownerId, Dexie.maxKey])
    .reverse().filter(({ folded }) => folded.includes(needle)).limit(limit).toArray();
}

/** Removes the archive for a server this device no longer saves. */
export function forgetServerArchive(serverId: string) {
  return enqueue(() => database.messages.where("serverId").equals(serverId).delete());
}

/** Removes messages decrypted by an identity that signed out of this device. */
export function forgetIdentityArchive(publicKey: string) {
  conversations.clear();
  return enqueue(() => database.messages.where("identity").equals(publicKey).delete());
}
