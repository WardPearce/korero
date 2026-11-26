import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { decodeBase64Url, encodeBase64Url, identitySeed } from "../identity/browser-identity";
import type { DirectMessage } from "../connection/client";
import type { DeviceIdentity } from "../preferences";

export type DirectPeer = { accountId: string; displayName: string; publicKey: string };
export type DirectPacket = Pick<DirectMessage, "id" | "nonce" | "ciphertext" | "signature"> & { accountId: string };
export type DirectCursor = Pick<DirectMessage, "id" | "createdAt">;
export type DirectPage = { messages: DirectMessage[]; next: DirectCursor | null };

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const transcript = (fields: unknown[]) => encoder.encode(JSON.stringify(fields));

function publicKey(value: string) {
  const bytes = decodeBase64Url(value);
  if (bytes.length !== 32 || encodeBase64Url(bytes) !== value) throw new Error("Invalid conversation identity.");
  const point = ed25519.Point.fromBytes(bytes, false);
  if (!point.isTorsionFree() || point.isSmallOrder()) throw new Error("Invalid conversation identity.");
  return bytes;
}

export async function directConversation(serverId: string, ownId: string, identity: DeviceIdentity, peer: DirectPeer) {
  const seed = identitySeed(identity.privateKey);
  const ownKey = ed25519.getPublicKey(seed);
  if (encodeBase64Url(ownKey) !== identity.publicKey || ownId === peer.accountId || identity.publicKey === peer.publicKey) {
    throw new Error("Invalid conversation identity.");
  }
  const peerKey = publicKey(peer.publicKey);
  const participants = ownId < peer.accountId
    ? [[ownId, identity.publicKey], [peer.accountId, peer.publicKey]]
    : [[peer.accountId, peer.publicKey], [ownId, identity.publicKey]];
  const digest = await crypto.subtle.digest("SHA-256", transcript(["korero-direct-safety-code-v1", serverId, participants]));
  const safetyCode = Array.from(new Uint8Array(digest, 0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const secret = x25519.getSharedSecret(ed25519.utils.toMontgomerySecret(seed), ed25519.utils.toMontgomery(peerKey));
  const shared = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  secret.fill(0);
  const context = (senderId: string, recipientId: string, id: string) =>
    ["korero-direct-message-v1", serverId, senderId, recipientId, id];
  const derive = (info: Uint8Array<ArrayBuffer>) =>
    crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info },
      shared, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  return {
    safetyCode,
    async encrypt(text: string): Promise<DirectPacket> {
      const id = crypto.randomUUID();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const fields = context(ownId, peer.accountId, id);
      const additionalData = transcript(fields);
      const key = await derive(additionalData);
      const nonce = encodeBase64Url(iv);
      const ciphertext = encodeBase64Url(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData }, key, encoder.encode(text)));
      const signature = encodeBase64Url(ed25519.sign(transcript([...fields, nonce, ciphertext]), seed));
      return { accountId: peer.accountId, id, nonce, ciphertext, signature };
    },
    async decrypt(message: DirectMessage) {
      const { id, senderId, recipientId, nonce, ciphertext, signature } = message;
      const outgoing = senderId === ownId && recipientId === peer.accountId;
      const incoming = senderId === peer.accountId && recipientId === ownId;
      if (!outgoing && !incoming) throw new Error("The message belongs to a different conversation.");
      const fields = context(senderId, recipientId, id);
      if (!ed25519.verify(decodeBase64Url(signature), transcript([...fields, nonce, ciphertext]), outgoing ? ownKey : peerKey, { zip215: false })) {
        throw new Error("The message signature could not be verified.");
      }
      const additionalData = transcript(fields);
      const key = await derive(additionalData);
      const text = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decodeBase64Url(nonce), additionalData }, key, decodeBase64Url(ciphertext));
      return decoder.decode(text);
    },
  };
}
