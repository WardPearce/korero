import { createContext, type Snippet } from "svelte";
import type { Member, MemberRequest, VoiceState } from "./connection/client";

export type MobilePane = "servers" | "channels" | "room";
export type RoomView = "chat" | "directMessages" | "channelSettings" | "serverSettings";
export type ChannelPlacement = "before" | "after" | "inside";

interface Workspace {
  readonly identity: { provider?: string; username: string; publicKey: string } | undefined;
  showAccountSetup(): void;
  signOut(): Promise<boolean>;
  readonly view: VoiceState;
  readonly serverOrigin: string;
  readonly serverId: string;
  readonly serverTitle: string;
  readonly bannerImageUrl: string | null;
  readonly canAdminister: boolean;
  readonly serverSettings: Snippet | undefined;
  readonly channelBackgrounds: boolean;
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
  readonly unreadDirectAccounts: ReadonlySet<string>;
  showDirectMessages(accountId?: string): void;
  showPoke(member: Pick<Member, "accountId" | "displayName">): void;
  showConnectionInfo(connectionId: string): void;
  showConnect(address?: string): void;
  showServerSettings(): void;
  run(action: string, command: string, args?: Record<string, unknown>): Promise<boolean>;
  runAction(action: string, work: () => Promise<unknown>): Promise<boolean>;
  memberAction(request: MemberRequest): Promise<boolean>;
  memberVolume(accountId: string): number;
  setMemberVolume(accountId: string, level: number): Promise<boolean>;
  reorderChannel(channelId: string, targetId: string, placement: ChannelPlacement, parentId?: string | null): Promise<boolean>;
  disconnect(): Promise<boolean>;
}

export const [getWorkspace, setWorkspace] = createContext<Workspace>();
