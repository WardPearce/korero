import { serverOrigin, webTransport } from "./transport.js";
import type { Account, ServerInfo } from "./types.js";

type Query = Record<string, string | number | boolean | undefined>;
type QueryOptions<T extends Query> = { query: T };
type Requester = (request: Request) => Promise<Response>;
type Empty = Record<string, never>;

export type ApiResult<T> =
  | { data: T; error: null; status: number }
  | { data: null; error: { status: number; value: unknown }; status: number };

export type ChannelPermission = "join" | "speak" | "text" | "deleteChannels" | "mute" |
  "attachFiles" | "shareScreen" | "useCamera" | "whisper" | "pinMessages";
export type Permission = ChannelPermission | "createChannels" | "editChannels" | "move" | "kick" |
  "ban" | "manageRoles" | "manageInvitations" | "manageSettings" | "viewAdmin" | "sendDirectMessages" | "removeChannels";

export interface ChannelPermissionTable {
  editable: ChannelPermission[];
  roles: { name: string; permissions: Record<ChannelPermission, { allow: boolean | null; inherited: boolean }> }[];
}

export interface AccountPage {
  accounts: (Account & { editable: boolean; bannable: boolean; banned: boolean; bannedUntil?: number | null })[];
  next: string | null;
  roles: string[];
  builtInRoles: (RoleDefinition & { editable: boolean; defaultPermissions: Permission[] })[];
  customRoles: RoleDefinition[];
  assignablePermissions: Permission[];
  canDefineRoles: boolean;
  defaultRole: string;
  registrationPermissions: Permission[];
}

export interface RoleDefinition { name: string; permissions: Permission[] }

export interface AuditPage {
  events: {
    id: number;
    action: string;
    actorId: string | null;
    actorName: string | null;
    targetId: string | null;
    targetName: string | null;
    createdAt: number;
    details: Record<string, string | number | boolean | string[] | null> | null;
  }[];
  next: number | null;
}

export interface ServerPreferences {
  motd: string;
  defaultRole: string;
  canSetDefaultRole: boolean;
  defaultRoles: string[];
  defaultAudioBitrate: number | null;
  configuredAudioBitrate: number;
  audioBitrateLocked: boolean;
  maxAttachmentMiB: number;
  maxSupportedAttachmentMiB: number;
}

export interface Invitation {
  id: string;
  createdBy: string;
  expiresAt: number | null;
  usesLeft: number | null;
  revokedAt: number | null;
}

export interface ConnectionDetails {
  displayName: string;
  channelName: string | null;
  connectedSeconds: number;
  latencyMs: number | null;
}

export interface ServerCapabilities {
  protocolVersions: number[];
  websocketPath: string;
  audio: string;
  targetAudioBitrate: number;
  heartbeatSeconds: number;
  maxWebSocketBytes: number;
  udp: boolean;
  tcp: boolean;
  textPersistence: boolean;
}

export interface AttachmentUpload {
  connectionId: string;
  channelId: string;
  text: string;
  html?: string;
  name: string;
  data: string;
}

export interface ChannelOrder {
  channelId: string;
  targetId: string;
  placement: "before" | "after" | "inside";
  parentId?: string | null;
}

