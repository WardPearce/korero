import { getLocalBookmarkPasswords, saveBookmarkPasswords, type SavedServer } from "../preferences";
import { decodeBase64Url, encodeBase64Url, identityFromPrivateKey } from "./browser-identity";
import { HostedAccount, isBookmarkPassword, isSavedServer, type BookmarkPassword, type HostedLink } from "./hosted-account";
import { saveLocalIdentity, type LocalProfile } from "./local-identity";

// A device link signs another device, such as a phone, in to the same identity.
// A local link carries the private key, username, saved servers, and saved server passwords.
// A hosted link carries the provider, username, sign-in credential, and encryption key, and the new device reads the rest
// from the provider. The payload is encrypted with a random link code that is shown only on the
// source device, so a photo of the QR code alone cannot be used.
const encoder = new TextEncoder();
const prefix = "KORERO-LINK-1.";
const additionalData = encoder.encode("korero-device-link-v1");
// Crockford base32: 32 symbols without I, L, O, or U, so each random byte maps without bias.
const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const iterations = 600000;
// Keep the payload well within QR byte-mode capacity at error correction level L (2953 bytes).
const maxPayloadLength = 2200;

export interface DeviceLink { payload: string; code: string }
export type LinkedIdentity =
  | { kind: "local"; profile: LocalProfile }
  | { kind: "hosted"; result: Awaited<ReturnType<typeof HostedAccount.fromLink>> };

type LinkData =
  | { v: 1; kind: "local"; username: string; privateKey: string; servers: SavedServer[]; passwords?: BookmarkPassword[] }
  | ({ v: 1; kind: "hosted" } & HostedLink);

export function generateLinkCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const code = Array.from(bytes, (byte) => alphabet[byte & 31]).join("");
  return code.replace(/(.{4})(?=.)/g, "$1-");
}

function normalizeLinkCode(code: string) {
  const normalized = code.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (normalized.length !== 16 || [...normalized].some((character) => !alphabet.includes(character))) {
    throw new Error("Enter the 16-character link code shown on the other device.");
  }
  return normalized;
}

async function linkKey(code: string, salt: Uint8Array<ArrayBuffer>) {
  const base = await crypto.subtle.importKey("raw", encoder.encode(code), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function sealLink(data: LinkData): Promise<DeviceLink> {
  const code = generateLinkCode();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await linkKey(normalizeLinkCode(code), salt);
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData }, key, encoder.encode(JSON.stringify(data)));
  const payload = prefix + encodeBase64Url(Uint8Array.of(...salt, ...iv, ...new Uint8Array(sealed)));
  if (payload.length > maxPayloadLength) throw new Error("This identity has too many saved servers or passwords to link by QR code.");
  return { payload, code };
}

export async function createLocalDeviceLink({ username, identity, servers }: LocalProfile) {
  const passwords = await getLocalBookmarkPasswords(servers);
  return sealLink({ v: 1, kind: "local", username, privateKey: identity.privateKey, servers, passwords });
}

export async function createHostedDeviceLink(account: HostedAccount) {
  return sealLink({ v: 1, kind: "hosted", ...await account.linkData() });
}

export async function openDeviceLink(payload: string, code: string): Promise<LinkData> {
  const text = payload.trim();
  if (!text.startsWith(prefix) || text.length > maxPayloadLength) throw new Error("Scan a Korero.chat device link.");
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = decodeBase64Url(text.slice(prefix.length));
  } catch {
    throw new Error("Scan a Korero.chat device link.");
  }
  if (bytes.length <= 16 + 12 + 16) throw new Error("Scan a Korero.chat device link.");
  const key = await linkKey(normalizeLinkCode(code), bytes.slice(0, 16));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(16, 28), additionalData }, key, bytes.slice(28))
    .catch(() => { throw new Error("Incorrect link code or damaged device link."); });
  const data: unknown = JSON.parse(new TextDecoder().decode(plain));
  if (!data || typeof data !== "object") throw new Error("The device link is damaged.");
  const fields = data as Record<string, unknown>;
  if (fields.v === 1 && fields.kind === "local" && typeof fields.username === "string" &&
      typeof fields.privateKey === "string" && Array.isArray(fields.servers) && fields.servers.every(isSavedServer) &&
      (fields.passwords === undefined || (Array.isArray(fields.passwords) && fields.passwords.every(isBookmarkPassword)))) {
    return data as LinkData;
  }
  if (fields.v === 1 && fields.kind === "hosted" && typeof fields.origin === "string" && typeof fields.username === "string" &&
      typeof fields.credential === "string" && typeof fields.key === "string") {
    return data as LinkData;
  }
  throw new Error("The device link is damaged.");
}

export async function importDeviceLink(payload: string, code: string): Promise<LinkedIdentity> {
  const link = await openDeviceLink(payload, code);
  if (link.kind === "hosted") {
    const { origin, username, credential, key } = link;
    return { kind: "hosted", result: await HostedAccount.fromLink({ origin, username, credential, key }) };
  }
  const identity = identityFromPrivateKey(link.privateKey);
  const profile = await saveLocalIdentity(link.username, async () => identity, link.servers);
  // Keep only passwords for servers the link also bookmarks.
  const origins = new Set(link.servers.map(({ origin }) => origin));
  await saveBookmarkPasswords((link.passwords ?? []).filter(({ origin }) => origins.has(origin)));
  return { kind: "local", profile };
}
