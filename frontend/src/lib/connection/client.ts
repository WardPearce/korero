import { treaty } from "@elysia/eden";
import type { App } from "../../../../backend/src/app";
import { browserSessions } from "./browser-session";
import { call, desktopApp, watchDesktop } from "./platform";

export { call, desktopApp } from "./platform";

export interface Account {
  id: string;
  displayName: string;
  role: string;
  badge?: string | null;
  avatarId?: string | null;
}

export interface Channel {
  id: string;
  name: string;
  description: string;
  parentId: string | null;
  capacity: number | null;
  temporary: boolean;
  passwordRequired: boolean;
  backgroundImageUrl?: string | null;
  icon?: string | null;
  canEdit?: boolean;
  canDelete?: boolean;
  /** The account may delete other members' messages in this channel. */
  canDeleteMessages?: boolean;
  canReparent?: boolean;
  canSetPassword?: boolean;
  canMute?: boolean;
  canMove?: boolean;
  /** The account may set per-role permission overrides for this channel. */
  canManagePermissions?: boolean;
  canWhisperTo?: boolean;
  audioBitrate?: number | null;
  canSetAudioBitrate?: boolean;
}

export interface Member {
  connectionId: string;
  accountId: string;
  displayName: string;
  muted: boolean;
  deafened: boolean;
  afk?: boolean;
  afkMessage?: string;
  adminMuted: boolean;
  adminDeafened?: boolean;
  role?: string;
  badge?: string | null;
  speaking?: boolean;
}

export interface Snapshot {
  connectionId: string;
  account: Account;
  channelId: string | null;
  totalUsers?: number;
  channels: Channel[];
  presence: { accountId: string; displayName: string; connections: number; avatarId?: string | null }[];
  members: Member[];
  channelMembers?: Record<string, Member[]>;
  serverPermissions: string[];
  lowerRoles?: string[];
  assignableRoles?: string[];
  bannerImageUrl?: string | null;
  motd?: string;
  targetAudioBitrate?: number;
  maxAttachmentBytes?: number;
  canReorderChannels?: boolean;
  canSendText?: boolean;
  canAttachFiles?: boolean;
  directMessages?: { maxBytes: number; persistent: boolean; offlineDelivery?: boolean; canSend?: boolean };
  pokeMaxLength?: number;
  canShareScreen?: boolean;
  canUseCamera?: boolean;
  whispers?: { producerId: string; from: string }[];
  screens?: ScreenShare[];
  cameras?: ScreenShare[];
}

export interface ScreenShare {
  producerId: string;
  connectionId: string;
  audioProducerId?: string;
  screenNumber?: number;
}

export type MemberRequest =
  | { kind: "channel.move"; payload: { channelId: string } & ({ connectionId: string } | { connectionIds: string[] }) }
  | { kind: "moderation.mute"; payload: { connectionId: string; muted: boolean } }
  | { kind: "moderation.deafen"; payload: { connectionId: string; deafened: boolean } }
  | { kind: "moderation.kick" | "moderation.ban" | "moderation.unban"; payload: { accountId: string } }
  | { kind: "role.set"; payload: { accountId: string; role: string } };

export interface Message {
  id: string;
  channelId: string | null;
  senderId: string;
  createdAt: number;
  text: string;
  html?: string;
  editedAt?: number | null;
  attachment?: { name: string; size: number };
}

export interface DirectMessageReference {
  id: string;
  senderId: string;
  recipientId: string;
}

export interface DirectMessage extends DirectMessageReference {
  createdAt: number;
  /** Set when the sender replaced the ciphertext after sending. */
  editedAt?: number | null;
  nonce: string;
  ciphertext: string;
  signature: string;
  /** Present on packets queued while the recipient was offline. */
  senderName?: string;
}

export type DirectMessageChange =
  | { type: "edit"; message: DirectMessage }
  | { type: "delete"; message: DirectMessageReference };

