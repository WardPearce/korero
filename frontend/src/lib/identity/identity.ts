import { call, desktopApp, requestError, type RelayResponse } from "../connection/client";
import { exportBrowserIdentity } from "./browser-identity";
import { browserSessions } from "../connection/browser-session";
import type { DeviceIdentity, IdentityAction } from "korero-chat/source";

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

export async function authenticateIdentity(origin: string, serverId: string, deviceName: string, action: IdentityAction) {
  const identity = requireIdentity();
  if (desktopApp()) {
    return call<RelayResponse>("authenticate_identity", { origin, serverId, deviceName, privateKey: identity.privateKey, action });
  }
  return browserSessions.session(origin).authenticate({ serverId, deviceName, action, identity });
}

export function identityError(result: RelayResponse) {
  return requestError({ value: result.body });
}
