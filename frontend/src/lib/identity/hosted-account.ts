import { argon2idAsync } from "@noble/hashes/argon2.js";
import { preferences, type SavedServer } from "../preferences";
import { parseAppearance, type Appearance } from "../theme";
import { decodeBase64Url, encodeBase64Url, identityFromPrivateKey } from "./browser-identity";

const encoder = new TextEncoder();
const context = "korero-hosted-account-v1";
const maxEncryptedLength = 4 * 1024 * 1024;
const sessionKey = "hosted-account";

export const defaultAccountProvider = import.meta.env.DEV
  ? import.meta.env.VITE_DEV_ACCOUNT_PROVIDER as string : "account.korero.chat";

function parseUrl(value: string) {
  try { return new URL(value); } catch { return null; }
}

function providerOrigin(provider: string) {
  const address = provider.trim();
  const url = parseUrl(address.includes("://") ? address : "https://" + address);
  if (!url || url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Enter an HTTPS account provider hostname, with an optional port.");
  }
  return url.origin;
}

async function accountKeys(password: string, origin: string, username: string) {
  const salt = encoder.encode(JSON.stringify([context, origin, username]));
  const master = await argon2idAsync(password, salt, { m: 65536, t: 3, p: 1, dkLen: 32 });
  const key = await crypto.subtle.importKey("raw", master, "HKDF", false, ["deriveBits", "deriveKey"])
    .finally(() => master.fill(0));
  const derivation = { name: "HKDF", hash: "SHA-256", salt };
  const [credential, encryption] = await Promise.all([
    crypto.subtle.deriveBits({ ...derivation, info: encoder.encode("authentication") }, key, 256),
    // Extractable so a signed-in device can pass the account to a phone with a device link.
    crypto.subtle.deriveKey({ ...derivation, info: encoder.encode("encryption") }, key,
      { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]),
  ]);
  return { credential: encodeBase64Url(credential), encryption };
}

export interface BookmarkPassword { origin: string; serverId: string; password: string }

export interface AccountPreferences {
  servers: SavedServer[];
  serverPasswords?: BookmarkPassword[];
  appearance?: Appearance;
}

interface Profile extends AccountPreferences {
  privateKey: string;
}

interface Envelope { encryptedData: string; revision: number }

export interface HostedLink { origin: string; username: string; credential: string; key: string }

interface StoredSession {
  id: string;
  origin: string;
  username: string;
  credential: string;
  encryption: CryptoKey;
  envelope: Envelope;
}

async function storedSession() {
  return (await preferences.local.get(sessionKey))?.value as StoredSession | undefined;
}

async function encrypt(key: CryptoKey, plain: Uint8Array<ArrayBuffer>, additionalData: Uint8Array<ArrayBuffer>) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData }, key, plain);
  const bytes = new Uint8Array(iv.length + sealed.byteLength);
  bytes.set(iv);
  bytes.set(new Uint8Array(sealed), iv.length);
  return encodeBase64Url(bytes);
}

async function decrypt(key: CryptoKey, ciphertext: string, additionalData: Uint8Array<ArrayBuffer>) {
  const bytes = decodeBase64Url(ciphertext);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12), additionalData }, key, bytes.slice(12));
  return new TextDecoder().decode(plain);
}

export function isSavedServer(value: unknown): value is SavedServer {
  if (!value || typeof value !== "object") return false;
  const server = value as Partial<SavedServer>;
  const url = typeof server.origin === "string" ? parseUrl(server.origin) : null;
  return url?.protocol === "https:" && url.origin === server.origin && typeof server.name === "string" &&
    (server.passwordRequired === undefined || typeof server.passwordRequired === "boolean");
}

function isBookmarkPassword(value: unknown): value is BookmarkPassword {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<BookmarkPassword>;
  return typeof entry.origin === "string" && typeof entry.serverId === "string" && entry.serverId.length > 0 &&
    typeof entry.password === "string" && entry.password.length > 0 && entry.password.length <= 128;
}