export function isSameDirectMessage(a: DirectMessageReference, b: DirectMessageReference) {
  return a.id === b.id && a.senderId === b.senderId && a.recipientId === b.recipientId;
}

export interface Poke {
  id: string;
  senderId: string;
  senderName: string;
  recipientId: string;
  message?: string;
}

export type DirectOperation = "direct.peer" | "direct.inbox" | "direct.history" | "direct.send" | "direct.edit" | "direct.delete" | "direct.poke";

export interface VoiceState {
  /** Server origin of the desktop session that produced this state. */
  origin?: string;
  phase: "offline" | "connecting" | "online" | "reconnecting" | "error";
  snapshot: Snapshot | null;
  messages: Message[];
  directMessages?: DirectMessage[];
  /** A live change to apply to any history the client has already loaded. */
  directChange?: DirectMessageChange;
  lastPoke?: Poke | null;
  speaking: string[];
  voice: "idle" | "active" | "muted" | "deafened" | "error";
  voiceError: string | null;
  whisperChannelId?: string | null;
  error: string | null;
}

export interface ServerInfo {
  name: string;
  serverId: string;
  identityAuthentication?: boolean;
  identityEnrollment?: boolean;
  channelBackgrounds?: boolean;
  channelIcons?: boolean;
  profilePictures?: boolean;
  maxAttachmentBytes?: number;
  richChat?: boolean;
  maxWebSocketBytes?: number;
  screenSharing?: boolean;
  channelAudioQuality?: boolean;
  serverAdministration?: boolean;
  extendedServerAdministration?: boolean;
  passwordRequired?: boolean;
  invitationPasswordBypass?: boolean;
  bannerImageUrl?: string | null;
  registration: "open" | "invitation" | "admin" | "disabled";
  setupRequired: boolean;
  version: string;
}

export interface RelayResponse {
  status: number;
  body: unknown;
}

export const offline: VoiceState = {
  phase: "offline",
  snapshot: null,
  messages: [],
  speaking: [],
  voice: "idle",
  voiceError: null,
  error: null,
};

export function directRequest<T>(connectionId: string, kind: DirectOperation, payload: unknown = {}) {
  return desktopApp()
    ? call<T>("direct_request", { connectionId, kind, payload })
    : browserSessions.directRequest<T>(connectionId, kind, payload);
}

/** Starts the signed-in session for a server prepared with `browserSessions.select` or `prepare_server`. */
export function startSession(origin: string, memberVolumes: Record<string, number>) {
  return desktopApp() ? call("start_session", { origin }) : browserSessions.session(origin).start(memberVolumes);
}

export type DesktopSessionState = Omit<VoiceState, "voice" | "voiceError" | "whisperChannelId">;

export function watchDesktopSession(onState: (state: DesktopSessionState) => void) {
  return watchDesktop<DesktopSessionState>("korero:state", onState);
}

export function apiFor(origin: string) {
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (!desktopApp()) return browserSessions.fetch(request);
    const url = new URL(request.url);
    const body = request.body ? (await request.json() as unknown) : null;
    const result = await call<RelayResponse>("api_fetch", {
      origin: url.origin,
      method: request.method,
      path: url.pathname + url.search,
      body,
    });
    if ([204, 205, 304].includes(result.status)) {
      return new Response(null, { status: result.status });
    }
    return Response.json(result.body, { status: result.status });
  };
  // Eden takes the Bun-augmented fetch type. The relay only needs HTTP requests.
  return treaty<App>(origin, { fetcher: fetcher as typeof fetch }).api.v1;
}

export function messageFrom(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return "The request could not be completed.";
}

export function requestError(error: unknown): Error {
  if (error && typeof error === "object" && "value" in error) {
    const value = error.value;
    if (value && typeof value === "object" && "error" in value) {
      return new Error(messageFrom(value.error));
    }
    return new Error(messageFrom(value));
  }
  return new Error(messageFrom(error));
}

export function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((word) => Array.from(word)[0]).join("").toUpperCase();
}

export function shortHost(origin: string) {
  return origin.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

export const messageTime = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});
