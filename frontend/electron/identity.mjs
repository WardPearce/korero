import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, webcrypto } from "node:crypto";

const header = Buffer.from("KORERO-IDENTITY-1");
const legacyPrefix = Buffer.from("3051020101300506032b657004220420", "hex");
const seedPrefix = Buffer.from("302e020100300506032b657004220420", "hex");
const publicTag = Buffer.from([0x81, 0x21, 0]);

export function loadIdentity(privateKey) {
  if (typeof privateKey !== "string" || !/^[\w-]{111}$/.test(privateKey)) throw new Error("Invalid Korero.chat identity key.");
  const der = Buffer.from(privateKey, "base64url");
  if (!der.subarray(0, 16).equals(legacyPrefix) || !der.subarray(48, 51).equals(publicTag)) {
    throw new Error("Invalid Korero.chat identity key.");
  }
  const seed = Buffer.concat([seedPrefix, der.subarray(16, 48)]);
  try {
    const key = createPrivateKey({ key: seed, type: "pkcs8", format: "der" });
    const { x: publicKey } = createPublicKey(key).export({ format: "jwk" });
    if (publicKey !== der.subarray(51).toString("base64url")) throw new Error("Invalid Korero.chat identity key.");
    return { publicKey, sign: (transcript) => sign(null, Buffer.from(JSON.stringify(transcript)), key).toString("base64url") };
  } finally {
    seed.fill(0);
    der.fill(0);
  }
}

export function generateIdentity() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const { d, x } = privateKey.export({ format: "jwk" });
  const encoded = Buffer.concat([legacyPrefix, Buffer.from(d, "base64url"), publicTag, Buffer.from(x, "base64url")]);
  return { publicKey: publicKey.export({ format: "jwk" }).x, privateKey: encoded.toString("base64url") };
}

async function wrappingKey(passphrase, salt, use) {
  if (typeof passphrase !== "string" || [...passphrase].length < 12) throw new Error("Use a passphrase of at least 12 characters.");
  const base = await webcrypto.subtle.importKey("raw", Buffer.from(passphrase), "PBKDF2", false, ["deriveKey"]);
  return webcrypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 600000, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, [use]);
}

export async function exportIdentity(privateKey, passphrase) {
  loadIdentity(privateKey);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await wrappingKey(passphrase, salt, "encrypt");
  const raw = Buffer.from(privateKey, "base64url");
  try {
    const sealed = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: header }, key, raw);
    return Buffer.concat([header, salt, iv, Buffer.from(sealed)]).toString("base64url");
  } finally { raw.fill(0); }
}

export async function importIdentity(blob, passphrase) {
  if (typeof blob !== "string" || blob.length > 1024) throw new Error("Invalid Korero.chat identity export.");
  const bytes = Buffer.from(blob.trim(), "base64url");
  const offset = header.length;
  if (bytes.length !== offset + 16 + 12 + 83 + 16 || !bytes.subarray(0, offset).equals(header)) {
    throw new Error("Invalid Korero.chat identity export.");
  }
  const key = await wrappingKey(passphrase, bytes.subarray(offset, offset + 16), "decrypt");
  const opened = await webcrypto.subtle.decrypt({
    name: "AES-GCM", iv: bytes.subarray(offset + 16, offset + 28), additionalData: header,
  }, key, bytes.subarray(offset + 28)).catch(() => { throw new Error("Incorrect passphrase or damaged identity export."); });
  const raw = Buffer.from(opened);
  try {
    const privateKey = raw.toString("base64url");
    return { publicKey: loadIdentity(privateKey).publicKey, privateKey };
  } finally { raw.fill(0); }
}
