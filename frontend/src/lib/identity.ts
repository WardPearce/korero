import { call, nativeApp, requestError, type RelayResponse } from "./client";
import { browserIdentity, exportBrowserIdentity, importBrowserIdentity, signIdentity } from "./browser-identity";
import { browserSession } from "./browser-session";
import { preferences, type DeviceIdentity } from "./preferences";

export function getIdentity() {
  return preferences.identities.get("default");
}

async function saveIdentity(identity: DeviceIdentity, replace = false) {
  return preferences.transaction("rw", preferences.identities, async () => {
    const existing = await getIdentity();
    if (existing && !replace) {
      if (existing.publicKey !== identity.publicKey) {
        throw new Error("Confirm replacement of this device’s existing identity.");
      }
      return existing;
    }
    const record = { id: "default", ...identity } as const;
    await preferences.identities.put(record);
    return record;
  });
}

export async function loadIdentity() {
  const existing = await getIdentity();
  if (existing) return existing;
  if (!nativeApp()) return undefined;
  let legacy: DeviceIdentity | null;
  try {
    legacy = await call<DeviceIdentity | null>("legacy_identity");
  } catch (error) {
    // A fresh install may not have a system credential store available.
    if ((await preferences.local.get("identity"))?.value) throw error;
    return undefined;
  }
  return legacy ? saveIdentity(legacy) : undefined;
}

export async function generateIdentity() {
  return saveIdentity(await (nativeApp() ? call<DeviceIdentity>("generate_identity") : browserIdentity()));
}

export async function importIdentity(file: File, passphrase: string, replace = false) {
  if (file.size > 1024) throw new Error("Invalid Kōrero identity export.");
  const blob = await file.text();
  const identity = await (nativeApp() ? call<DeviceIdentity>("import_identity", { blob, passphrase }) : importBrowserIdentity(blob, passphrase));
  return saveIdentity(identity, replace);
}

async function requireIdentity() {
  const identity = await getIdentity();
  if (!identity) throw new Error("Generate or import an identity first.");
  return identity;
}

export async function exportIdentity(passphrase: string) {
  const { privateKey } = await requireIdentity();
  return nativeApp() ? call<string>("export_identity", { privateKey, passphrase }) : exportBrowserIdentity(privateKey, passphrase);
}

type IdentityAction =
  | { operation: "login"; password?: string }
  | { operation: "register"; displayName: string; invitation?: string; password?: string }
  | { operation: "bootstrap"; displayName: string; token: string };

export async function authenticateIdentity(origin: string, serverId: string, deviceName: string, action: IdentityAction) {
  const identity = await requireIdentity();
  if (nativeApp()) {
    return call<RelayResponse>("authenticate_identity", { origin, serverId, deviceName, privateKey: identity.privateKey, action });
  }
  const { operation, ...fields } = action;
  const { publicKey } = identity;
  const challenge = await browserSession.request(origin, "/api/v1/auth/identity/challenge", { origin, operation, deviceName, publicKey });
  if (challenge.status !== 200) throw identityError(challenge);
  const details = challenge.body as { id: string; origin: string; serverId: string; operation: string;
    publicKey: string; deviceName: string; binding: string; expiresAt: number };
  if (details.origin !== origin || details.serverId !== serverId || details.operation !== operation ||
      details.publicKey !== publicKey || details.deviceName !== deviceName || details.binding !== "") {
    throw new Error("The identity challenge does not match this server address or request.");
  }
  const id = details.id;
  const signature = await signIdentity(identity, ["korero-identity-v1", serverId, origin, operation, id, publicKey, "", deviceName, details.expiresAt]);
  switch (operation) {
    case "login": return browserSession.request(origin, "/api/v1/auth/identity/login", { id, signature, ...fields });
    case "register": return browserSession.request(origin, "/api/v1/auth/register", { identity: { id, signature }, deviceName, ...fields });
    case "bootstrap": return browserSession.request(origin, "/api/v1/admin/bootstrap", { identity: { id, signature }, deviceName, ...fields });
  }
}

export function identityError(result: RelayResponse) {
  return requestError({ value: result.body });
}
