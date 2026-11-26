import { createContext, type Snippet } from "svelte";
import type { MemberRequest, VoiceState } from "./client";

export type MobilePane = "servers" | "channels" | "room";
export type RoomView = "chat" | "channelSettings" | "serverSettings";

interface Workspace {
  readonly view: VoiceState;
  readonly serverOrigin: string;
  readonly serverTitle: string;
  readonly bannerImageUrl: string | null;
  readonly canAdminister: boolean;
  readonly serverSettings: Snippet | undefined;
  readonly channelBackgrounds: boolean;
  readonly channelWidth: number;
  readonly channelMax: number;
  resizeChannel(value: number, commit: boolean): void;
  readonly pending: string;
  actionError: string;
  selectedChannelId: string | null;
  mobilePane: MobilePane;
  roomView: RoomView;
  showConnect(address?: string): void;
  showServerSettings(): void;
  run(action: string, command: string, args?: Record<string, unknown>): Promise<boolean>;
  memberAction(request: MemberRequest): Promise<boolean>;
  memberVolume(accountId: string): number;
  setMemberVolume(accountId: string, level: number): Promise<boolean>;
  reorderChannel(channelId: string, targetId: string, placement: "before" | "after"): Promise<boolean>;
  disconnect(): Promise<boolean>;
}

export const [getWorkspace, setWorkspace] = createContext<Workspace>();
