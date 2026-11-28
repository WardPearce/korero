import { requestError } from "./errors.js";
import { signIdentity, type DeviceIdentity } from "./identity.js";
import type { RelayResponse } from "./types.js";

export type IdentityAction =
  | { operation: "login"; password?: string }
  | { operation: "register"; displayName: string; invitation?: string; password?: string }
  | { operation: "bootstrap"; displayName: string; token: string; password?: string };

export interface IdentityAuthentication {
  serverId: string;
  deviceName: string;
  action: IdentityAction;
  identity: DeviceIdentity;
}

export async function authenticateIdentity(
  request: (path: string, body: unknown) => Promise<RelayResponse>,
  origin: string,
  { serverId, deviceName, action, identity }: IdentityAuthentication,
) {
  const { operation, ...fields } = action;
  const { publicKey } = identity;
  const challenge = await request("/api/v1/auth/identity/challenge", { origin, operation, deviceName, publicKey });
  if (challenge.status !== 200) throw requestError({ value: challenge.body });
  const details = challenge.body as {
    id: string; origin: string; serverId: string; operation: string;
    publicKey: string; deviceName: string; binding: string; expiresAt: number;
  } | null;
  if (!details || details.origin !== origin || details.serverId !== serverId || details.operation !== operation ||
      details.publicKey !== publicKey || details.deviceName !== deviceName || details.binding !== "" ||
      typeof details.id !== "string" || !Number.isFinite(details.expiresAt)) {
    throw new Error("The identity challenge does not match this server address or request.");
  }
  const id = details.id;
  const signature = await signIdentity(identity, ["korero-identity-v1", serverId, origin, operation, id, publicKey, "", deviceName, details.expiresAt]);
  switch (operation) {
    case "login": return request("/api/v1/auth/identity/login", { id, signature, ...fields });
    case "register": return request("/api/v1/auth/register", { identity: { id, signature }, deviceName, ...fields });
    case "bootstrap": return request("/api/v1/admin/bootstrap", { identity: { id, signature }, deviceName, ...fields });
  }
}
