export interface Account {
  id: string;
  displayName: string;
  /** The highest-ranked held role, used for display. */
  role: string;
  /** Every held role, highest rank first. Servers without multiple roles omit it. */
  roles?: string[];
  badge?: string | null;
  avatarId?: string | null;
}

export interface ChannelData {
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
  /** The server supports pins in this channel. */
  messagePins?: boolean;
  /** The server can search this channel's stored messages with `message.search`. */
  messageSearch?: boolean;
  canPinMessages?: boolean;
  /** The server stores reactions on this channel's messages. */
  messageReactions?: boolean;
  /**
   * The account may read and send this channel's messages, even without joining it.
   * Servers that predate outside chat omit this; chat then needs membership.
   */
  canChat?: boolean;
  canAttachFiles?: boolean;
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
  roles?: string[];
  badge?: string | null;
  speaking?: boolean;
}

export interface Snapshot {
  connectionId: string;
  account: Account;
  channelId: string | null;
  totalUsers?: number;
  channels: ChannelData[];
  presence: { accountId: string; displayName: string; connections: number; avatarId?: string | null }[];
  members: Member[];
  channelMembers?: Record<string, Member[]>;
  serverPermissions: string[];
  lowerRoles?: string[];
  assignableRoles?: string[];
  /** Sent to role managers. Changes whenever any account's roles change. */
  accountsRevision?: number;
  bannerImageUrl?: string | null;
  motd?: string;
  targetAudioBitrate?: number;
  maxAttachmentBytes?: number;
  canReorderChannels?: boolean;
  /** Roles that messages may mention. */
  mentionableRoles?: string[];
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
  | { kind: "moderation.ban"; payload: { accountId: string; expiresInSeconds?: number } }
  | { kind: "moderation.kick" | "moderation.unban"; payload: { accountId: string } }
  | { kind: "role.add" | "role.remove"; payload: { accountId: string; role: string } };

export interface Message {
  id: string;
  channelId: string | null;
  recipientId?: string | null;
  senderId: string;
  senderName?: string;
  createdAt: number;
  text: string;
  html?: string;
  editedAt?: number | null;
  pinnedAt?: number | null;
  attachment?: { name: string; size: number };
  /** The message this one answers. `missing` once the original is deleted or expires. */
  replyTo?: ReplyPreview | { id: string; missing: true };
  mentions?: MessageMentions;
  /** Present only on stored messages with reactions; `me` reflects the reading account. */
  reactions?: MessageReaction[];
}

export interface ReplyPreview {
  id: string;
  senderId: string;
  senderName: string;
  /** Up to 120 characters of the original text. */
  text: string;
  attachmentName?: string;
}

export interface MessageMentions {
  accounts: string[];
  roles: string[];
}

export interface MessageReaction {
  emoji: string;
  count: number;
  me: boolean;
}

/** Sent to each mentioned reader, including those not following the channel. */
export interface MessageMention {
  channelId: string;
  messageId: string;
  senderId: string;
  senderName: string;
  text: string;
}

export interface ReactionChange {
  channelId: string;
  messageId: string;
  emoji: string;
  count: number;
  accountId: string;
  reacted: boolean;
}

export interface PinCursor {
  id: string;
  pinnedAt: number;
}

export interface PinnedMessagePage {
  messages: (PinCursor & Pick<Message, "senderId" | "senderName" | "createdAt" | "text"> & { attachmentName: string | null })[];
  next: PinCursor | null;
}

export interface SearchCursor {
  id: string;
  createdAt: number;
}

export interface MessageSearchPage {
  /** `text` is a preview of up to 240 characters around the first match, with "…" where it was cut. */
  messages: (SearchCursor & Pick<Message, "senderId" | "senderName" | "text"> & { attachmentName: string | null })[];
  next: SearchCursor | null;
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
  /** Changes when a channel's stored messages are edited, deleted, pinned or unpinned. */
  messageRevisions?: Record<string, number>;
  directMessages?: DirectMessage[];
  /** A live change to apply to any history the client has already loaded. */
  directChange?: DirectMessageChange;
  lastPoke?: Poke | null;
  /** The latest message that mentioned this account or one of its roles. */
  lastMention?: MessageMention | null;
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

