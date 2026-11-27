import { preferences, type DeviceIdentity, type SavedServer } from "../preferences";
import { browserIdentity, importBrowserIdentity } from "./browser-identity";

export const identityModeKey = "korero:identity-mode";

export interface LocalProfile { identity: DeviceIdentity; username: string; servers: SavedServer[] }

export function rememberIdentityMode(mode: "local" | "hosted") {
  try { localStorage.setItem(identityModeKey, mode); } catch {}
}

export async function readLocalIdentity(): Promise<LocalProfile | undefined> {
  const [identity, name, servers] = await Promise.all([
    preferences.identities.get("default"),
    preferences.local.get("username"),
    preferences.servers.toArray(),
  ]);
  if (!identity || typeof name?.value !== "string" || !name.value) return;
  return { identity, username: name.value, servers };
}

export async function preparePrivateKey(file?: File, passphrase = "") {
  if (!file) return (await browserIdentity()).privateKey;
  if (file.size > 1024) throw new Error("Choose a valid Korero.chat identity backup.");
  return (await importBrowserIdentity(await file.text(), passphrase)).privateKey;
}

export async function saveLocalIdentity(name: string, loadIdentity: () => Promise<DeviceIdentity>,
  servers: SavedServer[] = []): Promise<LocalProfile> {
  const username = name.trim();
  const length = Array.from(username).length;
  if (length < 4 || length > 32 || /[\u0000-\u001f\u007f]/.test(username)) {
    throw new Error("Enter a username between 4 and 32 characters.");
  }
  const candidate = await loadIdentity();
  const identity = await preferences.transaction("rw", preferences.identities, preferences.local, preferences.servers, async () => {
    const existing = await preferences.identities.get("default");
    if (existing && existing.publicKey !== candidate.publicKey) throw new Error("This device already has a local identity.");
    await preferences.identities.put({ id: "default", ...candidate });
    await preferences.local.put({ key: "username", value: username });
    if (servers.length) await preferences.servers.bulkPut(servers);
    return candidate;
  });
  return { identity, username, servers: await preferences.servers.toArray() };
}
