import { call, desktopApp, requestError, type RelayResponse } from "../connection/client";
import { exportBrowserIdentity, signIdentity } from "./browser-identity";
import { browserSession } from "../connection/browser-session";
import type { DeviceIdentity } from "../preferences";

let activeIdentity: DeviceIdentity | undefined;
export function getIdentity() {
  return activeIdentity;
}

export function setIdentity(identity?: DeviceIdentity) {
  activeIdentity = identity;
}

function requireIdentity() {
  const identity = getIdentity();
  if (!identity) throw new Error("Sign in to your Korero.chat account first.");
  return identity;
}

export async function exportIdentity(passphrase: string) {
  const { privateKey } = requireIdentity();
  return desktopApp() ? call<string>("export_identity", { privateKey, passphrase }) : exportBrowserIdentity(privateKey, passphrase);
}

type IdentityAction =
  | { operation: "login"; password?: string }
  | { operation: "register"; displayName: string; invitation?: string; password?: string }
  | { operation: "bootstrap"; displayName: string; token: string; password?: string };

export async function authenticateIdentity(origin: string, serverId: string, deviceName: string, action: IdentityAction) {
  const identity = requireIdentity();
  if (desktopApp()) {
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