/** Typed v1 HTTP endpoints. The requester supplies credentials and any platform transport. */
export function createApi(origin: string, send: Requester = (request) => webTransport.fetch(request, { timeout: 8000 })) {
  async function request<T>(method: string, path: string, body?: unknown, query?: Query): Promise<ApiResult<T>> {
    const url = new URL("/api/v1/" + path, origin);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const response = await send(new Request(url, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
    const text = await response.text();
    let value: unknown = text;
    if (text) {
      try { value = JSON.parse(text); } catch {}
    } else value = null;
    const { status } = response;
    return response.ok ? { data: value as T, error: null, status } : { data: null, error: { status, value }, status };
  }

  const accountPicture = Object.assign(
    ({ accountId }: { accountId: string }) => ({
      get: () => request<{ avatarId: string | null; data: string | null }>("GET", "account/picture/" + encodeURIComponent(accountId)),
    }),
    { patch: (body: { data: string | null }) => request<{ avatarId: string | null }>("PATCH", "account/picture", body) },
  );
  const attachments = Object.assign(
    ({ messageId }: { messageId: string }) => ({
      get: ({ query }: QueryOptions<{ connectionId: string }>) =>
        request<{ data: string }>("GET", "chat/attachments/" + encodeURIComponent(messageId), undefined, query),
    }),
    { post: (body: AttachmentUpload) => request<{ messageId: string }>("POST", "chat/attachments", body) },
  );
  const channels = Object.assign(
    ({ id }: { id: string }) => {
      const path = "channels/" + encodeURIComponent(id) + "/permissions";
      return { permissions: {
        get: () => request<ChannelPermissionTable>("GET", path),
        patch: (body: { changes: { role: string; permission: ChannelPermission; allow: boolean | null }[] }) =>
          request<ChannelPermissionTable>("PATCH", path, body),
      } };
    },
    { order: { patch: (body: ChannelOrder) => request<Empty>("PATCH", "channels/order", body) } },
  );
  const invitations = Object.assign(
    ({ id }: { id: string }) => {
      const path = "admin/invitations/" + encodeURIComponent(id);
      return {
        patch: (body: { expiresAt?: number | null; usesLeft?: number | null }) => request<Invitation>("PATCH", path, body),
        delete: () => request<Empty>("DELETE", path),
      };
    },
    {
      get: () => request<{ invitations: Invitation[] }>("GET", "admin/invitations"),
      post: (body: { expiresAt?: number; expiresInSeconds?: number; uses?: number }) =>
        request<Pick<Invitation, "id" | "expiresAt" | "usesLeft"> & { token: string }>("POST", "admin/invitations", body),
    },
  );

  return {
    server: {
      info: { get: () => request<ServerInfo>("GET", "server/info") },
      capabilities: { get: () => request<ServerCapabilities>("GET", "server/capabilities") },
    },
    account: {
      get: () => request<Account>("GET", "account"),
      patch: (body: { displayName: string }) => request<Account>("PATCH", "account", body),
      picture: accountPicture,
      sessions: Object.assign(
        ({ id }: { id: string }) => ({ delete: () => request<Empty>("DELETE", "account/sessions/" + encodeURIComponent(id)) }),
        { get: () => request<{ id: string; deviceName: string; createdAt: number; lastActive: number; expiresAt: number }[]>("GET", "account/sessions") },
      ),
    },
    connections: ({ id }: { id: string }) => ({
      get: () => request<ConnectionDetails>("GET", "connections/" + encodeURIComponent(id)),
    }),
    channels,
    chat: { attachments },
    admin: {
      accounts: {
        get: (options?: QueryOptions<{ after?: string }>) => request<AccountPage>("GET", "admin/accounts", undefined, options?.query),
        roles: {
          post: (body: { accountId: string; role: string }) => request<{ roles: string[] }>("POST", "admin/accounts/roles", body),
          delete: (body: { accountId: string; role: string }) => request<{ roles: string[] }>("DELETE", "admin/accounts/roles", body),
        },
      },
      badges: { patch: (body: { accountId: string; badge: string | null }) => request<{ badge: string | null }>("PATCH", "admin/badges", body) },
      roles: {
        post: (body: RoleDefinition) => request<RoleDefinition>("POST", "admin/roles", body),
        definition: {
          patch: (body: RoleDefinition) => request<RoleDefinition>("PATCH", "admin/roles/definition", body),
          delete: (body: { name: string }) => request<Empty>("DELETE", "admin/roles/definition", body),
        },
      },
      audit: { get: (options?: QueryOptions<{ before?: number; prefix?: string; actorId?: string }>) =>
        request<AuditPage>("GET", "admin/audit", undefined, options?.query) },
      preferences: {
        get: () => request<ServerPreferences>("GET", "admin/preferences"),
        patch: (body: Partial<Pick<ServerPreferences, "motd" | "defaultRole" | "defaultAudioBitrate" | "maxAttachmentMiB">>) =>
          request<ServerPreferences>("PATCH", "admin/preferences", body),
      },
      banner: { patch: (body: { bannerImageUrl: string | null }) => request<typeof body>("PATCH", "admin/banner", body) },
      invitations,
      password: {
        get: () => request<{ passwordRequired: boolean; passwordLocked: boolean }>("GET", "admin/password"),
        patch: (body: { password: string | null }) => request<{ passwordRequired: boolean }>("PATCH", "admin/password", body),
      },
    },
  };
}

/** Public server information is available before signing in. */
export function serverApi(address: string) {
  return createApi(serverOrigin(address)).server;
}
