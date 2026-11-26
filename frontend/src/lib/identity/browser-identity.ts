import type { DeviceIdentity } from "../preferences";

const encoder = new TextEncoder();
const header = encoder.encode("KORERO-IDENTITY-1");
const pkcs8Header = [0x30, 0x51, 2, 1, 1, 0x30, 5, 6, 3, 0x2b, 0x65, 0x70, 4, 0x22, 4, 0x20];

export function encodeBase64Url(bytes: ArrayBuffer | Uint8Array) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeBase64Url(value: string) {
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (character) => character.charCodeAt(0));
}

function checkEnvelope(pkcs8: Uint8Array) {
  if (pkcs8.length !== 83 || !pkcs8Header.every((byte, index) => byte === pkcs8[index]) ||
      pkcs8[48] !== 0x81 || pkcs8[49] !== 0x21 || pkcs8[50] !== 0) throw new Error("Invalid VNX.chat identity key.");
}

export function identitySeed(privateKey: string) {
  const pkcs8 = decodeBase64Url(privateKey);
  checkEnvelope(pkcs8);
  return pkcs8.slice(16, 48);
}

export async function browserIdentity(): Promise<DeviceIdentity> {
  const { privateKey, publicKey } = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const { d, x } = await crypto.subtle.exportKey("jwk", privateKey);
  if (!d || !x) throw new Error("Could not create an identity.");
  // Use the version 2 PKCS#8 envelope emitted by the desktop client.
  const pkcs8 = Uint8Array.of(...pkcs8Header, ...decodeBase64Url(d), 0x81, 0x21, 0, ...new Uint8Array(await crypto.subtle.exportKey("raw", publicKey)));
  return { privateKey: encodeBase64Url(pkcs8), publicKey: x };
}

async function unpack(pkcs8: Uint8Array) {
  checkEnvelope(pkcs8);
  const v1 = pkcs8.slice(0, 48);
  v1[1] = 46;
  v1[4] = 0;
  const key = await crypto.subtle.importKey("pkcs8", v1, "Ed25519", true, ["sign"]);
  const { x } = await crypto.subtle.exportKey("jwk", key);
  if (!x || x !== encodeBase64Url(pkcs8.slice(51))) throw new Error("Invalid VNX.chat identity key.");
  return { key, publicKey: x };
}

async function wrappingKey(passphrase: string, salt: Uint8Array<ArrayBuffer>) {
  if (Array.from(passphrase).length < 12) throw new Error("Use a passphrase of at least 12 characters.");
  const base = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 600000, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function importBrowserIdentity(blob: string, passphrase: string): Promise<DeviceIdentity> {
  const bytes = decodeBase64Url(blob.trim());
  const offset = header.length;
  if (bytes.length !== offset + 16 + 12 + 83 + 16 || !header.every((byte, index) => bytes[index] === byte)) {
    throw new Error("Invalid VNX.chat identity export.");
  }
  const key = await wrappingKey(passphrase, bytes.slice(offset, offset + 16));
  const pkcs8 = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(offset + 16, offset + 28), additionalData: header },
    key, bytes.slice(offset + 28)).catch(() => { throw new Error("Incorrect passphrase or damaged identity export."); });
  const { publicKey } = await unpack(new Uint8Array(pkcs8));
  return { privateKey: encodeBase64Url(pkcs8), publicKey };
}

export async function exportBrowserIdentity(privateKey: string, passphrase: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await wrappingKey(passphrase, salt);
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: header }, key, decodeBase64Url(privateKey));
  return encodeBase64Url(Uint8Array.of(...header, ...salt, ...iv, ...new Uint8Array(sealed)));
}

export async function signIdentity(identity: DeviceIdentity, transcript: unknown[]) {
  const { key } = await unpack(decodeBase64Url(identity.privateKey));
  return encodeBase64Url(await crypto.subtle.sign("Ed25519", key, encoder.encode(JSON.stringify(transcript))));
}