class ProviderError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export class HostedAccount {
  private constructor(readonly origin: string, readonly username: string,
    private readonly credential: string, private readonly encryption: CryptoKey, private readonly sessionId: string) {}

  static async open(provider: string, name: string, password: string,
    registration?: AccountPreferences & { privateKey: () => Promise<string> }) {
    const origin = providerOrigin(provider);
    const username = name.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_.-]{3,31}$/.test(username)) {
      throw new Error("Use 4–32 characters. Start with a letter or digit and use only letters, digits, dots, underscores or hyphens.");
    }
    if (Array.from(password).length < 12 || password.length > 256) throw new Error("Use a password between 12 and 256 characters.");
    if (!globalThis.crypto?.subtle) throw new Error("Open Korero.chat over HTTPS to use hosted accounts.");

    const { credential, encryption } = await accountKeys(password, origin, username);
    const account = new HostedAccount(origin, username, credential, encryption, crypto.randomUUID());
    let profile: Profile;
    let envelope: Envelope;
    if (registration) {
      profile = { ...registration, privateKey: await registration.privateKey(), serverPasswords: registration.serverPasswords ?? [] };
      const encryptedData = await account.seal(profile, 1);
      await account.request("register", { encryptedData });
      envelope = { encryptedData, revision: 1 };
    } else {
      ({ profile, envelope } = await account.read());
    }
    return account.persist(profile, envelope);
  }

  // Sign in with the provider, username, credential, and encryption key from a device link.
  static async fromLink(link: HostedLink) {
    const origin = providerOrigin(link.origin);
    const username = link.username;
    if (origin !== link.origin || !/^[a-z0-9][a-z0-9_.-]{3,31}$/.test(username) ||
        typeof link.credential !== "string" || typeof link.key !== "string") {
      throw new Error("The device link is damaged.");
    }
    const raw = decodeBase64Url(link.key);
    if (raw.length !== 32) throw new Error("The device link is damaged.");
    const encryption = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"])
      .finally(() => raw.fill(0));
    const account = new HostedAccount(origin, username, link.credential, encryption, crypto.randomUUID());
    const { profile, envelope } = await account.read();
    return account.persist(profile, envelope);
  }

  private async persist(profile: Profile, envelope: Envelope) {
    const result = this.identityResult(profile);
    const sealedCredential = await encrypt(this.encryption, encoder.encode(this.credential), this.additionalData(this.sessionId));
    const value: StoredSession = { id: this.sessionId, origin: this.origin, username: this.username,
      credential: sealedCredential, encryption: this.encryption, envelope };
    await preferences.local.put({ key: sessionKey, value });
    return result;
  }

  async linkData(): Promise<HostedLink> {
    if (!this.encryption.extractable) {
      throw new Error("Sign out and sign in again on this device to link a phone. Sessions from before device links cannot be shared.");
    }
    const key = new Uint8Array(await crypto.subtle.exportKey("raw", this.encryption));
    try {
      return { origin: this.origin, username: this.username, credential: this.credential, key: encodeBase64Url(key) };
    } finally {
      key.fill(0);
    }
  }

  static async restore() {
    const saved = await storedSession();
    if (!saved) return;
    const data = encoder.encode(JSON.stringify([context, saved.origin, saved.username, saved.id]));
    const credential = await decrypt(saved.encryption, saved.credential, data);
    const account = new HostedAccount(saved.origin, saved.username, credential, saved.encryption, saved.id);
    return account.identityResult(await account.openEnvelope(saved.envelope));
  }

  async signOut() {
    await preferences.transaction("rw", preferences.local, async () => {
      if ((await storedSession())?.id === this.sessionId) await preferences.local.delete(sessionKey);
    });
  }

  private identityResult({ privateKey, ...data }: Profile) {
    return { account: this, identity: identityFromPrivateKey(privateKey), data };
  }

  private async cache(envelope: Envelope) {
    await preferences.transaction("rw", preferences.local, async () => {
      const saved = await storedSession();
      if (saved?.id === this.sessionId && envelope.revision > saved.envelope.revision) {
        await preferences.local.put({ key: sessionKey, value: { ...saved, envelope } });
      }
    });
  }

  private async request(action: "register" | "login" | "update", data: Record<string, unknown> = {}) {
    const local = import.meta.env.DEV && this.origin === providerOrigin(defaultAccountProvider);
    const url = (local ? "" : this.origin) + "/api/v1/hosted-account/" + action;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...data, username: this.username, credential: this.credential }),
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    }).catch(() => { throw new Error("Could not reach the account provider. Check its address and HTTPS certificate."); });
    if (response.status === 401) throw new ProviderError(401, "Incorrect username or password.");
    if (!response.ok) {
      const failure = await response.json().catch(() => null);
      const message = typeof failure?.error?.message === "string" ? failure.error.message : "The account provider rejected the request.";
      throw new ProviderError(response.status, message);
    }
    return response;
  }

  private additionalData(binding: number | string) {
    return encoder.encode(JSON.stringify([context, this.origin, this.username, binding]));
  }

  private async seal(profile: Profile, revision: number) {
    const plain = encoder.encode(JSON.stringify(profile));
    if (plain.byteLength + 28 > maxEncryptedLength * 3 / 4) {
      throw new Error("Your saved servers and themes exceed the account storage limit.");
    }
    return encrypt(this.encryption, plain, this.additionalData(revision));
  }

  private async read() {
    const response = await this.request("login");
    const envelope: Envelope = await response.json().catch(() => null);
    return { profile: await this.openEnvelope(envelope), envelope };
  }

  private async openEnvelope(envelope: Envelope) {
    try {
      const { encryptedData, revision } = envelope;
      if (typeof encryptedData !== "string" || encryptedData.length > maxEncryptedLength ||
          typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) throw new Error();
      const profile: Profile = JSON.parse(await decrypt(this.encryption, encryptedData, this.additionalData(revision)));
      if (typeof profile.privateKey !== "string" || !Array.isArray(profile.servers) || !profile.servers.every(isSavedServer)) {
        throw new Error();
      }
      if (profile.serverPasswords !== undefined) {
        if (!Array.isArray(profile.serverPasswords) || !profile.serverPasswords.every(isBookmarkPassword)) throw new Error();
        const origins = new Set(profile.servers.map(({ origin }) => origin));
        profile.serverPasswords = profile.serverPasswords.filter(({ origin }) => origins.has(origin));
      }
      if (profile.appearance !== undefined) profile.appearance = parseAppearance(profile.appearance);
      return profile;
    } catch {
      throw new Error("The account data could not be decrypted or is damaged.");
    }
  }

  async transfer(provider: string, username: string, password: string) {
    if (providerOrigin(provider) === this.origin) throw new Error("Enter a different account provider.");
    const { profile } = await this.read();
    return HostedAccount.open(provider, username, password, {
      ...profile,
      privateKey: async () => profile.privateKey,
    });
  }

  async updatePreferences(edit: (data: AccountPreferences) => AccountPreferences) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { profile, envelope } = await this.read();
      const { revision } = envelope;
      const { privateKey, ...current } = profile;
      const updated = edit(current);
      if (updated === current || JSON.stringify(updated) === JSON.stringify(current)) {
        await this.cache(envelope);
        return current;
      }
      const encryptedData = await this.seal({ ...updated, privateKey }, revision + 1);
      try {
        await this.request("update", { encryptedData, revision });
        await this.cache({ encryptedData, revision: revision + 1 });
        return updated;
      } catch (error) {
        if (!(error instanceof ProviderError) || error.status !== 409 || attempt === 2) throw error;
      }
    }
    throw new Error("Could not sync account preferences.");
  }
}
