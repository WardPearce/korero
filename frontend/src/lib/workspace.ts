import { createContext, type Snippet } from "svelte";
import type { DirectMessageChange, Member, MemberRequest, VoiceState } from "./connection/client";
import type { DeviceLink } from "./identity/device-link";
import type { VoicePresence } from "./media/voice-shortcuts";

export type MobilePane = "servers" | "channels" | "room";
export type RoomView = "chat" | "directMessages" | "channelSettings" | "serverSettings";
export type ChannelPlacement = "before" | "after" | "inside";

interface Workspace {
  readonly identity: { provider?: string; username: string; publicKey: string } | undefined;
  showAccountSetup(): void;
  createDeviceLink(): Promise<DeviceLink>;
  signOut(): Promise<boolean>;
  readonly view: VoiceState;
  /** The joined voice connection, which may belong to a server other than the focused one. */
  readonly activeVoice: { origin: string; view: VoiceState } | undefined;
  readonly serverOrigin: string;
  readonly serverId: string;
  readonly serverTitle: string;
  readonly bannerImageUrl: string | null;
  readonly canAdminister: boolean;
  readonly serverSettings: Snippet | undefined;
  readonly channelBackgrounds: boolean;
  readonly channelIcons: boolean;
  readonly profilePictures: boolean;
  avatarId(accountId: string): string | null | undefined;
  profilePicture(origin: string, accountId: string, avatarId?: string | null): Promise<string | undefined>;
  cacheProfilePicture(origin: string, accountId: string, avatarId: string | null, data: string | null): void;
  readonly maxAttachmentBytes: number;
  readonly richChat: boolean;
  readonly maxWebSocketBytes: number | undefined;
  readonly screenSharing: boolean;
  screenShareViewerTarget: HTMLElement | undefined;
  screenShareControlsTarget: HTMLElement | undefined;
  readonly channelAudioQuality: boolean;
  readonly channelWidth: number;
  readonly channelMax: number;
  resizeChannel(value: number, commit: boolean): void;
  readonly pending: string;
  actionError: string;
  selectedChannelId: string | null;
  mobilePane: MobilePane;
  roomView: RoomView;
  readonly directAccountId: string | null;
  readonly unreadDirectCounts: ReadonlyMap<string, number>;
  readonly unreadDirectCount: number;
  watchDirectChanges(connectionId: string, listener: (change: DirectMessageChange) => void): () => void;
  showDirectMessages(accountId?: string): void;
  showPoke(member: Pick<Member, "accountId" | "displayName">): void;
  showConnectionInfo(connectionId: string): void;
  showConnect(address?: string): void;
  showServerSettings(): void;
  run(action: string, command: string, args?: Record<string, unknown>): Promise<boolean>;
  /** Follows a channel's live chat on the focused server without joining it. Pass null to stop. */
  viewChannel(connectionId: string, channelId: string | null): void;
  canSetVoicePresence(field: VoicePresence): boolean;
  setVoicePresence(field: VoicePresence, value?: boolean, afkMessage?: string): Promise<boolean>;
  runAction(action: string, work: () => Promise<unknown>): Promise<boolean>;
  memberAction(request: MemberRequest): Promise<boolean>;
  memberVolume(accountId: string): number;
  setMemberVolume(accountId: string, level: number): Promise<boolean>;
  reorderChannel(channelId: string, targetId: string, placement: ChannelPlacement, parentId?: string | null): Promise<boolean>;
  disconnect(): Promise<boolean>;
}

export const [getWorkspace, setWorkspace] = createContext<Workspace>();
